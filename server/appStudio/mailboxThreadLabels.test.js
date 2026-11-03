/**
 * A conversation's Outlook categories come from ALL its stored messages, are
 * backfilled for conversations never computed, change only when they differ;
 * and a sync no longer links a skipped conversation's messages to its neighbour.
 *
 * Run: cd server && node --test appStudio/mailboxThreadLabels.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const dataModel = require('./dataModel');
const connectorSync = require('./connectorSync');
const { refreshThreadLabels, unionLabels, threadLabelTargets } = require('./mailboxThreadLabels.mts');

const app = { id: 'app-1', userId: 'owner-1' };
const THREADS = { id: 'tbl_thr000', key: 'threads', name: 'Threads', fields: [
    { id: 'fld_t00001', key: 'thread_key', name: 'Thread', type: 'text', unique: true },
    { id: 'fld_t00002', key: 'last_message_at', name: 'Last', type: 'datetime' },
    { id: 'fld_t00003', key: 'labels', name: 'Labels', type: 'text' },
] };
const MESSAGES = { id: 'tbl_msg000', key: 'messages', name: 'Messages', fields: [
    { id: 'fld_m00001', key: 'provider_message_id', name: 'Id', type: 'text', unique: true },
    { id: 'fld_m00002', key: 'ticket', name: 'Ticket', type: 'relation', relation: { table: THREADS.id } },
    { id: 'fld_m00003', key: 'labels', name: 'Labels', type: 'text' },
] };
const MODEL = { modelVersion: 1, tables: [THREADS, MESSAGES], roles: [], roleMapping: { default: 'app', byGroup: {} } };
const CONNECTOR = {
    id: 'conn_ab12cd', kind: 'mailbox', provider: 'outlook', groupIntoThreads: true,
    sync: {
        tableId: THREADS.id, mode: 'upsert', keyField: 'thread_key', incremental: { field: 'last_message_at', format: 'iso' },
        children: [{ tableId: MESSAGES.id, level: 1, relationField: 'ticket', mode: 'upsert', keyField: 'provider_message_id' }],
    },
};

function openDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const tableKeyById = new Map(MODEL.tables.map((t) => [t.id, t.key]));
    for (const t of MODEL.tables) db.exec(dataModel.ddlForTable(t, { tableKeyById, dialect: 'sqlite' }));
    return db;
}
const ins = (db, table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
};
const labelsOf = (db, id) => db.prepare('SELECT labels FROM threads WHERE id = ?').get(id).labels;

function depsOver(db) {
    const writes = [];
    return {
        writes,
        deps: {
            query: async (_o, _a, sql, params) => ({ rows: db.prepare(sql).all(...params) }),
            writeRecord: async (_a, _m, table, values, { recordId }) => {
                writes.push({ table: table.name, recordId, values });
                const cols = Object.keys(values);
                db.prepare(`UPDATE "${table.name.toLowerCase()}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`).run(...Object.values(values), recordId);
                return { changes: 1 };
            },
        },
    };
}

test('a thread with messages "Daniel" and "" gets "Daniel"', async () => {
    const db = openDb();
    ins(db, 'threads', { id: 't1', thread_key: 'T1', labels: null });
    ins(db, 'messages', { id: 'm1', provider_message_id: 'a', ticket: 't1', labels: 'Daniel' });
    ins(db, 'messages', { id: 'm2', provider_message_id: 'b', ticket: 't1', labels: '' });
    const { deps } = depsOver(db);
    assert.equal(await refreshThreadLabels(app, MODEL, CONNECTOR, ['t1'], deps), 1);
    assert.equal(labelsOf(db, 't1'), 'Daniel');
});

test('a thread the run only partly held still gets the union of ALL its stored messages', async () => {
    const db = openDb();
    ins(db, 'threads', { id: 't1', thread_key: 'T1', labels: '' });
    ins(db, 'messages', { id: 'm1', provider_message_id: 'old', ticket: 't1', labels: 'Urgent' });   // not in this run
    ins(db, 'messages', { id: 'm2', provider_message_id: 'new', ticket: 't1', labels: 'daniel, urgent' });
    const { deps } = depsOver(db);
    await refreshThreadLabels(app, MODEL, CONNECTOR, ['t1'], deps);
    assert.equal(labelsOf(db, 't1'), 'Urgent,daniel', 'each once, first spelling, message-id order');
});

test('a category taken off in Outlook leaves the thread too', async () => {
    const db = openDb();
    ins(db, 'threads', { id: 't1', thread_key: 'T1', labels: 'Daniel' });
    ins(db, 'messages', { id: 'm1', provider_message_id: 'a', ticket: 't1', labels: '' });
    const { deps } = depsOver(db);
    await refreshThreadLabels(app, MODEL, CONNECTOR, ['t1'], deps);
    assert.equal(labelsOf(db, 't1'), '');
});

test('backfill: conversations never computed (NULL) are filled from their messages, even when the run did not touch them', async () => {
    const db = openDb();
    for (const [id, label] of [['t1', 'Daniel'], ['t2', ''], ['t3', 'Kees']]) {
        ins(db, 'threads', { id, thread_key: id.toUpperCase(), labels: null });
        ins(db, 'messages', { id: `m_${id}`, provider_message_id: id, ticket: id, labels: label });
    }
    const { deps } = depsOver(db);
    assert.equal(await refreshThreadLabels(app, MODEL, CONNECTOR, [], deps), 3);
    assert.deepEqual(['t1', 't2', 't3'].map((id) => labelsOf(db, id)), ['Daniel', '', 'Kees']);
    // '' is "computed, no categories": the next run picks nothing up again.
    assert.equal(await refreshThreadLabels(app, MODEL, CONNECTOR, [], deps), 0);
});

test('only a change is written: same labels, no update; a labels-only change, an update', async () => {
    const db = openDb();
    ins(db, 'threads', { id: 't1', thread_key: 'T1', labels: 'Daniel' });
    ins(db, 'messages', { id: 'm1', provider_message_id: 'a', ticket: 't1', labels: 'Daniel' });
    const { deps, writes } = depsOver(db);
    assert.equal(await refreshThreadLabels(app, MODEL, CONNECTOR, ['t1'], deps), 0);
    assert.equal(writes.length, 0);
    db.prepare("UPDATE messages SET labels = 'Daniel,Urgent' WHERE id = 'm1'").run();
    assert.equal(await refreshThreadLabels(app, MODEL, CONNECTOR, ['t1'], deps), 1);
    assert.deepEqual(writes, [{ table: 'Threads', recordId: 't1', values: { labels: 'Daniel,Urgent' } }]);
});

test('Gmail, flat mode or a table without a labels column: nothing to do', () => {
    assert.equal(threadLabelTargets(MODEL, { ...CONNECTOR, provider: 'gmail' }), null);
    assert.equal(threadLabelTargets(MODEL, { ...CONNECTOR, groupIntoThreads: false }), null);
    const noColumn = { ...MODEL, tables: [{ ...THREADS, fields: THREADS.fields.slice(0, 2) }, MESSAGES] };
    assert.equal(threadLabelTargets(noColumn, CONNECTOR), null);
    assert.equal(unionLabels(['a, b', null, 'B,c', '']), 'a,b,c');
});

test('a failing query is a warning, never a failed sync', async () => {
    const r = await refreshThreadLabels(app, MODEL, CONNECTOR, ['t1'], { query: async () => { throw new Error('db down'); }, writeRecord: async () => {} });
    assert.equal(r, 0);
});

test('regression: a conversation below the watermark is written, and its messages keep THEIR conversation', async () => {
    // The client-tier filter used to drop grain-0 rows at or below the watermark while the child
    // rows kept their positions into the unfiltered list: the old conversation's message was linked
    // to the next conversation, and the new one's message lost its link.
    const existing = new Map([['OLD', 'rec_old'], ['NEW', 'rec_new'], ['m-old', 'rec_mold'], ['m-new', 'rec_mnew']]);
    const writes = [];
    await connectorSync.syncConnector(app, MODEL, CONNECTOR, { _deps: {
        ensureLabelColumns: async (_a, m) => m,
        adoptRecordedReplies: async () => {},
        refreshThreadLabels: async () => 0,
        runConnector: async () => ({ grains: [
            { level: 0, rows: [{ thread_key: 'OLD', last_message_at: '2026-11-03T08:00:00Z' }, { thread_key: 'NEW', last_message_at: '2026-11-03T09:05:00Z' }] },
            { level: 1, rows: [{ provider_message_id: 'm-old', _parentIndex: 0 }, { provider_message_id: 'm-new', _parentIndex: 1 }] },
        ] }),
        claimSync: async () => ({ watermark: '2026-11-03T09:00:00.000Z', lastRunAt: 'x' }),
        finishSync: async () => {},
        compileKeyIndex: (_t, _k, keys) => ({ sql: 'S', params: keys }),
        query: async (_o, _a, _s, keys) => ({ rows: (keys || []).filter((k) => existing.has(k)).map((k) => ({ id: existing.get(k), k })) }),
        writeRecord: async (_a, _m, table, values, o) => { writes.push([table.name, o.recordId, values]); return { changes: 1 }; },
        writeRecordBatch: async () => [],
        setRowCount: async () => {},
        bumpDataVersion: async () => {},
        batch: async () => [],
    } });
    const byRecord = new Map(writes.map(([, id, values]) => [id, values]));
    assert.ok(byRecord.has('rec_old'), 'the conversation below the watermark is written too');
    assert.equal(byRecord.get('rec_mold').ticket, 'rec_old');
    assert.equal(byRecord.get('rec_mnew').ticket, 'rec_new');
});
