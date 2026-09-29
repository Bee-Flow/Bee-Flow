/**
 * Memory embedding backfill — brings `user_memories` onto the pgvector columns
 * and keeps them on the dimension the ACTIVE embedding provider produces.
 *
 * ── Why this job exists ──────────────────────────────────────────────────────
 * Vectors used to live in a JSONB column compared by a JS cosine loop, and
 * `cosineSimilarity` returns 0 for mismatched dimensions. So switching
 * embedding provider did not degrade recall — it silently made every memory
 * written under the old provider unreachable, with nothing anywhere reporting
 * it. On the box this was written on that was 15 of 97 rows.
 *
 * This job makes that state recoverable and temporary rather than permanent.
 *
 * ── Three phases, cheapest first ─────────────────────────────────────────────
 *   1. LEXICAL   — fill `search_vector` for rows that have none. Pure SQL, no
 *                  provider, no metered spend. Runs even when embedding is
 *                  completely unavailable, because it is what keeps those rows
 *                  findable at all.
 *   2. ADOPT     — a row whose legacy JSONB vector is ALREADY in the active
 *                  dimension does not need re-embedding; its vector is copied
 *                  into the typed column with a cast. Also pure SQL. This is
 *                  the phase that handles the ordinary upgrade: nobody pays a
 *                  provider to re-encode text that never changed.
 *   3. RE-EMBED  — only rows with no usable vector in the active dimension.
 *                  This is the one that costs money, so it is bounded by batch
 *                  size, run time, and a per-row attempt ceiling.
 *
 * ── Guards ───────────────────────────────────────────────────────────────────
 * `pg_try_advisory_lock` — concurrent replicas would each re-embed the same
 * rows and duplicate metered spend. Unlike an idempotent UPDATE sweep, paying
 * twice is not recoverable.
 *
 * `MAX_RUN_MS` — one tenant with a large backlog must not hold the lock past
 * the next tick.
 *
 * `MAX_EMBED_ATTEMPTS` — a row the provider will never accept (too long, bad
 * encoding) would otherwise be retried on every pass forever.
 */

const { pool, run, getAll, getOne } = require('../db');
const memoryStore = require('../stores/memoryStore');
const { validateDim, vectorColumn, tsvectorExpr } = require('../stores/memoryVectors');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

// Namespaced so it cannot collide with another job's advisory lock.
const LOCK_KEY = 887401;

const INTERVAL_MS = Number(process.env.MEMORY_BACKFILL_INTERVAL_MS) || 15 * 60 * 1000;
const MAX_RUN_MS = Number(process.env.MEMORY_BACKFILL_MAX_RUN_MS) || 4 * 60 * 1000;
const EMBED_BATCH = Number(process.env.MEMORY_BACKFILL_BATCH) || 25;
const LEXICAL_BATCH = 500;
const MAX_EMBED_ATTEMPTS = 5;

// Past this many active rows an exact scan stops being the right answer and an
// ANN index earns its keep. Deliberately high: below it, exact `<=>` behind the
// user_id btree is sub-millisecond AND correct, whereas an ANN index applies
// the user filter after the scan and can drop the best row. See
// memoryStore.ensureVectorColumn.
const ANN_INDEX_THRESHOLD = 50_000;

let _timer = null;
let _inFlight = false;

/**
 * Ask the active provider what dimension it is producing right now.
 *
 * Probed per run rather than configured, because the answer changes when an
 * admin switches provider and nothing notifies this job. A failure here means
 * no embedding tier is reachable, so phases 2 and 3 are skipped and only the
 * lexical phase runs.
 */
async function probeActiveDim() {
    const probe = await memoryStore.embedOne('dimension probe', { kind: 'passage' });
    if (!probe || !validateDim(probe.dim)) return null;
    return probe.dim;
}

