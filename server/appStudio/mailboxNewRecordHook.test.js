'use strict';

/** Run: cd server && node --test appStudio/mailboxNewRecordHook.test.js */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { runNewRecordHook, resetHookWindows } = require('./mailboxNewRecordHook.mts');

const CONNECTOR = { id: 'conn_a', kind: 'mailbox', groupIntoThreads: true, onNewRecord: { actionId: 'act_hook', target: 'inbound_message' } };
const ACTION = { kind: 'sequence', steps: [
    { kind: 'ai_generate', resultVar: 'summary' },
    { kind: 'update_record', tableId: 'tbl_t' },
] };

let calls;
let recorded;
let appRow;
let limits;
let failOn;
let clock;

function deps(over = {}) {
    return {
        getApp: async () => appRow,
        executeStep: async (_app, _model, step, ctx) => {
            calls.push({ kind: step.kind, item: ctx.item, vars: ctx.vars, viewerId: ctx.viewerId, role: ctx.role });
            if (failOn && failOn === step.kind) return { ok: false, error: 'Step failed' };
            return { ok: true, result: step.kind === 'ai_generate' ? 'a summary' : null };
        },
        evaluate: (expr) => expr === 'yes',
        buildScope: (ctx) => ctx,
        record: async (entry) => { recorded.push(entry); },
        log: { info() {}, warn() {}, error() {} },
        limits: () => limits,
        now: () => clock,
        ...over,
    };
}

const msg = (id, direction) => ({ id, values: { subject: 's', direction } });

beforeEach(() => {
    calls = []; recorded = []; failOn = null; clock = 1_000_000;
    limits = { perSync: 50, perMinute: 60 };
    appRow = { id: 'app_1', userId: 'owner_1', name: 'Desk', organizationId: 'org_1', definition: { actions: { act_hook: ACTION } }, publishedDefinition: null };
    resetHookWindows();
});

test('an inbound message runs the action as the owner with the row as item, and passes resultVar on', async () => {
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound'), msg('r2', 'outbound')] }, deps());
    assert.deepEqual(report, { ran: 1, failed: 0, refused: 0, skippedLimit: 0 });
    assert.deepEqual(calls.map((c) => c.kind), ['ai_generate', 'update_record']);
    assert.equal(calls[0].item.id, 'r1');
    assert.equal(calls[0].item.subject, 's');
    assert.equal(calls[0].viewerId, 'owner_1');
    assert.equal(calls[0].role, 'owner');
    assert.deepEqual(calls[1].vars, { summary: 'a summary' });
    assert.deepEqual(recorded.map((r) => [r.recordId, r.status, r.steps]), [['r1', 'ok', 2]]);
});

test('target thread acts on new conversations only', async () => {
    const connector = { ...CONNECTOR, onNewRecord: { actionId: 'act_hook', target: 'thread' } };
    await runNewRecordHook({ id: 'app_1' }, {}, connector, { thread: [{ id: 't1', values: { subject: 'x' } }], message: [msg('r1', 'inbound')] }, deps());
    assert.deepEqual(calls.map((c) => c.item.id), ['t1', 't1']);
});

test('no hook, no new row or no app: nothing happens', async () => {
    const news = { thread: [], message: [msg('r1', 'inbound')] };
    assert.equal(await runNewRecordHook({ id: 'app_1' }, {}, { ...CONNECTOR, onNewRecord: undefined }, news, deps()), null);
    assert.equal(await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'outbound')] }, deps()), null);
    assert.equal(await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, news, deps({ getApp: async () => null })), null);
    assert.equal(calls.length, 0);
});

test('an action with send_email is refused at run time, whatever the connector says', async () => {
    appRow.definition = { actions: { act_hook: { kind: 'sequence', steps: [{ kind: 'ai_generate' }, { kind: 'send_email' }] } } };
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps());
    assert.equal(report.refused, 1);
    assert.equal(calls.length, 0, 'not even the allowed steps run');
    assert.equal(recorded[0].status, 'refused');
    assert.match(recorded[0].error, /send_email/);
});

test('the published copy wins over the draft', async () => {
    appRow.publishedDefinition = { actions: { act_hook: { kind: 'sequence', steps: [{ kind: 'update_record' }] } } };
    await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps());
    assert.deepEqual(calls.map((c) => c.kind), ['update_record']);
});

test('a failing step stops that run, is recorded, and the next row still runs', async () => {
    failOn = 'ai_generate';
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound'), msg('r2', 'inbound')] }, deps());
    assert.deepEqual(report, { ran: 0, failed: 2, refused: 0, skippedLimit: 0 });
    assert.deepEqual(calls.map((c) => c.item.id), ['r1', 'r2'], 'update_record never ran');
    assert.deepEqual(recorded.map((r) => r.status), ['failed', 'failed']);
});

test('a throwing executor is a failed run, not a rejection', async () => {
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] },
        deps({ executeStep: async () => { throw new Error('boom'); } }));
    assert.equal(report.failed, 1);
    assert.match(recorded[0].error, /boom/);
});

test('the per-sync cap leaves the rest unprocessed and says so in the log', async () => {
    limits = { perSync: 2, perMinute: 0 };
    const rows = [1, 2, 3, 4].map((n) => msg(`r${n}`, 'inbound'));
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: rows }, deps());
    assert.deepEqual(report, { ran: 2, failed: 0, refused: 0, skippedLimit: 2 });
    assert.deepEqual(recorded.map((r) => r.status), ['ok', 'ok', 'skipped_limit', 'skipped_limit']);
});

test('the per-minute cap counts across syncs and forgets after a minute', async () => {
    limits = { perSync: 0, perMinute: 3 };
    const news = (n) => ({ thread: [], message: [msg(`r${n}`, 'inbound'), msg(`s${n}`, 'inbound')] });
    assert.equal((await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, news(1), deps())).ran, 2);
    const second = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, news(2), deps());
    assert.deepEqual([second.ran, second.skippedLimit], [1, 1]);
    clock += 61_000;
    assert.equal((await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, news(3), deps())).ran, 2);
});

test('0 means unlimited', async () => {
    limits = { perSync: 0, perMinute: 0 };
    const rows = Array.from({ length: 120 }, (_, n) => msg(`r${n}`, 'inbound'));
    assert.equal((await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: rows }, deps())).ran, 120);
});

test('condition and switch pick their branch', async () => {
    appRow.definition = { actions: { act_hook: { kind: 'sequence', steps: [
        { kind: 'condition', expr: 'yes', then: [{ kind: 'create_record' }], else: [{ kind: 'update_record' }] },
        { kind: 'switch', expr: 'no', cases: [{ value: 'a', steps: [{ kind: 'ai_extract' }] }], default: [{ kind: 'kb_query' }] },
    ] } } };
    await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps());
    assert.deepEqual(calls.map((c) => c.kind), ['create_record', 'kb_query']);
});

test('it never rejects, even when the app lookup does', async () => {
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] },
        deps({ getApp: async () => { throw new Error('db down'); } }));
    assert.equal(report, null);
});
