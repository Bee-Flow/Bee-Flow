// @typecheck
/**
 * knowledgeBases.replaceDocumentContent — what the UPDATE writes.
 *
 * The timestamp is the point of this file. This write has always stamped
 * `updated_at` and handed the row back EVEN FOR AN EMPTY PATCH: the re-ingest
 * path calls it to say "checked, unchanged", and a document whose updated_at
 * stopped moving reads downstream as abandoned. A dynamic-UPDATE builder that
 * skips the statement when no column changed would take that away silently —
 * no error, no failing caller, just a row that quietly stops ageing.
 *
 * Run: cd server && node --test --test-force-exit stores/knowledgeBases.documentUpdate.test.js
 */

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { recordDb } = require('../testUtils/routeHarness');

// The real db.js over a recording pool: every statement the store sends is kept
// with its params, and each one answers the stored row.
const db = recordDb(() => ({ rows: [{ id: 'doc-1', title: 'stored title' }] }));

const kb = require('./knowledgeBases');

before(async () => { await kb.initDB(); db.reset(); });
beforeEach(db.reset);

const lastSql = () => db.calls[db.calls.length - 1].sql;
const lastParams = () => db.calls[db.calls.length - 1].params;

test('an empty patch still stamps updated_at and returns the row', async () => {
    const row = await kb.replaceDocumentContent('doc-1', {});
    assert.match(lastSql(), /UPDATE documents SET updated_at = now\(\)/i);
    assert.deepStrictEqual(lastParams(), ['doc-1']);
    assert.match(lastSql(), /RETURNING /);
    assert.strictEqual(row.id, 'doc-1', 'the caller reads the row back, not undefined');
});

test('a patch writes its columns and still stamps updated_at', async () => {
    await kb.replaceDocumentContent('doc-1', { title: 'nieuw', chunkCount: '7' });
    assert.match(lastSql(), /title = \$1/);
    assert.match(lastSql(), /chunk_count = \$2/);
    assert.match(lastSql(), /updated_at = now\(\)/i);
    assert.match(lastSql(), /WHERE id = \$3/);
    assert.deepStrictEqual(lastParams(), ['nieuw', 7, 'doc-1'], 'chunk_count is coerced to an int');
});

test('a key the store does not know names no column', async () => {
    await kb.replaceDocumentContent('doc-1', { 'status = \'processed\', tenant_id': 'x' });
    assert.match(lastSql(), /^UPDATE documents SET updated_at = now\(\)/i,
        'an unmapped key is ignored — the column literal comes only from the store');
    assert.deepStrictEqual(lastParams(), ['doc-1']);
});

test('status and pii_status fall back to their safe value instead of being written through', async () => {
    await kb.replaceDocumentContent('doc-1', { status: 'not-a-status', piiStatus: 'nonsense' });
    assert.deepStrictEqual(lastParams(), ['processed', 'unscanned', 'doc-1']);
});
