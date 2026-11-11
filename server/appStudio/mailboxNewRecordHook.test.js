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

// ── Error handling on the shared walker (package 2) ─────────────────────────

test('a failing step with onError runs its handler with error in scope, and the run is ok', async () => {
    failOn = 'ai_generate';
    appRow.definition.actions.act_hook = { kind: 'sequence', steps: [
        { kind: 'ai_generate', resultVar: 'summary', onError: { steps: [{ kind: 'create_record', tableId: 'tbl_log' }] } },
        { kind: 'update_record', tableId: 'tbl_t' },
    ] };
    const seen = [];
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps({
        executeStep: async (_app, _model, step, ctx) => {
            seen.push({ kind: step.kind, error: ctx.error ?? null });
            return step.kind === 'ai_generate' ? { ok: false, error: 'The AI provider had a temporary problem. Try again.', retryable: true } : { ok: true, result: null };
        },
    }));
    assert.deepEqual(report, { ran: 1, failed: 0, refused: 0, skippedLimit: 0 });
    assert.deepEqual(seen.map((s) => s.kind), ['ai_generate', 'create_record', 'update_record']);
    assert.equal(seen[1].error.message, 'The AI provider had a temporary problem. Try again.');
    assert.equal(seen[1].error.step, 'ai_generate');
    assert.equal(seen[2].error, null, 'outside the handler there is no error scope');
});

test('retry on the hook: the step is tried again and the wait goes through deps.sleep', async () => {
    let n = 0;
    const waits = [];
    appRow.definition.actions.act_hook = { kind: 'sequence', steps: [{ kind: 'ai_generate', retry: { times: 1, delayMs: 50 } }] };
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps({
        executeStep: async () => (++n === 1 ? { ok: false, error: 'busy', retryable: true } : { ok: true, result: 'x' }),
        sleep: async (ms) => { waits.push(ms); },
    }));
    assert.equal(report.ran, 1);
    assert.deepEqual(waits, [50]);
    assert.equal(recorded[0].steps, 2, 'both attempts are counted');
});

test('a delete_record inside a transaction and a send_email inside a handler are refused', async () => {
    appRow.definition.actions.act_hook = { kind: 'sequence', steps: [
        { kind: 'transaction', steps: [{ kind: 'create_record', tableId: 'a' }, { kind: 'delete_record', tableId: 'a' }] },
    ] };
    const tx = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps());
    assert.equal(tx.refused, 1);
    assert.match(recorded[0].error, /"delete_record" step/);
    recorded.length = 0;
    appRow.definition.actions.act_hook = { kind: 'sequence', steps: [
        { kind: 'ai_generate', onError: { steps: [{ kind: 'send_email', connectorId: 'c' }] } },
    ] };
    const mail = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r2', 'inbound')] }, deps());
    assert.equal(mail.refused, 1);
    assert.match(recorded[0].error, /send_email/);
    assert.equal(calls.length, 0, 'nothing ran');
});

test('a transaction of record writes may run on an arriving mail', async () => {
    appRow.definition.actions.act_hook = { kind: 'sequence', steps: [{ kind: 'transaction', steps: [{ kind: 'create_record', tableId: 'a' }, { kind: 'update_record', tableId: 'a' }] }] };
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps());
    assert.equal(report.ran, 1);
    assert.deepEqual(calls.map((c) => c.kind), ['transaction'], 'one server step');
});

test('a step after a transaction reads the resultVar of a child as vars.<name>', async () => {
    appRow.definition.actions.act_hook = { kind: 'sequence', steps: [
        { kind: 'transaction', steps: [{ kind: 'create_record', tableId: 'a', resultVar: 'order' }] },
        { kind: 'update_record', tableId: 'a' },
    ] };
    const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps({
        executeStep: async (_app, _model, step, ctx) => {
            calls.push({ kind: step.kind, vars: ctx.vars });
            return step.kind === 'transaction' ? { ok: true, result: { results: [], vars: { order: { id: 'rec_9' } }, count: 1 } } : { ok: true, result: null };
        },
    }));
    assert.equal(report.ran, 1);
    assert.deepEqual(calls.map((c) => c.kind), ['transaction', 'update_record']);
    assert.equal(calls[1].vars.order.id, 'rec_9');
});

test('raise_error fails the run with its own message, a try catches it, and return ends the run early', async () => {
    const raise = { kind: 'raise_error', message: { kind: 'static', value: 'No subject on this mail' }, code: 'no_subject' };
    appRow.definition = { actions: { act_hook: { kind: 'sequence', steps: [raise, { kind: 'update_record' }] } } };
    let report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps());
    assert.equal(report.failed, 1);
    assert.equal(recorded[0].error, 'No subject on this mail');
    assert.equal(calls.length, 0);

    calls = []; recorded = [];
    appRow.definition = { actions: { act_hook: { kind: 'sequence', steps: [
        { kind: 'try', steps: [raise], catch: [{ kind: 'ai_generate' }] },
        { kind: 'return', value: { kind: 'static', value: 'done' } },
        { kind: 'update_record' },
    ] } } };
    report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r2', 'inbound')] }, deps());
    assert.deepEqual(report, { ran: 1, failed: 0, refused: 0, skippedLimit: 0 });
    assert.deepEqual(calls.map((c) => c.kind), ['ai_generate'], 'the step after the return never ran');
});

test('a while and a parallel step are refused on an arriving mail', async () => {
    for (const step of [{ kind: 'while', expr: 'yes', steps: [] }, { kind: 'parallel', branches: [{ steps: [{ kind: 'ai_generate' }] }] }]) {
        calls = []; recorded = [];
        appRow.definition = { actions: { act_hook: { kind: 'sequence', steps: [step] } } };
        const report = await runNewRecordHook({ id: 'app_1' }, {}, CONNECTOR, { thread: [], message: [msg('r1', 'inbound')] }, deps());
        assert.equal(report.refused, 1, step.kind);
        assert.equal(calls.length, 0);
    }
});
