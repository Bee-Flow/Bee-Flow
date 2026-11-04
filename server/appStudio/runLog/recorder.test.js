'use strict';

/**
 * The run log of SERVER walks (runLog/recorder.mts) against the real run-log store on PGlite:
 * app_run_action logs one run with one step per leaf, its failing step and duration, the AI
 * usage of an AI step (through the runTrace frame aiRuntime feeds); app_run_tests logs one run
 * per test with mocked steps and no AI usage; the recorder buffers, survives a dead database and
 * records nothing with STUDIO_APP_RUN_LOG=off; MCP reads are owner-only and name nobody.
 *
 * Run: cd server && node --test appStudio/runLog/recorder.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { studioRunTableDdl } = require('../../testUtils/studioRunTables');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeRunLogStore } = require('../../stores/studioAppData/runLogStore.mts');
const { startRun, withRunLog, NOOP_RECORDER, toStepRecord } = require('./recorder.mts');
const { noteAiCall } = require('./runTrace.mts');
const { runAction, resetRunWindows, takeRunBudget } = require('../mcpRunAction.mts');
const { runTests } = require('../actionTests/mcpActionTests.mts');
const { listRuns, getRun } = require('../mcpRunLog.mts');
const { runLogError } = require('../../stores/studioAppData/runPolicy.mts');

const { pg, db } = pgliteDb();
const store = makeRunLogStore(db);
const OWNER = 'user_owner';


before(async () => {
    await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
    await pg.exec(studioRunTableDdl('studio_app_action_runs'));
    await pg.exec(studioRunTableDdl('studio_app_action_run_steps'));
    await pg.query("INSERT INTO studio_apps (id, user_id) VALUES ('app_1', $1)", [OWNER]);
});
after(async () => { await pg.close(); });

let appRow;
let clock;
beforeEach(async () => {
    await pg.query('DELETE FROM studio_app_action_runs');
    clock = 1_000_000;
    appRow = { id: 'app_1', userId: OWNER, name: 'Desk', organizationId: 'org_1', definition: {}, definitionVersion: 7 };
    resetRunWindows();
});

const pick = (p, root) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);

function deps(over = {}) {
    return {
        getApp: async (id) => (id === appRow.id ? appRow : null),
        canWrite: (_app, userId) => userId === OWNER,
        getDataModel: async () => ({ model: { tables: [] } }),
        executeStep: async (_app, _model, step) => {
            clock += 25;
            if (step.kind === 'ai_generate') {
                // What aiRuntime.logUsage does inside a step: one call into the run trace.
                noteAiCall({ model: 'claude-x', tier: 'smart', promptTokens: 200, completionTokens: 40, cost: 0.002, currency: 'USD' });
                return { ok: true, result: { text: 'secret customer answer' } };
            }
            if (step.kind === 'update_record') return { ok: false, error: 'Record "Jan Jansen <jan@example.com>" was not found', code: 'not_found' };
            return { ok: true, result: { id: 'rec_1' } };
        },
        evaluate: (expr, scope) => pick(expr, scope),
        buildScope: (ctx) => ({ vars: ctx.vars, form: ctx.formValues, item: ctx.item }),
        resolveBinding: (b) => (b && b.kind === 'static' ? b.value : null),
        readData: async () => null,
        takeBudget: (userId, now) => takeRunBudget(userId, now, 100),
        audit: async () => {},
        log: { warn() {} },
        now: () => clock,
        limits: () => ({ perMinute: 100, budgetMs: 60_000, maxExecuted: 500 }),
        runLog: () => store,
        ...over,
    };
}

const ACTION = {
    kind: 'sequence',
    steps: [
        { kind: 'ai_generate', prompt: 'Summarise {{form.secret}}', resultVar: 'sum' },
        { kind: 'create_record', tableId: 'tbl_a', values: {} },
        { kind: 'update_record', tableId: 'tbl_a', recordId: 'r1', values: {} },
    ],
};

test('spec (MCP): app_run_action logs a failing run with the error, the failing step and the duration per step', async () => {
    appRow.definition = { actions: { act_1: ACTION } };
    const report = await runAction({ appId: 'app_1', actionId: 'act_1', dryRun: false }, OWNER, deps());
    assert.equal(report.ok, false);
    assert.match(report.runId, /^sar_[a-f0-9]{32}$/);
    assert.ok(report.notes.some((n) => n.includes(`Logged as run ${report.runId}`)));

    const got = await getRun({ appId: 'app_1', runId: report.runId }, OWNER, { getApp: deps().getApp, canWrite: deps().canWrite, store: () => store, policy: { idleMs: 60_000, staleMs: 900_000, retentionDays: 30 } });
    assert.equal(got.run.status, 'error');
    assert.equal(got.run.origin, 'mcp');
    assert.equal(got.run.errorCode, 'not_found');
    assert.equal(got.run.errorStep.path, 'steps[2]');
    assert.equal(got.run.definitionVersion, 7);
    assert.deepEqual(got.steps.map((s) => [s.path, s.kind, s.status]), [
        ['steps[0]', 'ai_generate', 'ok'], ['steps[1]', 'create_record', 'ok'], ['steps[2]', 'update_record', 'error'],
    ]);
    for (const s of got.steps) assert.equal(s.durationMs, 25, `${s.path} took 25 ms on the fake clock`);
    assert.deepEqual(got.steps[0].ai, { calls: 1, promptTokens: 200, completionTokens: 40, model: 'claude-x', tier: 'smart', cost: 0.002, currency: 'USD' });
    assert.deepEqual(got.run.ai, { calls: 1, promptTokens: 200, completionTokens: 40, costByCurrency: { USD: 0.002 } });
    assert.equal(got.steps[2].error, 'Record "…" was not found', 'a quoted value is dropped');
    assert.deepEqual(got.run.actor, { kind: 'owner', isYou: true, ref: got.run.actor.ref });
    assert.match(got.run.actor.ref, /^[a-f0-9]{8}$/);
    const text = JSON.stringify(got);
    assert.ok(!text.includes('secret customer answer') && !text.includes('Summarise') && !text.includes(OWNER), 'no result, prompt or user id leaves');
});

test('MCP reads: owner only, filters, and a wrong run id is "not found"', async () => {
    appRow.definition = { actions: { act_1: ACTION, act_2: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {} }] } } };
    await runAction({ appId: 'app_1', actionId: 'act_1', dryRun: false }, OWNER, deps());
    await runAction({ appId: 'app_1', actionId: 'act_2', dryRun: false }, OWNER, deps());
    const rd = { getApp: deps().getApp, canWrite: deps().canWrite, store: () => store, policy: { idleMs: 60_000, staleMs: 900_000, retentionDays: 30 } };
    const all = await listRuns({ appId: 'app_1' }, OWNER, rd);
    assert.equal(all.runs.length, 2);
    assert.equal(all.retentionDays, 30);
    const failing = await listRuns({ appId: 'app_1', status: 'error' }, OWNER, rd);
    assert.deepEqual(failing.runs.map((r) => r.actionId), ['act_1']);
    const page = await listRuns({ appId: 'app_1', limit: 1 }, OWNER, rd);
    assert.equal(page.runs.length, 1);
    const next = await listRuns({ appId: 'app_1', limit: 1, cursor: page.nextCursor }, OWNER, rd);
    assert.equal(next.runs.length, 1);
    assert.notEqual(next.runs[0].id, page.runs[0].id);
    assert.match((await listRuns({ appId: 'app_1' }, 'stranger', rd)).error, /not found/);
    assert.match((await getRun({ appId: 'app_1', runId: page.runs[0].id }, 'stranger', rd)).error, /not found/);
    assert.match((await getRun({ appId: 'app_1', runId: 'sar_x' }, OWNER, rd)).error, /no run/);
    assert.match((await listRuns({ appId: 'app_1', status: 'weird' }, OWNER, rd)).error, /status/);
    assert.match((await listRuns({ appId: 'app_1', cursor: 'garbage' }, OWNER, rd)).error, /cursor/);
});

test('app_run_tests: one run per test (origin test), mocked AI steps carry no AI usage', async () => {
    appRow.definition = { actions: { act_1: { kind: 'sequence', steps: [ACTION.steps[0], ACTION.steps[1]] } } };
    const saved = [{ id: 't1', actionId: 'act_1', name: 'works', spec: { mock: { 'steps[0]': 'fixed' }, expect: [{ path: 'ok', op: 'is', value: true }] }, lastStatus: null }];
    const out = await runTests({ appId: 'app_1' }, OWNER, {
        run: deps(),
        store: () => ({ listActionTests: async () => saved, recordTestStatuses: async () => {} }),
        audit: async () => {},
    });
    assert.equal(out.summary.pass, 1);
    const runId = out.tests[0].runId;
    assert.match(runId, /^sar_/);
    const steps = await store.getSteps(runId);
    assert.equal(steps[0].mocked, true);
    assert.equal(steps[0].ai, null, 'a mocked step made no model call');
    const run = await store.getLoggedRun('app_1', runId, { idleMs: 60_000, staleMs: 900_000 });
    assert.equal(run.origin, 'test');
    assert.equal(run.dryRun, true);
    assert.equal(run.status, 'success');
});

test('without a runLog dep nothing is recorded (the default for tests that inject their own deps)', async () => {
    appRow.definition = { actions: { act_1: ACTION } };
    const report = await runAction({ appId: 'app_1', actionId: 'act_1' }, OWNER, deps({ runLog: undefined }));
    assert.equal(report.runId, undefined);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM studio_app_action_runs')).rows[0].n, 0);
});

test('the recorder: STUDIO_APP_RUN_LOG=off records nothing; a dead database is one warning and the run goes on', async () => {
    process.env.STUDIO_APP_RUN_LOG = 'off';
    try {
        assert.equal(await startRun({ appId: 'app_1', ownerUserId: OWNER, actionId: 'a', origin: 'mcp', viewerUserId: OWNER, draft: true, definitionVersion: 1 }, { store: () => store }), NOOP_RECORDER);
    } finally { delete process.env.STUDIO_APP_RUN_LOG; }

    const warnings = [];
    const broken = { ...store, appendSteps: async () => { throw new Error('connection lost'); }, finishLogged: async () => { throw new Error('connection lost'); } };
    const rec = await startRun({ appId: 'app_1', ownerUserId: OWNER, actionId: 'a', origin: 'mcp', viewerUserId: OWNER, draft: true, definitionVersion: 1 },
        { store: () => broken, log: { warn: (...a) => warnings.push(a.join(' ')) }, batchSize: 1 });
    assert.ok(rec.id);
    const host = withRunLog({ execute: async () => ({ ok: true }), onStepEnd: async () => {} }, rec);
    const ev = { path: 'steps[0]', kind: 'toast', ordinal: 0, ownerActionId: 'a', iteration: null, loop: null, status: 'ok', ms: 3 };
    await host.execute({ kind: 'toast' }, ev, {});
    await host.onStepEnd(ev);
    await host.onStepEnd(ev);
    await rec.finish({ status: 'success', durationMs: 5 });
    await rec.finish({ status: 'success', durationMs: 5 });
    assert.equal(warnings.length, 1, 'one warning, then quiet');
    assert.match(warnings[0], /\[StudioRunLog\].*connection lost/);
});

test('toStepRecord and runLogError keep no customer values', () => {
    const rec = toStepRecord({ path: 'steps[0]', kind: 'ai_extract', ordinal: 0, ownerActionId: 'a', iteration: 2, loop: null, status: 'error', ms: 9, error: 'Provider said {"input":"Jan Jansen, Main street 1"}', attempts: 3, handled: true, result: { rows: ['x'] } }, 1000);
    assert.equal(rec.error, 'Provider said …');
    assert.equal(rec.attempts, 3);
    assert.equal(rec.handled, true);
    assert.equal(rec.startedAt, 991);
    assert.equal('result' in rec, false);
    assert.equal(runLogError('first line\nsecond line with data'), 'first line');
    assert.equal(runLogError(`Value "${'Lorem ipsum '.repeat(4)}" is too long`), 'Value "…" is too long');
    assert.equal(runLogError('Record "Jan Jansen" was not found'), 'Record "…" was not found', 'a short name is a value too');
    assert.equal(runLogError('Record "Jansen" was not found'), 'Record "…" was not found', 'one capitalised word is a value');
    assert.equal(runLogError('Field "status" is required'), 'Field "status" is required', 'a field key stays readable');
    assert.equal(runLogError('x'.repeat(400)).length, 300);
    assert.equal(runLogError(null), null);
    assert.equal(runLogError('No mailbox for jan@example.com'), 'No mailbox for [e-mail]');
});
