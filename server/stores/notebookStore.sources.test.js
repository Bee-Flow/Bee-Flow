/**
 * Notebook source queries: the list never reads content_text, a new source takes
 * its position in ONE statement, ingestion writes can be made conditional on the
 * row still being `processing`, the stuck-source watchdog only writes when a row
 * is overdue, and bulk delete is one scoped statement.
 *
 * Run: node --test stores/notebookStore.sources.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const calls = { run: [], getOne: [], getAll: [] };
const answers = { getOne: null, getAll: [] };

const mockDb = {
    run: async (sql, params = []) => {
        calls.run.push({ sql, params });
        if (/INSERT INTO notebook_sources/i.test(sql)) return { rowCount: 1, rows: [{ sort_order: 7 }] };
        return { rowCount: 1, rows: [] };
    },
    getOne: async (sql, params = []) => { calls.getOne.push({ sql, params }); return answers.getOne; },
    getAll: async (sql, params = []) => { calls.getAll.push({ sql, params }); return answers.getAll; },
    exec: async () => undefined,
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };

const notebookStore = require('./notebookStore');

function reset() {
    calls.run = []; calls.getOne = []; calls.getAll = [];
    answers.getOne = null; answers.getAll = [];
}

test('getSources selects explicit columns, never content_text, and reports has_content', async () => {
    reset();
    answers.getAll = [
        { id: 's1', notebook_id: 'n1', type: 'text', name: 'A', status: 'ready', has_content: true, word_count: 3 },
        { id: 's2', notebook_id: 'n1', type: 'url', name: 'B', status: 'processing', has_content: false },
    ];
    const rows = await notebookStore.getSources('n1');
    const q = calls.getAll.find(c => /FROM notebook_sources/i.test(c.sql));
    assert.ok(q, 'a source query ran');
    assert.doesNotMatch(q.sql, /SELECT\s+\*/i, 'no SELECT *');
    assert.doesNotMatch(q.sql.replace(/content_text\s+IS\s+NOT\s+NULL\s+AND\s+content_text\s*<>\s*''/i, ''), /content_text/i,
        'content_text only appears inside the has_content test');
    assert.match(q.sql, /AS has_content/i);
    assert.deepStrictEqual(rows.map(r => r.hasContent), [true, false]);
});

test('getSource and deleteSource do not pull content_text either', async () => {
    reset();
    answers.getOne = { id: 's1', notebook_id: 'n1', has_content: true };
    await notebookStore.getSource('s1');
    await notebookStore.deleteSource('s1', 'n1');
    for (const c of calls.getOne.filter(c => /FROM notebook_sources/i.test(c.sql))) {
        assert.doesNotMatch(c.sql, /SELECT\s+\*/i);
    }
});

test('getSourceContent is the one getter that reads content_text', async () => {
    reset();
    answers.getOne = { content_text: 'hello' };
    assert.strictEqual(await notebookStore.getSourceContent('s1'), 'hello');
    assert.match(calls.getOne[0].sql, /SELECT content_text FROM notebook_sources/i);
});

test('addSource takes its position in a single INSERT ... SELECT (no separate MAX read)', async () => {
    reset();
    const src = await notebookStore.addSource({ notebookId: 'n1', type: 'text', name: 'X', contentText: 'abc' });
    assert.strictEqual(calls.getOne.filter(c => /MAX\(sort_order\)/i.test(c.sql)).length, 0, 'no separate MAX query');
    const ins = calls.run.find(c => /INSERT INTO notebook_sources/i.test(c.sql));
    assert.match(ins.sql, /COALESCE\(MAX\(sort_order\),\s*0\)\s*\+\s*1/i);
    assert.match(ins.sql, /FROM notebook_sources WHERE notebook_id/i);
    assert.strictEqual(src.sortOrder, 7, 'the position the database chose is returned');
});

test('updateSource with onlyIfProcessing adds a status guard; without it, it does not', async () => {
    reset();
    await notebookStore.updateSource('s1', { status: 'ready' }, { onlyIfProcessing: true });
    await notebookStore.updateSource('s1', { status: 'ready' });
    const [guarded, plain] = calls.run.filter(c => /UPDATE notebook_sources/i.test(c.sql));
    assert.match(guarded.sql, /WHERE id = \$2 AND status = \$3/i);
    assert.deepStrictEqual(guarded.params, ['ready', 's1', 'processing']);
    assert.doesNotMatch(plain.sql, /status = \$3/i);
});

test('timeoutStuckSources only writes when a processing row is overdue', async () => {
    reset();
    answers.getOne = null;
    assert.strictEqual(await notebookStore.timeoutStuckSources('n1'), 0);
    assert.strictEqual(calls.run.filter(c => /UPDATE notebook_sources/i.test(c.sql)).length, 0, 'no UPDATE on a quiet poll');

    reset();
    answers.getOne = { x: 1 };
    await notebookStore.timeoutStuckSources('n1');
    const upd = calls.run.find(c => /UPDATE notebook_sources/i.test(c.sql));
    assert.ok(upd, 'overdue row -> UPDATE');
    assert.match(upd.sql, /stage = 'error'/i);
});

test('deleteSources deletes only this notebook\'s rows, in one statement', async () => {
    reset();
    answers.getAll = [{ id: 's1', notebook_id: 'n1', has_content: false }];
    const removed = await notebookStore.deleteSources(['s1', 'foreign', 's1'], 'n1');
    assert.deepStrictEqual(removed.map(r => r.id), ['s1']);
    const sel = calls.getAll[0];
    assert.match(sel.sql, /id = ANY\(\$1::text\[\]\) AND notebook_id = \$2/i);
    assert.deepStrictEqual(sel.params, [['s1', 'foreign'], 'n1']);
    const dels = calls.run.filter(c => /DELETE FROM notebook_sources/i.test(c.sql));
    assert.strictEqual(dels.length, 1);
    assert.deepStrictEqual(dels[0].params, [['s1'], 'n1']);

    reset();
    answers.getAll = [];
    assert.deepStrictEqual(await notebookStore.deleteSources(['foreign'], 'n1'), []);
    assert.strictEqual(calls.run.filter(c => /DELETE FROM/i.test(c.sql)).length, 0);
});
