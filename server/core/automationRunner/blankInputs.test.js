/**
 * The preflight that keeps a live write from going out with a hole in it, one
 * block per executor family, plus the whole path through dispatchStep.
 * `engine.exec*` are spies: a case that must pass asserts the executor ran.
 *
 * Run: node --test core/automationRunner/blankInputs.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeLeafRunner } = require('./stepLeaf');
const { makeStepDispatcher } = require('./stepDispatch');
const { withBindingLog } = require('../automationModel/bind');
const { execForEachStep } = require('./execFlow');

const calls = [];
const spy = (name) => async (step) => { calls.push(name + ':' + step.id); return { output: { sent: true } }; };
const engine = {};
for (const n of ['execNotification', 'execHttpRequest', 'execGenerateDocument', 'execFillDocument', 'execPresentation', 'execSlide']) {
    engine[n] = spy(n);
}
const leaf = makeLeafRunner({ engine, execFlatten: async () => ({}) }, () => null);

const state = () => ({
    steps: { ev: { output: { summary: 'Standup' } } },
    trigger: { output: {} },
    _templateWarnings: [],
});
const BAD = '{{steps.ev.output.event.summary}}';
const OK = '{{steps.ev.output.summary}}';

/** The step is stopped before its executor, with the class and the path. */
async function blocked(step, mode = 'live') {
    calls.length = 0;
    await assert.rejects(() => leaf(step, {}, state(), mode), (e) => {
        assert.equal(e.errorClass, 'binding_unresolved');
        assert.match(e.message, /Nothing was sent/);
        assert.match(e.message, /steps\.ev\.output\.event\.summary/);
        return true;
    });
    assert.deepEqual(calls, [], 'the executor must not run');
}

/** The step reaches its executor. */
async function passes(step, mode = 'live') {
    calls.length = 0;
    await leaf(step, {}, state(), mode);
    assert.equal(calls.length, 1, 'the executor must run');
}

test('notification: title and body', async () => {
    await blocked({ type: 'notification', id: 'n', title: 't', body: `created: ${BAD}` });
    await blocked({ type: 'notification', id: 'n', title: BAD, body: 'b' });
    await passes({ type: 'notification', id: 'n', title: 't', body: `created: ${OK}` });
});

test('http_request: url and header always, body only for a write method', async () => {
    await blocked({ type: 'http_request', id: 'h', url: `https://example.test/${BAD}` });
    await blocked({ type: 'http_request', id: 'h', url: 'https://example.test', headers: { 'X-Name': BAD } });
    await blocked({ type: 'http_request', id: 'h', method: 'POST', url: 'https://example.test', body: `{"a":"${BAD}"}` });
    await passes({ type: 'http_request', id: 'h', method: 'GET', url: 'https://example.test', body: BAD });
    await passes({ type: 'http_request', id: 'h', method: 'POST', url: 'https://example.test', body: `{"a":"${OK}"}` });
});

test('http_request: an optional query item is dropped by design and not checked', async () => {
    const query = { mode: 'fields', items: [{ key: 'q', value: BAD }] };
    await passes({ type: 'http_request', id: 'h', url: 'https://example.test', query });
});

test('generate_document: title and content', async () => {
    await blocked({ type: 'generate_document', id: 'g', title: 'T', content: `Hello ${BAD}` });
    await passes({ type: 'generate_document', id: 'g', title: 'T', content: `Hello ${OK}` });
});

test('fill_document and presentation: copyName only when a copy is saved', async () => {
    await blocked({ type: 'fill_document', id: 'f', documentId: 'd', saveCopy: true, copyName: BAD });
    await passes({ type: 'fill_document', id: 'f', documentId: 'd', copyName: BAD });
    await blocked({ type: 'presentation', id: 'p', title: BAD });
    await blocked({ type: 'presentation', id: 'p', title: 't', saveCopy: true, copyName: BAD });
    await passes({ type: 'presentation', id: 'p', title: 't', copyName: BAD });
});

test('slide, knowledge_write and file names are not checked', async () => {
    await passes({ type: 'slide', id: 's', title: 'x', content: BAD });
    await passes({ type: 'generate_document', id: 'g', title: 'T', content: 'c', fileName: BAD });
});

test('only a step that ran blocks: not_run joins and optional trigger keys stay warnings', async () => {
    await passes({ type: 'notification', id: 'n', title: 't', body: '{{steps.skipped.output.x}}' });
    await passes({ type: 'notification', id: 'n', title: 't', body: 'hi {{trigger.output.nickname}}' });
    await passes({ type: 'notification', id: 'n', title: 't', body: 'hi {{loop.item.nickname}}' });
});

test('a dry run is never stopped', async () => {
    await passes({ type: 'notification', id: 'n', title: 't', body: BAD }, 'dry_run');
});

test('a failed preflight leaves its misses in the step log', async () => {
    const log = [];
    const step = { type: 'notification', id: 'n', title: 't', body: BAD };
    await withBindingLog(log, () => assert.rejects(() => leaf(step, {}, state(), 'live')));
    assert.ok(log.some(m => m.kind === 'template' && m.path === 'steps.ev.output.event.summary'));
});

test('a passing preflight adds nothing to the log or the run warnings', async () => {
    const s = state();
    const log = [];
    await withBindingLog(log, () => leaf({ type: 'notification', id: 'n', title: 't', body: `${OK} {{trigger.output.x}}` }, {}, s, 'live'));
    assert.deepEqual(log, []);
    assert.deepEqual(s._templateWarnings, []);
});

// ── through dispatchStep ────────────────────────────────────────────────────

function dispatcherFor(rows) {
    const deps = {
        isCancelRequested: async () => false,
        automationStore: { recordRunStep: async (row) => { rows.push(row); } },
        engine: { ...engine, execForEachStep, ApprovalRequiredError: class A extends Error {}, FormInputRequiredError: class F extends Error {}, secretValuesFor: () => [] },
        execFlatten: async () => ({}),
    };
    return makeStepDispatcher(deps, { run: { id: 'r1' }, cancelSignal: new AbortController().signal, runPolicy: { retry: { max: 2 } } });
}

test('dispatchStep: the step is recorded as an error with binding warnings, and is not retried', async () => {
    const rows = [];
    const dispatch = dispatcherFor(rows);
    const step = { type: 'notification', id: 'n', title: 't', body: BAD };
    calls.length = 0;
    await assert.rejects(() => dispatch(step, { runId: 'r1', _bindingMisses: [] }, state(), 'live'), (e) => e.errorClass === 'binding_unresolved');
    assert.deepEqual(calls, []);
    assert.equal(rows.length, 1, 'one error row, no retries');
    assert.equal(rows[0].status, 'error');
    assert.ok(rows[0].bindingWarnings && rows[0].bindingWarnings.length > 0);
});

test('dispatchStep: a forEach item that reads a missing field fails the step before any item is sent', async () => {
    const rows = [];
    const dispatch = dispatcherFor(rows);
    const step = {
        type: 'notification', id: 'n', title: 't', body: 'row: {{loop.item.name}} {{steps.ev.output.event.summary}}',
        forEach: { overRef: 'steps.ev.output.list', itemVar: 'item' },
    };
    const st = state();
    st.steps.ev.output.list = [{ name: 'a' }, { name: 'b' }];
    calls.length = 0;
    await assert.rejects(() => dispatch(step, { runId: 'r1', _bindingMisses: [] }, st, 'live'));
    assert.deepEqual(calls, []);
    assert.ok(rows.some(r => r.status === 'error'));
});
