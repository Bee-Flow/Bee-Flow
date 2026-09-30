/**
 * core/kb/embeddingMigration.js with every collaborator injected: a fake
 * kb_chunks table (column dims + rows), a fake config store and a fake
 * strict embedder. No database, no provider.
 *
 * Proven:
 *   - an unchanged model does nothing (one config read);
 *   - vectors from before fingerprints existed are adopted when the
 *     dimension already fits, not re-embedded;
 *   - a model switch re-embeds every chunk from its stored text into a side
 *     column, swaps it in, rebuilds the index, records the new model and
 *     retries the documents that failed on the old dimension;
 *   - an empty table is ALTERed instead;
 *   - a provider that answers in the wrong dimension stops the migration
 *     before the swap and records nothing, so the next trigger retries;
 *   - the search-service path is left alone;
 *   - concurrent callers share one run.
 */

const test = require('node:test');
const assert = require('node:assert');

const { ensureKbEmbeddingsCurrent, FINGERPRINT_KEY } = require('./embeddingMigration');

function makeWorld({ dim = 768, rows = 3, fingerprint = null, modelDim = 1024, local = true, model = 'mistral-embed' } = {}) {
    const cols = { embedding: dim };
    const chunks = Array.from({ length: rows }, (_, i) => ({ id: i + 1, content: `chunk ${i + 1}`, next: null }));
    const config = { [FINGERPRINT_KEY]: fingerprint };
    const sql = [];
    const embedded = [];
    let retried = 0;
    let embedDim = modelDim;

    const query = async (text, params) => {
        sql.push(text.replace(/\s+/g, ' ').trim());
        if (/DROP COLUMN embedding$/.test(text.trim())) delete cols.embedding;
        if (/RENAME COLUMN embedding_next TO embedding/.test(text)) { cols.embedding = cols.embedding_next; delete cols.embedding_next; }
        return { rows: [] , params };
    };
    const deps = {
        getAll: async (text, params = []) => {
            sql.push(text.replace(/\s+/g, ' ').trim());
            if (/FROM pg_attribute/.test(text)) return cols[params[0]] ? [{ typmod: cols[params[0]] }] : [];
            if (/COUNT\(\*\)/.test(text)) return [{ n: chunks.length }];
            if (/embedding_next IS NULL/.test(text)) {
                return chunks.filter((c) => c.next === null && c.id > params[0]).slice(0, params[1]).map(({ id, content }) => ({ id, content }));
            }
            return [];
        },
        // Like db.exec: DDL only, no parameters (it has no second argument).
        exec: async (text, ...rest) => {
            if (rest.length > 0) throw new Error('db.exec takes no parameters');
            sql.push(text.replace(/\s+/g, ' ').trim());
            let m = text.match(/ADD COLUMN embedding_next VECTOR\((\d+)\)/);
            if (m) cols.embedding_next = Number(m[1]);
            m = text.match(/ALTER COLUMN embedding TYPE VECTOR\((\d+)\)/);
            if (m) cols.embedding = Number(m[1]);
            if (/DROP COLUMN embedding_next/.test(text)) delete cols.embedding_next;
        },
        run: async (text, params) => {
            sql.push(text.replace(/\s+/g, ' ').trim());
            if (/UPDATE kb_chunks SET embedding_next/.test(text)) {
                params[0].forEach((id, i) => { chunks.find((c) => c.id === id).next = params[1][i]; });
            }
        },
        getClient: async () => ({ query, release() {} }),
        configStore: {
            getConfig: async (k) => config[k] ?? null,
            setConfig: async (k, v) => { config[k] = v; },
        },
        resolveTarget: async () => ({ providerId: 'p-mistral', modelId: model }),
        embed: async (texts) => {
            embedded.push(...texts);
            return { vectors: texts.map(() => Array(embedDim).fill(0.1)) };
        },
        usesLocalIngest: async () => local,
        trackCost: () => {},
        retryFailed: async () => { retried += 1; },
    };
    return {
        deps, cols, chunks, config, sql, embedded,
        get retried() { return retried; },
        setEmbedDim: (d) => { embedDim = d; },
    };
}

