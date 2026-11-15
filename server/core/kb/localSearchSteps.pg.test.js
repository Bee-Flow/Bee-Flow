// @typecheck strict
/**
 * hnsw.ef_search is raised for the vector query alone, on a real Postgres
 * (PGlite): the query runs with 100, and the connection goes back without the
 * setting. A vector query that fails ends its own transaction, so the queries
 * queued behind it on the same connection still answer.
 *
 * PGlite ships no pgvector, so this file stands in for it: `vector` is a domain
 * over text and `<=>` an operator whose "distance" is the hnsw.ef_search in
 * force when it is evaluated. The score a row comes back with is therefore the
 * setting the vector query ran under (vec_score = 1 - ef_search).
 *
 * Run: node --test core/kb/localSearchSteps.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { newPglite } = require('../../testUtils/pgliteTemplate');
const { pgliteQuery } = require('../../testUtils/pglitePool');
const { queryCandidates } = require('./localSearchSteps');

const pg = newPglite();
const query = pgliteQuery(pg);
const client = /** @type {import('pg').PoolClient} */ (/** @type {unknown} */ ({ query }));

const KB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DOC = '11111111-2222-3333-4444-555555555555';
// No full-text part: these tests are about the vector query and what follows it.
const NO_FTS = { ftsAndQuery: '', ftsOrQuery: '', ftsQueryStr: '' };
const search = { kbIds: [KB], topK: 5, vectorStr: '[0.1,0.2]', pgvector: true, fts: NO_FTS };

/** The setting as the session holds it; unset reads as the stand-in default. */
async function efSearchOfSession() {
    const { rows } = await query("SELECT COALESCE(NULLIF(current_setting('hnsw.ef_search', true), ''), 'default') AS value");
    return rows[0].value;
}

before(async () => {
    await pg.exec(`
        CREATE DOMAIN vector AS text;
        CREATE FUNCTION ef_search_in_force(text, text) RETURNS float8 LANGUAGE sql VOLATILE AS $$
            SELECT COALESCE(NULLIF(current_setting('hnsw.ef_search', true), ''), '40')::float8
        $$;
        CREATE OPERATOR <=> (LEFTARG = text, RIGHTARG = text, FUNCTION = ef_search_in_force);
        CREATE TABLE kb_chunks (
            id BIGSERIAL PRIMARY KEY, title TEXT, content TEXT, source_uri TEXT, document_id TEXT,
            chunk_id INT, page_start INT, embedding vector, knowledge_base_id TEXT
        );
        CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID);
    `);
    await pg.query('INSERT INTO kb_chunks (title, content, document_id, chunk_id, embedding, knowledge_base_id) VALUES ($1, $2, $3, 0, $4, $5)',
        ['Handbook', 'Salary scales', DOC, '[0.3,0.4]', KB]);
    await pg.query('INSERT INTO documents (id, knowledge_base_id) VALUES ($1, $2)', [DOC, KB]);
});

after(async () => { await pg.close(); });

test('the vector query runs with ef_search 100 and the connection keeps nothing of it', async () => {
    assert.equal(await efSearchOfSession(), 'default');

    const { vectorResults } = await queryCandidates(client, search);

    assert.equal(vectorResults.rows.length, 1);
    assert.equal(vectorResults.rows[0].vec_score, 1 - 100, 'the query saw hnsw.ef_search = 100');
    assert.equal(await efSearchOfSession(), 'default', 'the setting ended with the transaction');
});

test('a second search on the same connection starts from the default again', async () => {
    await queryCandidates(client, search);
    const { rows } = await query('SELECT 1 - (embedding <=> $1::vector) AS vec_score FROM kb_chunks', ['[0.1,0.2]']);
    assert.equal(rows[0].vec_score, 1 - 40, 'a vector query outside the search runs with the default');
});

test('a vector query that fails leaves no open transaction: the document check behind it still answers', async () => {
    await pg.exec('ALTER TABLE kb_chunks RENAME COLUMN embedding TO embedding_gone');
    try {
        const { vectorResults, validDocIds } = await queryCandidates(client, search);

        assert.deepEqual(vectorResults.rows, [], 'the failed vector query degrades to no vector candidates');
        assert.deepEqual(validDocIds, [{ id: DOC }], 'the query queued after it was not aborted with it');
        assert.equal(await efSearchOfSession(), 'default');
        const { rows } = await query('SELECT count(*)::int AS n FROM kb_chunks');
        assert.equal(rows[0].n, 1, 'the connection takes the next statement');
    } finally {
        await pg.exec('ALTER TABLE kb_chunks RENAME COLUMN embedding_gone TO embedding');
    }
});
