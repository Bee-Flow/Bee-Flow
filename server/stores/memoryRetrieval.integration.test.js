'use strict';

/**
 * Memory retrieval against a REAL Postgres with pgvector. The pglite suites
 * cannot load the extension, so the vector SQL (typed `embedding_<dim>`
 * column, `<=>`, the cosine floor, `::vector` casts) is only proven here.
 *
 * Opt-in: skipped unless MEMORY_TEST_DATABASE_URL points at a disposable
 * Postgres server that has the `vector` extension available (the test creates
 * its own database on it and drops that database again). Not listed in
 * scripts/test-exclusions.json: like documentStore.integration.test.js it
 * skips itself, so `npm test` reports it as skipped, never as a failure.
 *
 * Run: MEMORY_TEST_DATABASE_URL=postgres://user:pw@127.0.0.1:55432/postgres \
 *        node --test stores/memoryRetrieval.integration.test.js
 *
 * The embedding provider is the real chain with `fetch` replaced by a
 * deterministic 8-dimensional embedder (no module mocks): the provider is
 * configured through the real `ai` config row.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const URL_ = process.env.MEMORY_TEST_DATABASE_URL;
const DIM = 8;
const unit = (i) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));

/** Deterministic text -> vector; orthogonal topics so the expected order is exact. */
function embedText(text) {
    const t = String(text).toLowerCase();
    if (t.includes('beverage')) return [0.9, 0.3, 0, 0, 0, 0, 0, 0];   // the query: near tea, a little cycling
    if (t.includes('tea')) return unit(0);
    if (t.includes('cycles') || t.includes('bike')) return unit(1);
    if (t.includes('revenue')) return unit(2);
    if (t.includes('diabetes')) return unit(0);                          // art. 9 row sits right on the query
    return unit(7);
}