test('an unchanged model does nothing', async () => {
    const w = makeWorld({ fingerprint: 'p-mistral:mistral-embed' });
    const r = await ensureKbEmbeddingsCurrent({ deps: w.deps });
    assert.deepStrictEqual(r, { status: 'current' });
    assert.deepStrictEqual(w.embedded, []);
});

test('vectors from before fingerprints are adopted when the dimension fits', async () => {
    const w = makeWorld({ dim: 1024, fingerprint: null });
    const r = await ensureKbEmbeddingsCurrent({ deps: w.deps });
    assert.strictEqual(r.status, 'adopted');
    assert.deepStrictEqual(w.embedded, ['dimension probe'], 'only the probe, no re-embedding');
    assert.strictEqual(w.config[FINGERPRINT_KEY], 'p-mistral:mistral-embed');
});

test('a model switch re-embeds every chunk from its text, swaps the column and records the model', async () => {
    const w = makeWorld({ dim: 768, rows: 130, fingerprint: 'p-old:nomic' });
    const r = await ensureKbEmbeddingsCurrent({ reason: 'config', deps: w.deps });

    assert.deepStrictEqual(r, { status: 'migrated', chunks: 130, dim: 1024 });
    assert.strictEqual(w.cols.embedding, 1024);
    assert.strictEqual(w.cols.embedding_next, undefined);
    assert.ok(w.chunks.every((c) => c.next !== null), 'every chunk got a new vector');
    assert.deepStrictEqual(w.embedded.slice(1), w.chunks.map((c) => c.content), 'embedded from the stored text, in order');
    assert.ok(w.sql.some((s) => /CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding/.test(s)), 'index rebuilt');
    assert.ok(w.sql.some((s) => /pg_advisory_unlock/.test(s)), 'lock released');
    assert.strictEqual(w.config[FINGERPRINT_KEY], 'p-mistral:mistral-embed');
    assert.strictEqual(w.retried, 1, 'documents that failed on the old dimension are retried');
});

test('an empty table is ALTERed instead of rebuilt', async () => {
    const w = makeWorld({ dim: 768, rows: 0, fingerprint: 'p-old:nomic' });
    const r = await ensureKbEmbeddingsCurrent({ deps: w.deps });
    assert.strictEqual(r.status, 'migrated');
    assert.strictEqual(w.cols.embedding, 1024);
    assert.ok(!w.sql.some((s) => /embedding_next/.test(s)));
});

test('a vector of the wrong dimension stops before the swap and records nothing', async () => {
    const w = makeWorld({ dim: 768, rows: 100, fingerprint: 'p-old:nomic' });
    const embed = w.deps.embed;
    let calls = 0;
    w.deps.embed = async (texts) => {
        calls += 1;
        // The probe and the first batch are right; then the provider "falls back".
        if (calls > 2) w.setEmbedDim(384);
        return embed(texts);
    };
    const r = await ensureKbEmbeddingsCurrent({ deps: w.deps });

    assert.strictEqual(r.status, 'failed');
    assert.match(r.error, /384 dimensions, expected 1024/);
    assert.strictEqual(w.cols.embedding, 768, 'old column still in place');
    assert.strictEqual(w.cols.embedding_next, 1024, 'side column kept, so the next run resumes');
    assert.strictEqual(w.config[FINGERPRINT_KEY], 'p-old:nomic');
    assert.ok(w.sql.some((s) => /pg_advisory_unlock/.test(s)), 'lock released on failure');
});

test('the search-service path is left alone', async () => {
    const w = makeWorld({ local: false });
    const r = await ensureKbEmbeddingsCurrent({ deps: w.deps });
    assert.deepStrictEqual(r, { status: 'not_local' });
    assert.deepStrictEqual(w.embedded, []);
});

test('concurrent callers share one run', async () => {
    const w = makeWorld({ dim: 768, rows: 5, fingerprint: 'p-old:nomic' });
    const [a, b] = await Promise.all([
        ensureKbEmbeddingsCurrent({ deps: w.deps }),
        ensureKbEmbeddingsCurrent({ deps: w.deps }),
    ]);
    assert.strictEqual(a, b);
    assert.strictEqual(w.embedded.length, 1 + 5, 'one probe and one pass');
});
