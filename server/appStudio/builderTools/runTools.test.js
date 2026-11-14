'use strict';

/**
 * The in-product run and test tools (runTools.mts, builderTools/tools/app_run_action.js and its
 * four siblings): a dry run only, on the builder's own draft, owner only for a run, answers that
 * fit the builder's tool-result limit. The MCP walker, host and test runner are the real ones;
 * only the app lookup, the executor, the stores and the audit are injected.
 *
 * Run: cd server && node --test appStudio/builderTools/runTools.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const T = require('./runTools.mts');
const { fitToolResult, BUILDER_TOOL_RESULT_CHARS } = require('./resultFit.mts');
const { defaultDeps, resetRunWindows } = require('../mcpRunAction.mts');
const { truncateJson } = require('../../usecases/ai/appStudioBuilder/turnLoop');

const OWNER = 'usr_owner';
const EDITOR = 'usr_editor';
const WRITES = new Set(['send_email', 'create_record', 'update_record', 'delete_record', 'run_automation', 'generate_file']);

let app;
let calls;

/** A test store of saved action tests, in memory. */
function memoryTestStore() {
    const rows = [];
    const match = (appId, f = {}) => rows.filter((r) => r.appId === appId && (!f.actionIds || f.actionIds.includes(r.actionId)) && (!f.names || f.names.includes(r.name)));
    return {
        listActionTests: async (appId, f) => match(appId, f),
        countActionTests: async (appId) => match(appId).length,
        deleteActionTest: async (appId, actionId, name) => { const i = rows.findIndex((r) => r.appId === appId && r.actionId === actionId && r.name === name); if (i >= 0) rows.splice(i, 1); return i >= 0; },
        upsertActionTest: async (appId, t) => { const row = { id: `sat_${rows.length + 1}`, appId, lastStatus: null, ...t }; rows.push(row); return { test: row, created: true }; },
        recordTestStatuses: async (_appId, list) => { for (const s of list) rows.find((r) => r.id === s.id).lastStatus = s.status; },
    };
}

function deps({ runLog } = {}) {
    const run = {
        ...defaultDeps(),
        getApp: async (id) => { calls.getApp += 1; return id === app.id ? app : null; },
        canWrite: (_a, userId) => userId === OWNER || userId === EDITOR,
        getDataModel: async () => ({ model: { tables: [] } }),
        executeStep: async (_a, _m, step) => {
            if (WRITES.has(step.kind)) throw new Error(`a dry run reached ${step.kind}`);
            calls.executed.push(step.kind);
            return { ok: true, result: { text: 'x'.repeat(2900) } };
        },
        readData: async () => null,
        takeBudget: () => true,
        audit: async (entry) => { calls.audits.push(entry); },
        runLog: undefined,
        limits: () => ({ perMinute: 100, freePerMinute: 100 }),
    };
    return { run, tests: { run, store: () => calls.store, audit: async (event) => { calls.audits.push(event); } }, runLog };
}

const draft = (over = {}) => ({ userId: OWNER, appId: app.id, version: app.definitionVersion, def: app.definition, ...over });
const withActions = (actions) => { app.definition = { actions }; };

const STATIC = (value) => ({ kind: 'static', value });
const SEND = { kind: 'send_email', connectorId: 'conn_a', to: STATIC('a@example.com'), subject: STATIC('Hi'), body: STATIC('Body') };
const EVERY_WRITE = { kind: 'sequence', steps: [
    SEND,
    { kind: 'create_record', tableId: 'tbl_a', values: { name: STATIC('n') } },
    { kind: 'update_record', tableId: 'tbl_a', recordId: STATIC('rec_1'), values: { name: STATIC('m') } },
    { kind: 'delete_record', tableId: 'tbl_a', recordId: STATIC('rec_1') },
    { kind: 'condition', expr: 'true', then: [SEND, { kind: 'create_record', tableId: 'tbl_a', values: {} }] },
    { kind: 'loop', source: STATIC([1, 2]), steps: [{ kind: 'create_record', tableId: 'tbl_a', values: {} }] },
    { kind: 'ai_generate', prompt: 'Sum up', resultVar: 'summary' },
] };

beforeEach(() => {
    app = { id: 'app_1', userId: OWNER, name: 'Desk', organizationId: 'org_1', definitionVersion: 4, definition: {} };
    calls = { getApp: 0, executed: [], audits: [], store: memoryTestStore() };
    resetRunWindows();
});

test('a live run is refused before anything is read, in every spelling', async () => {
    for (const dryRun of [false, 'false', 0, null, 'no']) {
        const out = await T.builderRunAction(draft(), { actionId: 'act_1', dryRun }, deps());
        assert.match(out.error, /only does a dry run/, String(dryRun));
    }
    assert.equal(calls.getApp, 0);
    assert.equal(T.liveRunRefusal({ dryRun: true }), null);
    assert.equal(T.liveRunRefusal({}), null);
});

test('a dry run walks every write, branch and loop without sending mail or writing a row', async () => {
    withActions({ act_1: EVERY_WRITE });
    const out = await T.builderRunAction(draft(), { actionId: 'act_1', dryRun: true, appId: 'app_other' }, deps());
    assert.equal(out.error, undefined, out.error);
    assert.equal(out.dryRun, true);
    assert.deepEqual(calls.executed, ['ai_generate'], 'only the AI step reached the executor');
    const statuses = Object.fromEntries(out.steps.map((s) => [s.path, `${s.kind}:${s.status}`]));
    assert.equal(statuses['steps[0]'], 'send_email:skipped');
    assert.equal(statuses['steps[4].then[0]'], 'send_email:skipped');
    assert.equal(statuses['steps[5].steps[0]'], 'create_record:skipped');
    assert.ok(out.steps.find((s) => s.path === 'steps[0]').result.wouldSend);
    assert.equal(calls.audits[0].dryRun, true);
});

