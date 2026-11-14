// @typecheck
/**
 * kb/model.buildDocumentFilters: the WHERE of the document list, run against a
 * real Postgres (PGlite, testUtils/pgliteDb.js) over a few documents.
 *
 * The sender filter is literal text in ILIKE: a sender containing `_` or `%`
 * (j_doe@example.test) must not match as a wildcard and list mail from other
 * senders. The title filter (`q`) next to it is escaped the same way.
 *
 * Run: cd server && node --test stores/kb/model.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { buildDocumentFilters } = require('./model');

const { pg, db } = pgliteDb();

test.before(async () => {
    await pg.exec(`
        CREATE TABLE documents (id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL, title TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb);
        INSERT INTO documents (id, knowledge_base_id, title, metadata) VALUES
            ('d1', 'kb1', 'Offer', '{"from": "j_doe%@example.test"}'),
            ('d2', 'kb1', 'Invoice', '{"from": "jxdoe@example.test"}'),
            ('d3', 'kb1', '50% discount', '{"from": "alice@example.test"}'),
            ('d4', 'kb1', '500 items', '{"from": "alice@example.test"}'),
            ('d5', 'kb2', '50% discount', '{"from": "alice@example.test"}');
    `);
});
test.after(() => pg.close());

async function matching(kbId, filters) {
    const { clauses, vals } = buildDocumentFilters(kbId, filters);
    const { rows } = await db.query(`SELECT id FROM documents WHERE ${clauses.join(' AND ')} ORDER BY id`, vals);
    return rows.map((r) => r.id);
}

test('sender is literal text in ILIKE: % and _ are escaped', async () => {
    assert.deepEqual(await matching('kb1', { sender: 'j_doe%' }), ['d1']);
    assert.deepEqual(await matching('kb1', { sender: 'j_doe' }), ['d1'], 'the underscore is not a wildcard');
});

test('a plain sender and the title filter combine, the title filter escaped too', async () => {
    assert.deepEqual(await matching('kb1', { sender: 'ALICE' }), ['d3', 'd4']);
    assert.deepEqual(await matching('kb1', { sender: 'alice', q: '50%' }), ['d3']);
});

test('the knowledge base always bounds the list', async () => {
    assert.deepEqual(await matching('kb2', { q: '50%' }), ['d5']);
    assert.deepEqual(await matching('kb1', {}), ['d1', 'd2', 'd3', 'd4']);
});
