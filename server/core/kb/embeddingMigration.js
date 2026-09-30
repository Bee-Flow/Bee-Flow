'use strict';
/**
 * Keeps the stored knowledge-base vectors in the space of the CONFIGURED
 * embedding model.
 *
 * Every local knowledge base shares one column, `kb_chunks.embedding`, with
 * one fixed dimension. Switching the model in Admin ▸ AI Config ▸ Embeddings
 * used to leave that column as it was: a new model with another dimension
 * failed every upload ("expected 768 dimensions, not 1024"), and one with the
 * same dimension silently searched old vectors with new queries. Nothing
 * told the admin that the switch needed a manual re-index and an ALTER.
 *
 * Now a switch re-embeds what is stored, by itself:
 *
 *   1. The model whose vectors are in the column is remembered as a
 *      fingerprint (`kb_embedding_fingerprint`: provider id + model id).
 *   2. When the configured model differs, every chunk is embedded again
 *      from `kb_chunks.content` into a side column of the new dimension,
 *      batch by batch, and the columns are swapped in one transaction.
 *      That text is exactly what was embedded the first time — the Privacy
 *      Shield ran before it was stored (core/kb/ingestPrivacy.js) — so the
 *      new provider receives nothing a fresh upload would not send it.
 *   3. Documents that failed on the mismatch are retried through their
 *      source, the same engine as "Refresh now".
 *
 * While it runs, search keeps working on keywords: a query vector of the
 * new dimension fails against the old column, and searchLocally already
 * falls back to full-text for that.
 *
 * ── ONLY THE CONFIGURED MODEL, NEVER A FALLBACK ─────────────────────
 * The ordinary dispatcher falls through to Azure or the CPU embedder when
 * the provider fails. Letting that decide the target would turn one Mistral
 * outage into re-embedding every knowledge base at 384 dimensions. The
 * target is the configured model, and every call here is `strict`: a failure
 * stops the migration, keeps the old column, and the next trigger resumes
 * from the rows already done.
 *
 * ── WHEN IT RUNS ────────────────────────────────────────────────────
 * On saving an embedding model (routes/ai/config/instanceConfig.js), at boot
 * (a switch made while the server was down), and before every local ingest
 * (so an upload waits for the migration instead of failing on it). One run
 * per process at a time, one per database through an advisory lock.
 *
 * Only for local ingestion: with the search service the vectors are written
 * by that service's own model, and the configured one is never used for them.
 */

const log = require('../../telemetry/log');

const FINGERPRINT_KEY = 'kb_embedding_fingerprint';
// pg_advisory_lock key: any fixed number that nothing else uses.
const LOCK_KEY = 725172010;
const BATCH = 64;
const INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)';

function defaultDeps() {
    const db = require('../../db');
    return {
        getAll: db.getAll,
        // `run` takes parameters; `exec` is for DDL only and takes none.
        run: db.run,
        exec: db.exec,
        getClient: db.getClient,
        configStore: require('../../stores/configStore'),
        resolveTarget: () => require('../embed/resolveTarget').resolveEmbedTarget(),
        embed: (texts) => require('../embed/dispatch').dispatchEmbedTexts(texts, { kind: 'passage', strict: true }),
        usesLocalIngest: () => require('./kbIngestionHelpers').usesLocalIngest(),
        trackCost: (texts) => require('./localKBIngest').trackEmbeddingCost(texts),
        retryFailed: retryDimensionFailures,
    };
}

const fingerprintOf = (target) => `${target.providerId}:${target.modelId}`;

/** The declared dimension of a vector column, or null when it does not exist. */
async function columnDim(deps, column) {
    const rows = await deps.getAll(
        `SELECT a.atttypmod AS typmod
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relname = 'kb_chunks' AND a.attname = $1 AND a.attnum > 0 AND NOT a.attisdropped`,
        [column],
    );
    const dim = Number(rows?.[0]?.typmod);
    return Number.isInteger(dim) && dim > 0 ? dim : null;
}

