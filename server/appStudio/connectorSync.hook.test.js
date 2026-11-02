'use strict';

/**
 * The mailbox "new record" hook as the sync drives it: the rows a sync INSERTED (not the ones
 * it updated) go to mailboxNewRecordHook.mts, once the claim is released, and the hook's
 * failure never fails the sync. The runner itself is in mailboxNewRecordHook.test.js.
 *
 * Run: cd server && node --test appStudio/connectorSync.hook.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const connectorSync = require('./connectorSync');

const app = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };
const THREADS = { id: 'tbl_aaaaaa', key: 'threads', name: 'Threads', fields: [
    { id: 'fld_1', key: 'ext_id', name: 'id', type: 'text', unique: true, sourcePath: 'id' },
    { id: 'fld_2', key: 'subject', name: 'subject', type: 'text', sourcePath: 'subject' },
] };
const MESSAGES = { id: 'tbl_bbbbbb', key: 'messages', name: 'Messages', fields: [
    { id: 'fld_3', key: 'thread', name: 'Thread', type: 'relation', relation: { table: THREADS.id } },
    { id: 'fld_4', key: 'ext_id', name: 'id', type: 'text', unique: true, sourcePath: 'id' },
    { id: 'fld_5', key: 'direction', name: 'direction', type: 'text', sourcePath: 'direction' },
] };
const MODEL = { modelVersion: 1, tables: [THREADS, MESSAGES], roles: [], roleMapping: { default: 'app', byGroup: {} } };
const HOOK = { actionId: 'act_hook', target: 'inbound_message' };

function mailbox(extra = {}) {
    return {
        id: 'conn_ab12cd', kind: 'mailbox', name: 'Desk', groupIntoThreads: true,
        sync: { tableId: THREADS.id, mode: 'upsert', keyField: 'id',
            children: [{ tableId: MESSAGES.id, level: 1, parentLevel: 0, relationField: 'thread', mode: 'upsert', keyField: 'id' }] },
        ...extra,
    };
}

const RUN = { rows: [], grains: [
    { level: 0, rows: [{ id: 't1', subject: 'A' }, { id: 't2', subject: 'B' }] },
    { level: 1, parentLevel: 0, rows: [
        { id: 'm1', direction: 'inbound', _parentIndex: 0 },
        { id: 'm2', direction: 'outbound', _parentIndex: 1 },
    ] },
] };

/** A sync with the fake store: `existing` keys are updates, anything else an insert. */
function harness(run, existing = []) {
    const log = { finish: null, order: [] };
    let next = 0;
    const store = new Map(existing.map((k) => [k, `rec_old_${k}`]));
    const _deps = {
        runConnector: async () => run,
        claimSync: async () => ({ watermark: null }),
        finishSync: async (_a, _c, payload) => { log.order.push('finish'); log.finish = payload; },
        compileKeyIndex: (_t, _k, keys) => ({ sql: 'SELECT', params: keys }),
        query: async (_o, _a, _s, keys) => ({ rows: (keys || []).filter((k) => store.has(String(k))).map((k) => ({ id: store.get(String(k)), k })) }),
        exec: async () => ({ changes: 0 }),
        writeRecordBatch: async (_a, _m, _t, rows) => rows.map(() => `rec_${next++}`),
        writeRecord: async (_a, _m, _t, _v, opts) => ({ id: opts.recordId, changes: 1 }),
        compileDeleteOlderThan: () => ({ sql: 'DELETE', params: [], where: '1=1', whereParams: [] }),
        setRowCount: async () => {},
        bumpDataVersion: async () => {},
        adoptRecordedReplies: async () => {},
    };
    return { log, _deps };
}

test('hook: the inserted conversations and messages are handed over, after finishSync', async () => {
    const h = harness(RUN, ['t2']);
    let seen;
    h._deps.runNewRecordHook = async (appArg, _model, conn, news) => { h.log.order.push('hook'); seen = { appArg, conn, news }; return { ran: 1, failed: 0, refused: 0, skippedLimit: 0 }; };

    const res = await connectorSync.syncConnector(app, MODEL, mailbox({ onNewRecord: HOOK }), { _deps: h._deps });

    assert.deepEqual(h.log.order, ['finish', 'hook']);
    assert.equal(seen.appArg, app);
    assert.deepEqual(seen.news.thread.map((r) => r.values.ext_id), ['t1'], 't2 existed: an update, not new');
    assert.deepEqual(seen.news.message.map((r) => [r.values.ext_id, r.values.direction]), [['m1', 'inbound'], ['m2', 'outbound']]);
    assert.ok(seen.news.message.every((r) => /^rec_/.test(r.id)));
    assert.deepEqual(res.hook, { ran: 1, failed: 0, refused: 0, skippedLimit: 0 });
});

test('hook: a flat mailbox hands over its messages; other kinds and an unset hook never ask', async () => {
    const flat = (extra = {}) => ({ id: 'conn_ab12cd', kind: 'mailbox', name: 'Flat', sync: { tableId: MESSAGES.id, mode: 'upsert', keyField: 'id' }, ...extra });
    const h = harness({ rows: [{ id: 'm1', direction: 'inbound' }] });
    const calls = [];
    h._deps.runNewRecordHook = async (_a, _m, _c, news) => { calls.push(news); return null; };

    await connectorSync.syncConnector(app, MODEL, flat({ onNewRecord: HOOK }), { _deps: h._deps });
    assert.deepEqual(calls[0].thread, []);
    assert.deepEqual(calls[0].message.map((r) => r.values.ext_id), ['m1']);

    calls.length = 0;
    await connectorSync.syncConnector(app, MODEL, flat(), { _deps: h._deps });
    await connectorSync.syncConnector(app, MODEL, flat({ kind: 'rest', onNewRecord: HOOK }), { _deps: h._deps });
    assert.equal(calls.length, 0);
});

test('hook: a hook that rejects does not fail the sync', async () => {
    const h = harness(RUN);
    h._deps.runNewRecordHook = async () => { throw new Error('hook down'); };
    const res = await connectorSync.syncConnector(app, MODEL, mailbox({ onNewRecord: HOOK }), { _deps: h._deps });
    assert.equal(res.inserted, 4);
    assert.equal(h.log.finish.status, 'ok');
});
