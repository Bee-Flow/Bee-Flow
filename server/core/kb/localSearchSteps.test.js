const test = require('node:test');
const assert = require('node:assert/strict');
const { makeOrphanFilter, queryCandidates } = require('./localSearchSteps');

const rows = [{ id: 1, document_id: 'AAAA' }, { id: 2, document_id: 'gone' }, { id: 3, document_id: null }];

test('orphan filter: a knowledge base with NO documents left drops every chunk that names one', () => {
    assert.deepEqual(makeOrphanFilter([]).call(null, rows).map(r => r.id), [3]);
    assert.deepEqual(makeOrphanFilter([{ id: 'aaaa' }]).call(null, rows).map(r => r.id), [1, 3]);
});

test('orphan filter: a document check that could not run filters nothing', async () => {
    assert.deepEqual(makeOrphanFilter(null).call(null, rows).map(r => r.id), [1, 2, 3]);
    const client = {
        query: async (/** @type {string} */ sql) => {
            if (/FROM documents/.test(sql)) throw new Error('invalid input syntax for type uuid');
            return { rows: [] };
        },
    };
    const out = await queryCandidates(client, {
        kbIds: ['kb'], topK: 5, vectorStr: null, pgvector: false,
        fts: { ftsAndQuery: 'a', ftsOrQuery: 'a', ftsQueryStr: 'a' },
    });
    assert.equal(out.validDocIds, null);
    assert.equal(makeOrphanFilter(out.validDocIds).call(null, rows).length, 3);
});