describe('memory retrieval on Postgres + pgvector', { skip: !URL_ && 'MEMORY_TEST_DATABASE_URL is not set' }, () => {
    let admin; let database; let db; let store; let backfill; let memoryIndex; let retrieval; let invalidatePolicyCache;
    let realFetch; let fetchCalls = 0;
    const A = 'it-alice';     // plaintext org
    const B = 'it-bob';       // sealed org (managed encryption)

    const raw = async (id) => db.getOne('SELECT * FROM user_memories WHERE id = $1', [id]);
    const waitFor = async (fn) => {
        for (let i = 0; i < 400; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
        throw new Error('timed out waiting for the background embed');
    };
    const ids = (rows) => rows.map((m) => m.id);

    before(async () => {
        const { Pool } = require('pg');
        admin = new Pool({ connectionString: URL_ });
        database = `memory_it_${crypto.randomBytes(6).toString('hex')}`;
        await admin.query(`CREATE DATABASE ${database}`);
        const u = new URL(URL_); u.pathname = `/${database}`;
        process.env.CORE_DATABASE_URL = u.toString();
        process.env.MASTER_ENCRYPTION_KEY = 'memory-integration-test-only-key-32b!';

        db = require('../db');
        // Tables other stores own; only the columns the memory store reads.
        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, "displayName" TEXT, "organizationId" TEXT);
            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY, name TEXT, encryption_tier TEXT DEFAULT 'none', encryption_scope TEXT,
                org_root_key TEXT, org_key_version INTEGER);
            INSERT INTO organizations (id, name, encryption_tier) VALUES ('org-plain', 'plain', 'none'), ('org-sealed', 'sealed', 'none');
            INSERT INTO users (id, username, "displayName", "organizationId") VALUES
                ('${A}', '${A}', '${A}', 'org-plain'), ('${B}', '${B}', '${B}', 'org-sealed');`);

        // The embedding provider: the real resolver reads this config row; fetch is the only fake.
        const configStore = require('./configStore');
        await configStore.setConfig('ai', {
            embeddingProviderId: 'p1', embeddingModel: 'emb-8',
            providers: [{ id: 'p1', name: 'fake', type: 'openai', url: 'https://emb.invalid/v1', apiKey: 'k' }],
        });
        realFetch = global.fetch;
        global.fetch = async (_url, init) => {
            fetchCalls++;
            const input = JSON.parse(init.body).input[0];
            return new Response(JSON.stringify({ data: [{ embedding: embedText(input) }] }), { status: 200 });
        };

        store = require('./memoryStore');
        memoryIndex = require('./memoryIndex');
        retrieval = require('./memoryRetrieval');
        backfill = require('../jobs/memoryEmbeddingBackfill');
        ({ invalidatePolicyCache } = require('./encryptionPolicy'));
        await store.initDB();
    });

    after(async () => {
        if (realFetch) global.fetch = realFetch;
        try { await db?.pool?.end(); } catch (_) { /* best effort */ }
        try {
            if (admin && database) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        } finally {
            await admin?.end();
        }
    });

    test('init: columns, the search_vector trigger and the GIN index exist; pgvector is on', async () => {
        assert.equal(memoryIndex.isPgvectorAvailable(), true);
        const cols = (await db.getAll(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_memories'`)).map((r) => r.column_name);
        for (const c of ['search_vector', 'embed_attempts', 'embed_failed_at', 'embedding', 'embedding_enc', 'sensitivity', 'status', 'valid_to', 'key_hash']) {
            assert.ok(cols.includes(c), `column ${c}`);
        }
        const trg = await db.getOne(`SELECT 1 AS ok FROM pg_trigger WHERE tgname = 'trg_user_memories_search_vector'`);
        assert.ok(trg);
        const idx = await db.getOne(`SELECT 1 AS ok FROM pg_indexes WHERE indexname = 'idx_memories_search_vector'`);
        assert.ok(idx);
        await db.exec(`INSERT INTO user_memories (id, user_id, type, content) VALUES ('trg1', '${A}', 'fact', 'Ik fiets elke dag naar mijn werk')`);
        assert.ok((await raw('trg1')).search_vector, 'the trigger filled search_vector');
        await db.exec(`DELETE FROM user_memories WHERE id = 'trg1'`);
    });

    test('ensureVectorColumn(8) creates a typed vector(8) column, idempotently', async () => {
        assert.equal(await memoryIndex.ensureVectorColumn(DIM), true);
        assert.equal(await memoryIndex.ensureVectorColumn(DIM), true);
        assert.equal(memoryIndex.hasVectorColumn(DIM), true);
        const t = await db.getOne(
            `SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
              WHERE a.attrelid = 'user_memories'::regclass AND a.attname = 'embedding_8'`);
        assert.equal(t.t, 'vector(8)');
        assert.equal(await memoryIndex.ensureVectorColumn(0), false);
    });

    describe('plaintext org', () => {
        let tea; let bike; let revenue; let dutch;
        before(async () => {
            tea = await store.createMemory(A, null, 'fact', 'Tom drinks green tea every morning', null, 0.5);
            bike = await store.createMemory(A, null, 'fact', 'Tom cycles to work every day', null, 0.5);
            revenue = await store.createMemory(A, null, 'fact', 'Quarterly revenue report for finance', null, 0.5);
            dutch = await store.createMemory(A, null, 'fact', 'Ik fiets elke dag naar mijn werk', null, 0.5);
            await waitFor(async () => (await db.getOne(
                `SELECT count(*)::int AS n FROM user_memories WHERE user_id = $1 AND embedding_8 IS NOT NULL`, [A])).n === 4);
        });

        test('embedAndStore wrote the typed column (and the JSONB mirror), unit vectors intact', async () => {
            const r = await db.getOne(`SELECT embedding_8::text AS v, embedding_dim, embedding_enc, search_vector IS NOT NULL AS fts FROM user_memories WHERE id = $1`, [tea]);
            assert.equal(r.v, '[1,0,0,0,0,0,0,0]');
            assert.equal(r.embedding_dim, DIM);
            assert.equal(r.embedding_enc, null);
            assert.equal(r.fts, true);
        });

        test('findRelevantMemories ranks the semantically nearest first (no shared words with the query)', async () => {
            const out = await store.findRelevantMemories(A, null, 'which beverage is preferred', 800);
            assert.equal(out[0].id, tea, 'tea is nearest');
            assert.equal(out[1].id, bike, 'cycling is second (cos 0.32 is above the floor)');
        });

        test('the candidate SQL: the cosine floor keeps orthogonal rows out of the vec leg', async () => {
            const { sql, params, legs } = retrieval.buildCandidateQuery({
                userId: A, dim: DIM, queryVector: embedText('beverage'), queryText: '',
            });
            assert.ok(legs.includes('vec'));
            const rows = await db.getAll(sql, params);
            const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
            assert.ok(byId[tea].vec_rank != null && byId[bike].vec_rank != null);
            assert.equal(Number(byId[tea].vec_rank), 1, 'nearest has rank 1');
            assert.equal(byId[revenue].vec_rank, null, 'cos 0 < VEC_MIN_COSINE: not in the vec leg');
            assert.equal(byId[dutch].vec_rank, null);
            assert.ok(byId[revenue].base_rank != null, 'it still appears through the base leg');
        });

        test('retrieveCandidates scores the vector hit above the orthogonal rows', async () => {
            const c = await retrieval.retrieveCandidates({ userId: A, dim: DIM, queryVector: embedText('beverage'), queryText: '' });
            const pos = (id) => c.findIndex((x) => x.memory.id === id);
            assert.ok(pos(tea) < pos(bike) && pos(bike) < pos(revenue));
        });

        test('the fts leg matches a Dutch stemmed word (fietsen -> fiets)', async () => {
            const { sql, params } = retrieval.buildCandidateQuery({ userId: A, queryText: 'fietsen' });
            const rows = await db.getAll(sql, params);
            const hit = rows.filter((r) => r.fts_rank != null).map((r) => r.id);
            assert.deepEqual(hit, [dutch]);
            const out = await store.findRelevantMemories(A, null, 'fietsen', 800);
            assert.equal(out[0].id, dutch);
        });

        test('valid_to, status and expires_at exclude a row; so does art. 9 unless includeSensitive', async () => {
            const gone = await store.createMemory(A, null, 'fact', 'Tom drinks green tea at night', null, 0.9, 'tom', 'night-drink', 'tea');
            const superseded = await store.createMemory(A, null, 'fact', 'Tom drinks tea from a mug', null, 0.9);
            const archived = await store.createMemory(A, null, 'fact', 'Tom drinks tea in winter', null, 0.9);
            const pending = await store.createMemory(A, null, 'fact', 'Tom drinks tea with milk', null, 0.9, null, null, null, null, null, { status: 'pending_review' });
            const art9 = await store.createMemory(A, null, 'fact', 'Tom has diabetes', null, 0.9, null, null, null, null, null, { sensitivity: 'art9' });
            await waitFor(async () => (await db.getOne(
                `SELECT count(*)::int AS n FROM user_memories WHERE id = ANY($1) AND embedding_8 IS NOT NULL`, [[gone, superseded, archived, pending, art9]])).n === 5);
            await db.exec(`UPDATE user_memories SET valid_to = NOW() - interval '1 day' WHERE id = '${gone}'`);
            await db.exec(`UPDATE user_memories SET status = 'superseded' WHERE id = '${superseded}'`);
            await db.exec(`UPDATE user_memories SET status = 'archived' WHERE id = '${archived}'`);
            const closed = ids(await store.findRelevantMemories(A, null, 'which beverage is preferred', 5000));
            for (const id of [gone, superseded, archived, pending, art9]) assert.ok(!closed.includes(id), `${id} is excluded`);
            const open = ids(await store.findRelevantMemories(A, null, 'which beverage is preferred', 5000, null, { includeSensitive: true }));
            assert.ok(open.includes(art9), 'art. 9 comes back when the caller says the user opted in');
            assert.ok(!open.includes(pending) && !open.includes(archived) && !open.includes(gone));
            await db.exec(`UPDATE user_memories SET status = 'active' WHERE id = '${archived}'`);
            await db.exec(`UPDATE user_memories SET valid_to = NULL WHERE id = '${gone}'`);
            assert.ok(ids(await store.findRelevantMemories(A, null, 'which beverage is preferred', 5000)).includes(gone), 'restored rows are retrievable again');
        });

        test('art. 9 in a project pool is read by its author only, even by an opted-in teammate', async () => {
            const pid = 'it-art9-proj';
            await db.exec(`INSERT INTO projects (id, name, owner_id, organization_id) VALUES ('${pid}', 'p', '${A}', '') ON CONFLICT DO NOTHING`);
            const mine = await store.createMemory(A, null, 'fact', 'Pool secret health note of alice', null, 0.9, null, null, null, null, pid, { sensitivity: 'art9' });
            const theirs = await store.createMemory(B, null, 'fact', 'Pool secret health note of bob', null, 0.9, null, null, null, null, pid, { sensitivity: 'art9' });
            const plain = await store.createMemory(B, null, 'fact', 'Pool plain note of bob', null, 0.9, null, null, null, null, pid);
            const got = ids(await store.findRelevantMemories(A, null, 'pool note', 5000, pid, { includeSensitive: true }));
            assert.ok(got.includes(mine) && got.includes(plain), 'own art9 and the plain pool row are read');
            assert.ok(!got.includes(theirs), "another member's art9 row is not");
        });

        test('findSimilarMemories uses the vector path (no JSONB mirror needed)', async () => {
            await db.exec(`UPDATE user_memories SET embedding = NULL WHERE user_id = '${A}'`);
            const hits = await store.findSimilarMemories(A, 'A tea drinker', { limit: 20 });
            const top = hits.find((h) => h.id === tea);
            assert.ok(top, 'the tea row was found');
            assert.ok(top.cosine !== null && Math.abs(top.cosine - 1) < 1e-6, `cosine ${top.cosine} comes from SQL`);
            assert.ok(!('embedding' in top));
        });

        test('createMemory: a pending row does not supersede an active same-key row; approving does', async () => {
            const lifecycle = require('./memoryLifecycle');
            const first = await store.createMemory(A, null, 'fact', 'Tom lives in Utrecht', null, 0.5, 'tom', 'city', 'utrecht');
            const pend = await store.createMemory(A, null, 'fact', 'Tom lives in Delft', null, 0.5, 'tom', 'city', 'delft', null, null, { status: 'pending_review', confidence: 0.6 });
            assert.equal((await raw(first)).status, 'active');
            const p = await raw(pend);
            assert.equal(p.status, 'pending_review');
            assert.equal(p.attribute, 'city');
            assert.equal(Math.round(p.confidence * 10), 6, 'candidate confidence is stored');
            assert.equal((await raw(first)).confidence, 1, 'explicit writes keep 1.0');
            assert.equal(await lifecycle.approve(pend, A), 1);
            assert.equal((await raw(pend)).status, 'active');
            const old = await raw(first);
            assert.equal(old.status, 'superseded');
            assert.equal(old.superseded_by, pend);
        });
    });

    describe('embedding backfill', () => {
        test('one pass fills search_vector, adopts a legacy vector and embeds the rest; the second pass is a no-op', async () => {
            await db.exec(`DELETE FROM user_memories WHERE user_id = '${A}'`);
            await db.exec(`INSERT INTO user_memories (id, user_id, type, content, embedding, embedding_dim) VALUES
                ('bf-adopt', '${A}', 'fact', 'Tom drinks green tea at breakfast', '[1,0,0,0,0,0,0,0]'::jsonb, 8),
                ('bf-embed', '${A}', 'fact', 'Tom cycles to the station', NULL, NULL),
                ('bf-old', '${A}', 'fact', 'Quarterly revenue report', '[1,0,0]'::jsonb, 3)`);
            await db.exec(`UPDATE user_memories SET search_vector = NULL WHERE user_id = '${A}'`);
            const first = await backfill.runOnce();
            assert.equal(first.dim, DIM);
            assert.equal(first.lexical, 3);
            assert.equal(first.adopted, 1);
            assert.equal(first.embedded, 2);
            assert.equal(first.failed, 0);
            const typed = await db.getAll(`SELECT id, embedding_8::text AS v FROM user_memories WHERE user_id = $1 ORDER BY id`, [A]);
            assert.deepEqual(typed.map((r) => r.id), ['bf-adopt', 'bf-embed', 'bf-old']);
            assert.equal(typed[0].v, '[1,0,0,0,0,0,0,0]');
            assert.equal(typed[1].v, '[0,1,0,0,0,0,0,0]');
            assert.equal(typed[2].v, '[0,0,1,0,0,0,0,0]', 'the other-dimension row was re-embedded');
            const callsBefore = fetchCalls;
            const second = await backfill.runOnce();
            assert.deepEqual({ l: second.lexical, a: second.adopted, e: second.embedded, f: second.failed }, { l: 0, a: 0, e: 0, f: 0 });
            // The probe costs one embed per pass; nothing else is paid.
            assert.equal(fetchCalls - callsBefore, 1);
            const status = await backfill.getBackfillStatus();
            assert.equal(status.complete, true);
        });
    });

    describe('sealed mode (managed encryption) on the same database', () => {
        let sealedId;
        before(async () => {
            await db.exec(`UPDATE organizations SET encryption_tier = 'managed' WHERE id = 'org-sealed'`);
            invalidatePolicyCache();
            sealedId = await store.createMemory(B, null, 'fact', 'Bob drinks green tea every morning', null, 0.5);
            await waitFor(async () => (await raw(sealedId)).embedding_enc);
        });

        test('a sealed row never gets a typed vector, a JSONB vector or a search_vector', async () => {
            const r = await raw(sealedId);
            assert.match(r.content, /^\{"_bfenc"/);
            assert.ok(!r.content.includes('Bob'));
            assert.equal(r.search_vector, null);
            assert.equal(r.embedding, null);
            assert.equal(r.embedding_8, null);
            assert.ok(r.embedding_enc);
            assert.equal(r.embedding_dim, DIM);
        });

        test('retrieval opens the row in JS and ranks it by its sealed vector', async () => {
            const other = await store.createMemory(B, null, 'fact', 'Bob cycles to work', null, 0.5);
            await waitFor(async () => (await raw(other)).embedding_enc);
            const out = await store.findRelevantMemories(B, null, 'which beverage is preferred', 800);
            assert.equal(out[0].id, sealedId);
            assert.equal(out[0].content, 'Bob drinks green tea every morning');
        });

        test('the backfill scrubs a stray index and never writes one for a sealed row', async () => {
            await db.exec(`UPDATE user_memories SET search_vector = to_tsvector('simple', 'leak'), embedding_8 = '[1,0,0,0,0,0,0,0]'::vector WHERE id = '${sealedId}'`);
            const run1 = await backfill.runOnce();
            assert.ok(run1.scrubbed >= 1);
            const r = await raw(sealedId);
            assert.equal(r.search_vector, null);
            assert.equal(r.embedding_8, null);
            const run2 = await backfill.runOnce();
            assert.equal(run2.scrubbed, 0);
            assert.equal(run2.lexical, 0);
            assert.equal((await raw(sealedId)).embedding_8, null);
        });

        test('indexMemory re-embeds a sealed row through its key and keeps it sealed', async () => {
            await db.exec(`UPDATE user_memories SET embedding_enc = NULL, embedding_dim = NULL WHERE id = '${sealedId}'`);
            const res = await store.indexMemory(sealedId);
            assert.equal(res.ok, true);
            const r = await raw(sealedId);
            assert.ok(r.embedding_enc);
            assert.equal(r.embedding_8, null);
            assert.equal(r.search_vector, null);
        });
    });
});