/** Embed with the configured model only, and insist on the dimension. */
async function embedExactly(deps, texts, dim) {
    const { vectors } = await deps.embed(texts);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(`the embedding provider returned ${vectors?.length || 0} vectors for ${texts.length} texts`);
    }
    for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== dim) {
            throw new Error(`the embedding provider returned a vector of ${v?.length} dimensions, expected ${dim}`);
        }
    }
    return vectors;
}

/** Fill `embedding_next` for every chunk that has none yet. Resumable. */
async function fillNextColumn(deps, dim) {
    let lastId = 0;
    let done = 0;
    for (;;) {
        const rows = await deps.getAll(
            'SELECT id, content FROM kb_chunks WHERE embedding_next IS NULL AND id > $1 ORDER BY id LIMIT $2',
            [lastId, BATCH],
        );
        if (!rows || rows.length === 0) return done;
        const texts = rows.map((r) => r.content || '');
        const vectors = await embedExactly(deps, texts, dim);
        try { deps.trackCost(texts); } catch (_) { /* cost logging never blocks the migration */ }
        await deps.run(
            `UPDATE kb_chunks SET embedding_next = v.e::vector
             FROM unnest($1::bigint[], $2::text[]) AS v(id, e)
             WHERE kb_chunks.id = v.id`,
            [rows.map((r) => r.id), vectors.map((vec) => `[${vec.join(',')}]`)],
        );
        done += rows.length;
        lastId = rows[rows.length - 1].id;
    }
}

/** Swap the filled side column in for the old one, in one transaction. */
async function swapColumns(deps) {
    const client = await deps.getClient();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE kb_chunks IN ACCESS EXCLUSIVE MODE');
        await client.query('DROP INDEX IF EXISTS idx_kb_chunks_embedding');
        await client.query('ALTER TABLE kb_chunks DROP COLUMN embedding');
        await client.query('ALTER TABLE kb_chunks RENAME COLUMN embedding_next TO embedding');
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    // Outside the transaction: building the index can take a while and
    // search works without it.
    try { await deps.exec(INDEX_SQL); } catch (err) { log.warn(`[KBEmbedMigration] vector index not rebuilt: ${err.message}`); }
}

async function migrate(deps, { reason }) {
    if (!(await deps.usesLocalIngest())) return { status: 'not_local' };
    const target = await deps.resolveTarget();
    if (!target?.providerId || !target?.modelId) return { status: 'no_target' };
    const fingerprint = fingerprintOf(target);
    if ((await deps.configStore.getConfig(FINGERPRINT_KEY)) === fingerprint) return { status: 'current' };
    // No table yet (fresh install, or pgvector missing): the first ingest
    // creates it with the right dimension.
    if ((await columnDim(deps, 'embedding')) == null) return { status: 'no_table' };

    const lock = await deps.getClient();
    try {
        await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        // Another process may have finished while this one waited.
        const stored = await deps.configStore.getConfig(FINGERPRINT_KEY);
        if (stored === fingerprint) return { status: 'current' };

        const dim = await columnDim(deps, 'embedding');
        // The dimension is what the model returns, not a table of known models.
        const probe = (await deps.embed(['dimension probe']))?.vectors?.[0];
        const targetDim = Array.isArray(probe) ? probe.length : 0;
        if (!targetDim) throw new Error('the embedding provider returned no vector');

        // Vectors from before fingerprints existed: when the dimension already
        // fits, assume they came from this model rather than re-embedding
        // every knowledge base on the first boot after an upgrade.
        if (!stored && dim === targetDim) {
            await deps.configStore.setConfig(FINGERPRINT_KEY, fingerprint);
            return { status: 'adopted' };
        }

        const count = Number((await deps.getAll('SELECT COUNT(*)::int AS n FROM kb_chunks'))?.[0]?.n) || 0;
        log.info(`[KBEmbedMigration] ${reason}: embedding model is now ${target.modelId} (${targetDim} dims, column has ${dim}); re-embedding ${count} chunk(s)`);

        if (count === 0) {
            if (dim !== targetDim) {
                await deps.exec('DROP INDEX IF EXISTS idx_kb_chunks_embedding');
                await deps.exec(`ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE VECTOR(${targetDim})`);
                try { await deps.exec(INDEX_SQL); } catch (_) { /* rebuilt by the next migration or ingest */ }
            }
        } else {
            // A side column left by an interrupted run is reused when it has
            // the right dimension (its filled rows are done), dropped otherwise.
            const nextDim = await columnDim(deps, 'embedding_next');
            if (nextDim != null && nextDim !== targetDim) await deps.exec('ALTER TABLE kb_chunks DROP COLUMN embedding_next');
            if (nextDim !== targetDim) await deps.exec(`ALTER TABLE kb_chunks ADD COLUMN embedding_next VECTOR(${targetDim})`);
            const done = await fillNextColumn(deps, targetDim);
            await swapColumns(deps);
            log.info(`[KBEmbedMigration] re-embedded ${done} chunk(s) with ${target.modelId}`);
        }

        await deps.configStore.setConfig(FINGERPRINT_KEY, fingerprint);
        return { status: 'migrated', chunks: count, dim: targetDim };
    } finally {
        await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
        lock.release();
    }
}

