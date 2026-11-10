'use strict';

/**
 * A `parallel` step in a background action (backgroundRun.mts), with a fake clock and an
 * injected executor against the REAL run store on PGlite: the branches run side by side in
 * the job, their variables are joined into the job's result, and a failing branch fails the job.
 *
 * Run: cd server && node --test appStudio/backgroundRun.parallel.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeActionRunStore } = require('../stores/studioAppData/actionRuns.mts');
const BG = require('./backgroundRun.mts');
const { backgroundLimits } = require('./backgroundRunPolicy.mts');
const { guardedAiCall } = require('./aiCallGuard.mts');
const { describeStepError } = require('./actionExecutor/stepErrors.mts');

const { pg, db } = pgliteDb();
const store = makeActionRunStore(db);

before(async () => {
    const { studioRunTableDdl } = require('../testUtils/studioRunTables');
    const ddl = studioRunTableDdl('studio_app_action_runs');
    await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
    await pg.exec(ddl);
    await pg.exec(studioRunTableDdl('studio_app_action_run_steps'));
    await pg.query("INSERT INTO studio_apps (id, user_id) VALUES ('app_1', 'owner')");
});
after(async () => { await pg.close(); });

const pick = (p, root) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);

let clock;
let executed;
let sleeps;
let execute;
let budgets;
let limits;
let beats;

beforeEach(async () => {
    BG._resetForTests();
    await pg.query('DELETE FROM studio_app_action_runs');
    clock = 1_000_000; executed = []; sleeps = []; budgets = () => []; beats = [];
    limits = { ...backgroundLimits({}) };
    execute = async (_app, _model, step) => (step.kind === 'ai_generate' ? { ok: true, result: { text: 'a summary' } } : { ok: true, result: { id: 'rec_1' } });
});

function deps(over = {}) {
    return {
        store: () => store,
        executeStep: async (app, model, step, ctx) => { executed.push({ step, ctx }); return execute(app, model, step, ctx); },
        evaluate: (expr, scope) => (expr === 'true' ? true : pick(expr, scope)),
        buildScope: (ctx) => ({ vars: ctx.vars, form: ctx.formValues, item: ctx.item, index: ctx.index, error: ctx.error }),
        resolveBinding: (b, _ctx, scope) => {
            if (!b || typeof b !== 'object') return null;
            if (b.kind === 'static') return b.value;
            if (b.kind === 'formula') return pick(b.expr, scope);
            return null;
        },
        budgetsFor: (kind) => budgets(kind),
        heavyKinds: ['ai_generate', 'send_email'],
        stepDocumentContext: () => ({}),
        logUsage: async () => {},
        log: { info() {}, warn() {}, error() {} },
        now: () => clock,
        sleep: async (ms) => { sleeps.push(ms); clock += ms; },
        limits: () => limits,
        instanceId: 'test',
        setInterval: (fn) => { beats.push(fn); return beats.length; },
        clearInterval: () => {},
        ...over,
    };
}

const APP = { id: 'app_1', userId: 'owner', name: 'Desk', organizationId: 'org_1' };
const status = (text) => ({ kind: 'set_variable', name: 'status', value: { kind: 'static', value: text } });

function input(action, over = {}) {
    return {
        app: APP, def: { actions: { act_bg: action, ...(over.actions || {}) } }, model: null, actionId: 'act_bg',
        viewer: { id: 'viewer1', name: 'Viewer', email: null, organizationId: 'org_1' }, role: 'agent', isOwner: false,
        draft: false, definitionVersion: 4, scope: { formValues: { id: 'o7' }, vars: { keep: 1 } }, ...over,
    };
}

async function startAndSettle(action, over = {}, d = deps()) {
    const started = await BG.startBackgroundRun(input(action, over), d);
    assert.equal(started.ok, true, JSON.stringify(started));
    await BG._settled(started.jobId);
    return store.getRun('app_1', started.jobId);
}

const ai = (prompt, resultVar) => ({ kind: 'ai_generate', prompt, resultVar });
const parallel = (branches, extra = {}) => ({ kind: 'parallel', branches: branches.map((steps) => ({ steps })), ...extra });

test('a background action runs the branches side by side and ends in success', async () => {
    let live = 0;
    let peak = 0;
    execute = async (_a, _m, step) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => { setImmediate(resolve); });
        live -= 1;
        return { ok: true, result: { text: `answer to ${step.prompt}` } };
    };
    const action = { kind: 'sequence', background: true, progressVar: 'status', steps: [
        status('Working'),
        parallel([[ai('one', 'first')], [ai('two', 'second')], [status('Third branch')]]),
        status('Finished'),
    ] };
    const run = await startAndSettle(action);
    assert.equal(run.status, 'success', JSON.stringify(run).slice(0, 400));
    assert.equal(peak, 2, 'both AI steps were running at the same moment');
    assert.deepEqual(executed.map((e) => e.step.prompt).sort(), ['one', 'two']);
});

test('a failing branch fails the background job with that step\'s message', async () => {
    execute = async (_a, _m, step) => (step.prompt === 'bad' ? { ok: false, error: 'The model did not answer', retryable: false } : { ok: true, result: { text: 'fine' } });
    const action = { kind: 'sequence', background: true, steps: [parallel([[ai('bad', 'first')], [ai('good', 'second')]]), ai('never', 'x')] };
    const run = await startAndSettle(action);
    assert.equal(run.status, 'error');
    assert.match(JSON.stringify(run), /The model did not answer/);
    assert.deepEqual(executed.map((e) => e.step.prompt).sort(), ['bad', 'good'], 'the other branch ran, the step after the parallel did not');
});

test('a toast in a branch is kept for the end of the job; a transaction is refused by the branch', async () => {
    const toasts = { kind: 'sequence', background: true, steps: [parallel([[{ kind: 'toast', message: 'Half way', tone: 'info' }], [ai('one', 'first')]])] };
    assert.equal((await startAndSettle(toasts)).status, 'success');
    // A navigate in a branch never gets this far: the start refuses it like anywhere else in a background action.
    const nav = { kind: 'sequence', background: true, steps: [parallel([[{ kind: 'navigate', screenId: 'scr_1' }], [ai('one', 'first')]])] };
    const refused = await BG.startBackgroundRun(input(nav), deps());
    assert.equal(refused.code, 'background_not_runnable');
    const tx = { kind: 'sequence', background: true, steps: [parallel([[{ kind: 'transaction', steps: [{ kind: 'create_record', tableId: 't', values: {} }] }], [ai('two', 'second')]])] };
    const run = await startAndSettle(tx);
    assert.equal(run.status, 'error');
    assert.match(JSON.stringify(run), /cannot run inside a branch of a parallel step/);
    assert.deepEqual(executed.map((e) => e.step.kind), ['ai_generate', 'ai_generate'], 'the transaction never reached the executor');
});