/** Phase 1 — fill missing tsvectors. No provider involved. */
async function fillLexical(deadline) {
    let filled = 0;
    while (Date.now() < deadline) {
        const { rowCount } = await run(
            `UPDATE user_memories
                SET search_vector = ${tsvectorExpr('content')}
              WHERE id IN (
                    SELECT id FROM user_memories
                     WHERE search_vector IS NULL AND content IS NOT NULL
                     LIMIT ${LEXICAL_BATCH}
              )`,
        );
        const n = rowCount || 0;
        filled += n;
        if (n < LEXICAL_BATCH) break;
    }
    return filled;
}

/**
 * Phase 2 — adopt legacy JSONB vectors that are already the right dimension.
 *
 * `embedding::text::vector` works because a JSONB number array renders in
 * exactly the literal form pgvector parses. Rows adopted here cost nothing and
 * are indistinguishable afterwards from freshly embedded ones.
 */
async function adoptExisting(dim, deadline) {
    const col = vectorColumn(dim);
    if (!col) return 0;
    let adopted = 0;
    while (Date.now() < deadline) {
        const { rowCount } = await run(
            `UPDATE user_memories
                SET "${col}" = embedding::text::vector(${dim}), embedding_dim = ${dim}, embed_failed_at = NULL
              WHERE id IN (
                    SELECT id FROM user_memories
                     WHERE embedding IS NOT NULL
                       AND "${col}" IS NULL
                       AND jsonb_typeof(embedding) = 'array'
                       AND jsonb_array_length(embedding) = ${dim}
                     LIMIT ${LEXICAL_BATCH}
              )`,
        );
        const n = rowCount || 0;
        adopted += n;
        if (n < LEXICAL_BATCH) break;
    }
    return adopted;
}

/**
 * Phase 3 — re-embed rows that have no vector in the active dimension.
 *
 * These are the genuinely stranded rows: written under a provider that is no
 * longer configured. Everything else was handled for free above.
 */
async function reembedStale(dim, deadline) {
    const col = vectorColumn(dim);
    if (!col) return { embedded: 0, failed: 0 };
    let embedded = 0;
    let failed = 0;

    while (Date.now() < deadline) {
        const rows = await getAll(
            `SELECT id, content FROM user_memories
              WHERE "${col}" IS NULL
                AND content IS NOT NULL
                AND status <> 'deleted'
                AND COALESCE(embed_attempts, 0) < ${MAX_EMBED_ATTEMPTS}
              ORDER BY importance DESC NULLS LAST, updated_at DESC
              LIMIT ${EMBED_BATCH}`,
        );
        if (!rows || rows.length === 0) break;

        for (const row of rows) {
            if (Date.now() >= deadline) break;
            // indexMemory bumps embed_attempts itself, so a row that keeps
            // failing walks up to the ceiling and drops out of this query
            // instead of being retried every 15 minutes forever.
            const result = await memoryStore.indexMemory(row.id, row.content);
            if (result?.ok) embedded++; else failed++;
        }

        // Every row in the batch failed and none advanced — the provider is
        // down rather than the rows being bad. Stop, and let the next tick try.
        if (embedded === 0 && failed >= rows.length) break;
    }

    return { embedded, failed };
}

/**
 * Create an ANN index once exact search stops being viable.
 *
 * On its own client: `db.js` serialises DDL through a schema queue, and
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
 */