test('the run reads the draft app, pinned to the version the builder holds', async () => {
    withActions({ act_1: { kind: 'sequence', steps: [{ kind: 'toast', message: 'hi' }] } });
    assert.equal((await T.builderRunAction(draft(), { actionId: 'act_1' }, deps())).ok, true);
    const stale = await T.builderRunAction(draft({ version: 3 }), { actionId: 'act_1' }, deps());
    assert.match(stale.error, /version 4, not 3/);
});

test('only the owner runs; an unsaved app and a lost edit right are refused', async () => {
    withActions({ act_1: EVERY_WRITE });
    const editor = await T.builderRunAction(draft({ userId: EDITOR }), { actionId: 'act_1' }, deps());
    assert.match(editor.error, /only the owner can use it/);
    assert.match((await T.builderRunTests(draft({ userId: EDITOR }), {}, deps())).error, /only the owner/);
    assert.match((await T.builderRunAction(draft({ appId: null }), { actionId: 'act_1' }, deps())).error, /not saved yet/);
    assert.match((await T.builderListRuns(draft({ userId: 'usr_stranger' }), {}, deps())).error, /could not be read/);
    assert.deepEqual(calls.executed, []);
});

test('a saved test runs as a dry run and reports pass; an editor may save', async () => {
    withActions({ act_1: { kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'Sum up', resultVar: 'summary' }] } });
    const saved = await T.builderSaveTest(draft({ userId: EDITOR }), {
        actionId: 'act_1', name: 'summary is set', mock: { 'steps[0]': 'fixed' }, expect: [{ path: 'vars.summary.text', op: 'is', value: 'fixed' }],
    }, deps());
    assert.equal(saved.ok, true, saved.error);
    const ran = await T.builderRunTests(draft(), {}, deps());
    assert.equal(ran.summary.pass, 1, JSON.stringify(ran.tests));
    assert.deepEqual(calls.executed, [], 'the mocked step never reached the model');
    assert.deepEqual(calls.audits, ['studio_app_mcp_save_test', 'studio_app_mcp_run_tests']);
});

test('the default deps audit under the builder names', async (t) => {
    const userStore = require('../../stores/userStore');
    const events = [];
    t.mock.method(userStore, 'logAccessAudit', async (event) => { events.push(event); });
    const d = T.builderRunDeps();
    await d.run.audit({ dryRun: true }, app, OWNER);
    await d.tests.audit('studio_app_mcp_run_tests', {}, app, OWNER);
    assert.deepEqual(events, ['studio_app_builder_run_action_dry', 'studio_app_builder_run_tests']);
    assert.equal(d.tests.run, d.run, 'a test run uses the same run deps');
});

test('the run log reads the draft app only', async () => {
    const seen = [];
    const runLog = {
        getApp: async (id) => (id === app.id ? app : null), canWrite: () => true,
        store: () => ({ listRuns: async (f) => { seen.push(f.appId); return []; }, getLoggedRun: async () => null }),
        policy: { idleMs: 1, staleMs: 1, retentionDays: 30 },
    };
    const listed = await T.builderListRuns(draft(), { appId: 'app_other' }, deps({ runLog }));
    assert.deepEqual(listed.runs, []);
    assert.deepEqual(seen, ['app_1']);
    assert.match((await T.builderGetRun(draft(), { runId: `sar_${'a'.repeat(32)}` }, deps({ runLog }))).error, /no run/);
});

test('a long report fits the builder tool-result limit and says what it left out', async () => {
    withActions({ act_1: { kind: 'sequence', steps: Array.from({ length: 150 }, () => ({ kind: 'ai_generate', prompt: 'p' })) } });
    const out = await T.builderRunAction(draft(), { actionId: 'act_1' }, deps());
    assert.ok(JSON.stringify(out).length < BUILDER_TOOL_RESULT_CHARS);
    assert.ok(!truncateJson(out).includes('"_truncated":true'));
    assert.match(out._trimmed[0], /^steps: the first \d+ of 150$/);
    const small = { ok: true };
    assert.equal(fitToolResult(small), small, 'an answer that fits is returned as it is');
    assert.deepEqual(fitToolResult({ blob: { text: 'y'.repeat(500) } }, 100)._trimmed, ['blob: left out']);
});

test('the tools are on the full menu only; over MCP app_run_action is still the MCP tool, listed once', async () => {
    const { TOOL_SCHEMAS } = require('./schemas');
    const { selectToolMenu } = require('../builderModelProfiles');
    const names = ['app_run_action', 'app_save_test', 'app_run_tests', 'app_list_runs', 'app_get_run'];
    const full = selectToolMenu({ toolset: 'full' }, TOOL_SCHEMAS).map((t) => t.function.name);
    const core = selectToolMenu({ toolset: 'core' }, TOOL_SCHEMAS).map((t) => t.function.name);
    for (const name of names) assert.ok(full.includes(name) && !core.includes(name), name);
    const mine = TOOL_SCHEMAS.find((t) => t.function.name === 'app_run_action');
    assert.ok(!Object.hasOwn(mine.function.parameters.properties, 'dryRun'), 'the builder schema offers no live run');
    const listed = require('../mcpBuilder').buildToolList().filter((t) => names.includes(t.name));
    assert.equal(listed.length, names.length);
    assert.match(listed.find((t) => t.name === 'app_run_action').description, /With dryRun false/);
    const { applyToolCall } = require('../builderTools');
    assert.match((await applyToolCall('app_run_action', { actionId: 'act_1', dryRun: false }, draft())).error, /only does a dry run/);
});
