/**
 * The backfill that makes an embedding-provider switch survivable.
 *
 * THE BUG THIS JOB EXISTS FOR: vectors lived in JSONB and were compared by a JS
 * cosine loop, and cosine returns 0 across mismatched dimensions. So changing
 * embedding provider did not degrade recall — every memory written under the
 * old provider became permanently unreachable, with nothing reporting it. On
 * the box this was written on, 15 of 97 rows.
 *
 * The two assertions that carry the design:
 *
 *   1. ADOPT IS FREE. A row whose existing vector is already the active
 *      dimension must be moved into the typed column by a SQL cast, never by
 *      calling the provider again. On an ordinary upgrade that is every row —
 *      re-embedding them would be a large metered bill for text that did not
 *      change.
 *   2. NO PROVIDER STILL MAKES PROGRESS. With every embedding tier down, the
 *      lexical phase must still run, because `search_vector` is what keeps
 *      those rows findable at all.
 *
 * Run: cd server && node --test jobs/memoryEmbeddingBackfill.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const stub = (relPath, exports) => {
    const p = require.resolve(relPath);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// ── DB stub ──────────────────────────────────────────────────────────
const queries = [];
let selectRows = [];
let updateRowCount = 0;
let activeRowCount = 0;

stub('../db', {
    run: async (sql, params) => {
        queries.push({ sql, params });
        return { rowCount: updateRowCount };
    },
    getAll: async (sql, params) => {
        queries.push({ sql, params });
        const rows = selectRows;
        selectRows = []; // one batch, then the loop terminates
        return rows;
    },
    getOne: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('pg_class')) return null;
        return { n: activeRowCount, total: activeRowCount, lexical: 0, stuck: 0 };
    },
    pool: {
        connect: async () => ({
            query: async (sql) => {
                queries.push({ sql, params: null });
                if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
                return { rows: [] };
            },
            release: () => {},
        }),
    },
});

// ── memoryStore stub — the provider boundary ─────────────────────────
let probeDim = 384;
const indexed = [];
stub('../stores/memoryStore', {
    embedOne: async (_text) => (probeDim
        ? { vector: new Array(probeDim).fill(0.01), dim: probeDim }
        : null),
    indexMemory: async (id, content) => { indexed.push({ id, content }); return { ok: true, dim: probeDim }; },
    ensureVectorColumn: async () => true,
    isPgvectorAvailable: () => true,
});
stub('../telemetry/metrics', { recordJobRun: () => {} });

const {
    runOnce, fillLexical, adoptExisting, reembedStale, probeActiveDim,
    MAX_EMBED_ATTEMPTS, ANN_INDEX_THRESHOLD,
} = require('./memoryEmbeddingBackfill');

const FUTURE = () => Date.now() + 30_000;

beforeEach(() => {
    queries.length = 0;
    indexed.length = 0;
    selectRows = [];
    updateRowCount = 0;
    activeRowCount = 0;
    probeDim = 384;
});

// ── Phase 2: the free one ────────────────────────────────────────────

test('adopt moves an existing same-dimension vector across without the provider', async () => {
    updateRowCount = 3;
    const adopted = await adoptExisting(384, Date.now() + 50);
    assert.ok(adopted >= 3);
    assert.strictEqual(indexed.length, 0, 'adoption must not call the embedding provider');

    const sql = queries[0].sql;
    assert.ok(sql.includes('embedding::text::vector(384)'));
    assert.ok(sql.includes('jsonb_array_length(embedding) = 384'), 'only rows already at the active dimension');
    assert.ok(sql.includes('"embedding_384" IS NULL'), 'and only rows not already migrated');
});

test('adopt refuses to build a query for an unusable dimension', async () => {
    const adopted = await adoptExisting('384; DROP TABLE user_memories', FUTURE());
    assert.strictEqual(adopted, 0);
    assert.strictEqual(queries.length, 0, 'nothing may reach the database');
});

// ── Phase 3: the one that costs money ────────────────────────────────

test('re-embed only considers rows with no vector in the active dimension', async () => {
    selectRows = [{ id: 'm1', content: 'stranded at 1024' }];
    const result = await reembedStale(384, FUTURE());

    assert.strictEqual(result.embedded, 1);
    assert.deepStrictEqual(indexed.map(i => i.id), ['m1']);
    assert.ok(queries[0].sql.includes('"embedding_384" IS NULL'));
});

test('a row that keeps failing drops out instead of being retried forever', async () => {
    selectRows = [{ id: 'm1', content: 'x' }];
    await reembedStale(384, FUTURE());
    assert.ok(queries[0].sql.includes(`COALESCE(embed_attempts, 0) < ${MAX_EMBED_ATTEMPTS}`));
});

test('re-embed prioritises the memories most likely to be retrieved', async () => {
    selectRows = [{ id: 'm1', content: 'x' }];
    await reembedStale(384, FUTURE());
    // A bounded pass should heal the rows that matter first, so a large
    // backlog improves retrieval from the very first tick.
    assert.ok(queries[0].sql.includes('ORDER BY importance DESC NULLS LAST, updated_at DESC'));
});

// ── Phase 1: the one that always runs ────────────────────────────────

test('the lexical phase fills only rows that have no tsvector', async () => {
    updateRowCount = 2;
    await fillLexical(Date.now() + 50);
    assert.ok(queries[0].sql.includes('search_vector IS NULL'));
    assert.ok(queries[0].sql.includes('to_tsvector'));
});

test('with no embedding provider at all, the lexical phase still runs', async () => {
    probeDim = null;
    updateRowCount = 0;
    await runOnce();

    assert.strictEqual(indexed.length, 0);
    assert.ok(
        queries.some(q => q.sql.includes('search_vector IS NULL')),
        'the phase that needs no provider must not be skipped with the ones that do',
    );
    assert.ok(!queries.some(q => q.sql.includes('embedding::text::vector')), 'adopt needs a dimension');
});

test('probeActiveDim reports null rather than guessing when nothing is reachable', async () => {
    probeDim = null;
    assert.strictEqual(await probeActiveDim(), null);
});

// ── Concurrency and cost guards ──────────────────────────────────────

test('the pass takes an advisory lock before spending anything', async () => {
    await runOnce();
    const lockIndex = queries.findIndex(q => q.sql.includes('pg_try_advisory_lock'));
    assert.ok(lockIndex >= 0, 'concurrent replicas would duplicate metered spend');
    const firstWrite = queries.findIndex(q => q.sql.includes('UPDATE user_memories'));
    if (firstWrite >= 0) assert.ok(lockIndex < firstWrite, 'the lock must come first');
});

test('a dry run reports state without writing anything', async () => {
    const result = await runOnce({ dryRun: true });
    assert.ok(result.dryRun);
    assert.strictEqual(indexed.length, 0);
    assert.ok(!queries.some(q => q.sql.includes('UPDATE user_memories')));
});

test('no ANN index is built while exact search is still correct', async () => {
    // pgvector applies the user_id filter AFTER the index scan, so an ANN
    // index can return sixty other users' rows and drop this user's best
    // memory. Below the threshold, exact search is both faster and right.
    activeRowCount = ANN_INDEX_THRESHOLD - 1;
    await runOnce();
    assert.ok(!queries.some(q => q.sql.includes('CREATE INDEX CONCURRENTLY')));
});

test('the ANN index is built concurrently once the table is large enough', async () => {
    activeRowCount = ANN_INDEX_THRESHOLD + 1;
    await runOnce();
    const build = queries.find(q => q.sql.includes('CREATE INDEX CONCURRENTLY'));
    assert.ok(build, 'past the threshold an exact scan stops being viable');
    assert.ok(build.sql.includes('hnsw'));
});