async function maybeCreateAnnIndex(dim) {
    const col = vectorColumn(dim);
    if (!col) return false;
    const row = await getOne(`SELECT count(*)::int AS n FROM user_memories WHERE status = 'active'`);
    if (!row || row.n < ANN_INDEX_THRESHOLD) return false;

    const idxName = `idx_memories_vec_${dim}`;
    const exists = await getOne(`SELECT 1 AS x FROM pg_class WHERE relname = $1`, [idxName]);
    if (exists) return false;

    const client = await pool.connect();
    try {
        log.info(`[MemoryBackfill] ${row.n} active rows — building ${idxName} CONCURRENTLY`);
        await client.query(
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idxName} `
            + `ON user_memories USING hnsw ("${col}" vector_cosine_ops)`,
        );
        return true;
    } catch (e) {
        log.warn(`[MemoryBackfill] ${idxName} build failed:`, e.message);
        return false;
    } finally {
        client.release();
    }
}

/** Counts for the admin health view — and for knowing when this job is done. */
async function getBackfillStatus() {
    const dim = await probeActiveDim();
    const col = dim ? vectorColumn(dim) : null;
    const base = await getOne(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE search_vector IS NOT NULL)::int AS lexical,
                count(*) FILTER (WHERE embed_failed_at IS NOT NULL
                                   AND COALESCE(embed_attempts, 0) >= ${MAX_EMBED_ATTEMPTS})::int AS stuck
           FROM user_memories WHERE status = 'active'`,
    );
    let embedded = 0;
    if (col) {
        try {
            const r = await getOne(
                `SELECT count(*) FILTER (WHERE "${col}" IS NOT NULL)::int AS n
                   FROM user_memories WHERE status = 'active'`,
            );
            embedded = r?.n || 0;
        } catch (_) { /* column not created yet */ }
    }
    return {
        activeDim: dim,
        total: base?.total || 0,
        embedded,
        lexical: base?.lexical || 0,
        stuck: base?.stuck || 0,
        complete: (base?.total || 0) > 0 && embedded + (base?.stuck || 0) >= (base?.total || 0),
    };
}

async function runOnce({ dryRun = false } = {}) {
    if (_inFlight) return null;
    _inFlight = true;
    let client = null;
    let acquired = false;
    const t0 = Date.now();
    const deadline = t0 + MAX_RUN_MS;
    let ok = true;
    const summary = { lexical: 0, adopted: 0, embedded: 0, failed: 0, dim: null };

    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return null; // another replica owns this tick

        if (dryRun) return { ...await getBackfillStatus(), dryRun: true };

        summary.lexical = await fillLexical(deadline);

        const dim = await probeActiveDim();
        summary.dim = dim;
        if (!dim) {
            log.warn('[MemoryBackfill] no embedding provider reachable — lexical phase only');
        } else if (memoryStore.isPgvectorAvailable()) {
            await memoryStore.ensureVectorColumn(dim);
            summary.adopted = await adoptExisting(dim, deadline);
            const r = await reembedStale(dim, deadline);
            summary.embedded = r.embedded;
            summary.failed = r.failed;
            await maybeCreateAnnIndex(dim);
        }

        if (summary.lexical || summary.adopted || summary.embedded || summary.failed) {
            log.info(
                `[MemoryBackfill] dim=${dim} lexical=${summary.lexical} adopted=${summary.adopted} `
                + `embedded=${summary.embedded} failed=${summary.failed} in ${Date.now() - t0} ms`,
            );
        }
        return summary;
    } catch (e) {
        ok = false;
        log.warn('[MemoryBackfill] pass error:', e.message);
        return summary;
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); }
            catch (_) { /* best-effort */ }
            client.release();
        }
        if (acquired) recordJobRun({ job: 'memory_embedding_backfill', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
        _inFlight = false;
    }
}

function start() {
    if (_timer) return;
    // First pass 90 s after boot: late enough that initDB has created the
    // columns, early enough that an upgrade heals within the first coffee.
    const initial = setTimeout(() => runOnce().catch(e =>
        log.warn('[MemoryBackfill] initial pass failed:', e.message)), 90 * 1000);
    if (initial.unref) initial.unref();

    _timer = setInterval(() => {
        runOnce().catch(e => log.warn('[MemoryBackfill] scheduled pass failed:', e.message));
    }, INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    log.info(`[MemoryBackfill] Started — interval ${Math.round(INTERVAL_MS / 60000)} min`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
    start, stop, runOnce, getBackfillStatus,
    // exported for tests
    fillLexical, adoptExisting, reembedStale, probeActiveDim,
    ANN_INDEX_THRESHOLD, MAX_EMBED_ATTEMPTS,
};
