'use strict';

/**
 * app_save_test / app_run_tests end to end: the real walker, host, mocks, expectations and the
 * real store on PGlite; only the app lookup, the executor and the audit are injected.
 *
 * Run: cd server && node --test appStudio/actionTests/mcpActionTests.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeActionTestStore } = require('../../stores/studioApp/actionTests.mts');
const { saveTest, runTests } = require('./mcpActionTests.mts');
const { resetRunWindows, takeRunBudget } = require('../mcpRunAction.mts');

const OWNER = 'user_owner';
const EDITOR = 'user_editor';

const { pg, db } = pgliteDb();
const store = makeActionTestStore(db);

let appRow;
let executed;
let audits;
let budgetCalls;
let limits;

function deps() {
    return {
        run: {
            getApp: async (id) => (id === appRow.id ? appRow : null),
            canWrite: (_app, userId) => userId === OWNER || userId === EDITOR,
            getDataModel: async () => ({ model: { tables: [] } }),
            executeStep: async (_app, _model, step, ctx) => {
                executed.push({ step, ctx });
                return { ok: true, result: step.kind === 'ai_generate' ? { text: 'real model answer', citations: [] } : { rows: [], count: 0 } };
            },
            evaluate: (expr, scope) => require('../../shared/expr/index.mjs').tryEvaluate(expr, scope)?.value,
            buildScope: (ctx) => require('../actionExecutor/shared').buildServerScope(ctx),
            resolveBinding: (b, ctx, scope) => require('../actionExecutor/shared').resolveBinding(b, ctx, scope),
            readData: async () => null,
            takeBudget: (userId, now) => { budgetCalls += 1; return takeRunBudget(userId, now, 10); },
            audit: async () => {},
            log: { warn() {} },
            now: () => Date.now(),
            limits: () => limits,
        },
        store: () => store,
        audit: async (event, entry) => { audits.push({ event, entry }); },
    };
}

const EXTRACT_ACTION = (field = 'customer') => ({ kind: 'sequence', steps: [
    { kind: 'ai_extract', source: { kind: 'field', name: 'file' }, schema: [{ name: field, type: 'string' }], resultVar: 'ex' },
    { kind: 'set_variable', name: 'who', value: { kind: 'formula', expr: 'vars.ex.rows[0].customer' } },
] });
const CUSTOMER_TEST = {
    actionId: 'act_intake', name: 'customer is read',
    mock: { 'steps[0]': { rows: [{ customer: 'ACME' }] } },
    expect: [{ path: 'vars.who', op: 'is', value: 'ACME' }],
};

const save = (args, userId = OWNER) => saveTest({ appId: 'app_1', ...args }, userId, deps());
const runAll = (args = {}, userId = OWNER) => runTests({ appId: 'app_1', ...args }, userId, deps());
const setActions = (actions) => { appRow.definition = { actions }; appRow.definitionVersion += 1; };

before(async () => {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', 'stores', 'studioApp', 'schema.js'), 'utf8');
    const ddl = /`(\s*CREATE TABLE IF NOT EXISTS studio_app_action_tests[\s\S]*?)`/.exec(text)[1];
    await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
    await pg.exec(ddl);
    await pg.query("INSERT INTO studio_apps (id, user_id) VALUES ('app_1', $1)", [OWNER]);
});
after(async () => { await pg.close(); });

beforeEach(async () => {
    await pg.query('DELETE FROM studio_app_action_tests');
    appRow = { id: 'app_1', userId: OWNER, name: 'Desk', organizationId: 'org_1', definition: { actions: { act_intake: EXTRACT_ACTION() } }, definitionVersion: 1 };
    executed = []; audits = []; budgetCalls = 0;
    limits = { perMinute: 10, budgetMs: 60_000, maxExecuted: 500 };
    resetRunWindows();
});

test('a saved test with a mock fails when a prompt change empties the expected field', async () => {
    const saved = await save(CUSTOMER_TEST);
    assert.equal(saved.ok, true);
    assert.equal(saved.saved, 'created');
    assert.deepEqual(saved.test.mockPaths, ['steps[0]']);
    assert.deepEqual(saved.hints, []);

    const green = await runAll();
    assert.equal(green.ok, true);
    assert.equal(green.tests[0].status, 'pass');
    assert.equal(green.tests[0].free, true);
    assert.equal(executed.length, 0, 'the mocked AI step never reached the executor');

    // The schema field is renamed: the same model answer now coerces to { client: null }.
    setActions({ act_intake: EXTRACT_ACTION('client') });
    const red = await runAll();
    assert.equal(red.ok, false);
    assert.equal(red.definitionVersion, 2);
    const [t] = red.tests;
    assert.equal(t.status, 'fail');
    assert.equal(t.wasStatus, 'pass');
    assert.deepEqual(t.failures, [{ path: 'vars.who', op: 'is', expected: 'ACME', actual: null, pass: false }]);
    assert.ok(t.steps.some((s) => s.path === 'steps[0]' && s.mocked === true), 'a failing test carries its steps');
});

test('a prompt placeholder removed makes an expectation on the filled-in prompt fail', async () => {
    const action = (prompt) => ({ kind: 'sequence', steps: [{ kind: 'ai_generate', prompt, resultVar: 'summary' }] });
    setActions({ act_sum: action('Summarise {{vars.ticket}}') });
    await save({
        actionId: 'act_sum', name: 'prompt names the ticket', scope: { vars: { ticket: 'T-1' } },
        mock: { 'steps[0]': 'A summary' },
        expect: [{ path: 'steps[0].prompt', op: 'contains', value: 'T-1' }, { path: 'vars.summary.text', op: 'is', value: 'A summary' }],
    });
    assert.equal((await runAll()).tests[0].status, 'pass');
    setActions({ act_sum: action('Summarise the ticket') });
    const red = await runAll();
    assert.equal(red.tests[0].status, 'fail');
    assert.deepEqual(red.tests[0].failures.map((f) => [f.path, f.actual]), [['steps[0].prompt', 'Summarise the ticket']]);
});

test('save replaces by action + name; remove deletes; total counts the app\'s tests', async () => {
    assert.equal((await save(CUSTOMER_TEST)).saved, 'created');
    const again = await save({ ...CUSTOMER_TEST, expect: [{ path: 'vars.who', op: 'isNotEmpty' }] });
    assert.equal(again.saved, 'updated');
    assert.equal(again.total, 1);
    assert.equal(again.test.expectCount, 1);
    const removed = await save({ actionId: 'act_intake', name: 'customer is read', remove: true });
    assert.deepEqual(removed, { ok: true, removed: true, total: 0 });
    assert.equal((await save({ actionId: 'act_intake', name: 'customer is read', remove: true })).removed, false);
});

test('an editor may save a test but not run it; a stranger may do neither', async () => {
    assert.equal((await save(CUSTOMER_TEST, EDITOR)).ok, true);
    const run = await runAll({}, EDITOR);
    assert.match(run.error, /app_run_tests runs as the app owner/);
    assert.match((await save(CUSTOMER_TEST, 'stranger')).error, /not found, or this token's user cannot edit it/);
    assert.match((await runAll({}, 'stranger')).error, /not found/);
});

test('a test of a deleted action, or with a stale mock path, reports error with a fix hint', async () => {
    await save(CUSTOMER_TEST);
    setActions({ act_intake: { kind: 'sequence', steps: [{ kind: 'toast' }, { kind: 'ai_extract', schema: [{ name: 'customer' }] }] } });
    const stale = await runAll();
    assert.equal(stale.tests[0].status, 'error');
    assert.match(stale.tests[0].error, /no longer fits the action: .*not an AI or read step/);
    assert.match(stale.tests[0]._fixHint, /steps\[1\] \(ai_extract\)/);
    setActions({});
    const gone = await runAll();
    assert.equal(gone.tests[0].status, 'error');
    assert.match(gone.tests[0].error, /no action "act_intake"/);
    assert.equal(gone.tests[0].wasStatus, 'error', 'the error status was written back');
    assert.equal(gone.summary.error, 1);
});

test('save refuses a test for an unknown action, a bad expectation, or a stale mock key', async () => {
    assert.match((await save({ ...CUSTOMER_TEST, actionId: 'act_nope' })).error, /no action "act_nope"/);
    assert.match((await save({ ...CUSTOMER_TEST, expect: [{ path: 'steps[5].status', op: 'is', value: 'ok' }] })).error, /starts with neither/);
    assert.match((await save({ ...CUSTOMER_TEST, mock: { 'steps[1]': 'x' } })).error, /not an AI or read step/);
    assert.match((await save({ ...CUSTOMER_TEST, actionId: '../x' })).error, /actionId/);
});

test('the tests-per-app cap is named; replacing an existing test is still allowed at the cap', async () => {
    limits = { ...limits, testsPerApp: 1 };
    await save(CUSTOMER_TEST);
    const over = await save({ ...CUSTOMER_TEST, name: 'second' });
    assert.match(over.error, /already has 1 saved tests.*STUDIO_APP_TESTS_MAX=1/);
    assert.equal((await save(CUSTOMER_TEST)).saved, 'updated');
});

test('a fully mocked test takes no run budget; an unmocked AI step pays and is hinted at save', async () => {
    await save(CUSTOMER_TEST);
    await runAll();
    assert.equal(budgetCalls, 0, 'fully mocked: free');
    const unmocked = await save({ actionId: 'act_intake', name: 'real model', expect: [{ path: 'ok', op: 'is', value: true }] });
    assert.match(unmocked.hints[0], /steps\[0\] \(ai_extract\) is not mocked/);
    const run = await runAll({ names: ['real model'] });
    assert.equal(budgetCalls, 1);
    assert.equal(run.tests[0].free, false);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].step.writeTo, undefined, 'still a dry run');
});

test('a spent rate limit makes an unmocked test error (not fail), naming the step', async () => {
    await save({ actionId: 'act_intake', name: 'real model', expect: [{ path: 'vars.who', op: 'isEmpty' }] });
    for (let i = 0; i < 10; i += 1) takeRunBudget(OWNER, Date.now(), 10);
    const run = await runAll();
    assert.equal(run.tests[0].status, 'error');
    assert.match(run.tests[0].error, /steps\[0\] \(ai_extract\) is not mocked/);
});

test('beyond the per-call cap a test is not_run, naming the variable; filters narrow the run', async () => {
    limits = { ...limits, testsPerCall: 1 };
    await save(CUSTOMER_TEST);
    await save({ ...CUSTOMER_TEST, name: 'z second' });
    const run = await runAll();
    assert.deepEqual(run.tests.map((t) => t.status), ['pass', 'not_run']);
    assert.match(run.tests[1].error, /STUDIO_MCP_RUN_TESTS_MAX=1/);
    assert.deepEqual(run.summary, { total: 2, pass: 1, fail: 0, error: 0, notRun: 1 });
    const only = await runAll({ names: ['z second'] });
    assert.deepEqual(only.tests.map((t) => [t.name, t.status]), [['z second', 'pass']]);
    assert.match((await runAll({ names: 'x' })).error, /list of strings/);
    const none = await runAll({ actionIds: ['act_other'] });
    assert.equal(none.tests.length, 0);
    assert.match(none.note, /No saved tests/);
});

test('audit rows carry counts only, never the test\'s values', async () => {
    await save(CUSTOMER_TEST);
    await runAll();
    assert.deepEqual(audits.map((a) => a.event), ['studio_app_mcp_save_test', 'studio_app_mcp_run_tests']);
    assert.equal(JSON.stringify(audits).includes('ACME'), false);
    assert.deepEqual(audits[1].entry, { total: 1, pass: 1, fail: 0, error: 0, notRun: 0, free: 1 });
});