/** Migrate, then — outside the lock, it can take minutes — retry what failed on the old dimension. */
async function migrateAndRetry(deps, opts) {
    const result = await migrate(deps, opts);
    if (result.status === 'migrated') {
        try { await deps.retryFailed(); } catch (err) { log.warn(`[KBEmbedMigration] retrying failed documents: ${err.message}`); }
    }
    return result;
}

/**
 * Documents that failed on a dimension mismatch, retried through their
 * source (an upload source re-extracts its failed rows, a web source
 * re-fetches). Documents without a source stay as they are: re-uploading
 * them is the only way back, and the row already says why it failed.
 */
async function retryDimensionFailures() {
    const { getAll } = require('../../db');
    const rows = await getAll(
        `SELECT DISTINCT source_id FROM documents
         WHERE status = 'error' AND status_reason ILIKE '%dimensions%' AND source_id IS NOT NULL`,
    );
    if (!rows || rows.length === 0) return 0;
    const kbSources = require('../../stores/kbSources');
    const { syncSource } = require('./sources');
    let retried = 0;
    for (const { source_id: sourceId } of rows) {
        try {
            const source = await kbSources.get(sourceId);
            if (!source) continue;
            await syncSource(source, { reason: 'reembed', timeBudgetMs: 10 * 60_000 });
            retried += 1;
        } catch (err) {
            log.warn(`[KBEmbedMigration] source ${sourceId} not retried: ${err.message}`);
        }
    }
    log.info(`[KBEmbedMigration] retried ${retried} source(s) with documents that failed on the old dimension`);
    return retried;
}

let running = null;

/**
 * Bring the stored vectors in line with the configured model. Safe to call
 * often: a no-op (one config read) while nothing changed, and concurrent
 * callers in this process share one run.
 *
 * @param {{ reason?: string, deps?: object }} [opts]
 * @returns {Promise<{ status: string, chunks?: number, dim?: number }>}
 */
function ensureKbEmbeddingsCurrent({ reason = 'check', deps = null } = {}) {
    if (running) return running;
    running = migrateAndRetry(deps || defaultDeps(), { reason })
        .catch((err) => {
            log.error(`[KBEmbedMigration] ${reason}: re-embedding failed, the old vectors stay in place and the next trigger resumes: ${err.message}`);
            return { status: 'failed', error: err.message };
        })
        .finally(() => { running = null; });
    return running;
}

module.exports = { ensureKbEmbeddingsCurrent, FINGERPRINT_KEY, _test: { migrate, fingerprintOf } };
