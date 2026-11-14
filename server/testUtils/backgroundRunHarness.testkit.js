// @typecheck
'use strict';

/**
 * The set-up the background action tests share (appStudio/backgroundRun*.test.js): the REAL
 * run store on PGlite, a fake clock and fake timers, an injected executor and the deps
 * backgroundRun.mts takes.
 *
 * `backgroundRunHarness({ before, after, beforeEach })` registers the hooks and returns the
 * harness. Its mutable state lives on `h.s` and is reset before each test:
 *
 *   clock     what deps().now() answers; deps().sleep() moves it on
 *   executed  every step the executor was handed, as { step, ctx }
 *   sleeps    every sleep in ms
 *   execute   the executor a test may replace: (app, model, step, ctx) => result
 *   budgets   (kind) => the rate budgets of a step kind
 *   limits    backgroundLimits({}), a copy a test may change
 *   beats     the heartbeat callbacks setInterval was handed
 *   context   what a resume continues as: (row, meta) => { ok: true, input } or a refusal. The
 *             default answers the input of the last start (h.input), as if nothing changed
 *             since; `metas` keeps what each resume asked with
 */

const assert = require('node:assert/strict');

const { pgliteDb } = require('./pgliteDb');
const { studioRunTableDdl } = require('./studioRunTables');
const { makeActionRunStore } = require('../stores/studioAppData/actionRuns.mts');
const BG = require('../appStudio/backgroundRun.mts');
const { backgroundLimits } = require('../appStudio/backgroundRunPolicy.mts');

const pick = (p, root) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);

const APP = { id: 'app_1', userId: 'owner', name: 'Desk', organizationId: 'org_1' };
const status = (text) => ({ kind: 'set_variable', name: 'status', value: { kind: 'static', value: text } });
const defaultExecute = async (_app, _model, step) => (step.kind === 'ai_generate' ? { ok: true, result: { text: 'a summary' } } : { ok: true, result: { id: 'rec_1' } });

function input(action, over = {}) {
    return {
        app: APP, def: { actions: { act_bg: action, ...(over.actions || {}) } }, model: null, actionId: 'act_bg',
        viewer: { id: 'viewer1', name: 'Viewer', email: null, organizationId: 'org_1' }, role: 'agent', isOwner: false,
        draft: false, definitionVersion: 4, scope: { formValues: { id: 'o7' }, vars: { keep: 1 } }, ...over,
    };
}

function resolveBinding(b, _ctx, scope) {
    if (!b || typeof b !== 'object') return null;
    if (b.kind === 'static') return b.value;
    if (b.kind === 'formula') return pick(b.expr, scope);
    return null;
}

function backgroundRunHarness({ before, after, beforeEach }) {
    const { pg, db } = pgliteDb();
    const store = makeActionRunStore(db);
    const s = { clock: 0, executed: [], sleeps: [], execute: /** @type {import('../appStudio/backgroundRunParts.mts').RunnerDeps['executeStep']} */ (defaultExecute), budgets: /** @type {import('../appStudio/backgroundRunParts.mts').RunnerDeps['budgetsFor']} */ (() => []), limits: /** @type {ReturnType<typeof backgroundLimits>} */ ({}), beats: [], context: null, metas: [], lastInput: null };
    const sameAsStart = async () => (s.lastInput ? { ok: true, input: { ...s.lastInput, scope: {} } } : { ok: false, code: 'app_gone', error: 'No start to continue.' });
    const tracked = (action, over) => { s.lastInput = input(action, over); return s.lastInput; };

    before(async () => {
        await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
        await pg.exec(studioRunTableDdl('studio_app_action_runs'));
        await pg.exec(studioRunTableDdl('studio_app_action_run_steps'));
        await pg.query("INSERT INTO studio_apps (id, user_id) VALUES ('app_1', 'owner')");
    });
    after(async () => { await pg.close(); });
    beforeEach(async () => {
        BG._resetForTests();
        await pg.query('DELETE FROM studio_app_action_runs');
        Object.assign(s, { clock: 1_000_000, executed: [], sleeps: [], budgets: () => [], beats: [], limits: { ...backgroundLimits({}) }, execute: defaultExecute, context: sameAsStart, metas: [], lastInput: null });
    });

    function deps(over = {}) {
        return {
            store: () => store,
            executeStep: async (app, model, step, ctx) => { s.executed.push({ step, ctx }); return s.execute(app, model, step, ctx); },
            evaluate: (expr, scope) => (expr === 'true' ? true : pick(expr, scope)),
            buildScope: (ctx) => ({ vars: ctx.vars, form: ctx.formValues, item: ctx.item, index: ctx.index, error: ctx.error }),
            resolveBinding,
            budgetsFor: (kind) => s.budgets(kind),
            heavyKinds: ['ai_generate', 'send_email'],
            stepDocumentContext: () => ({}),
            logUsage: async () => {},
            log: { info() {}, warn() {}, error() {} },
            now: () => s.clock,
            sleep: async (ms) => { s.sleeps.push(ms); s.clock += ms; },
            limits: () => s.limits,
            instanceId: 'test',
            setInterval: (fn) => { s.beats.push(fn); return s.beats.length; },
            clearInterval: () => {},
            loadResumeContext: async (row, meta) => { s.metas.push(meta); return s.context(row, meta); },
            ...over,
        };
    }

    async function startAndSettle(action, over = {}, d = deps()) {
        const started = await BG.startBackgroundRun(tracked(action, over), d);
        assert.equal(started.ok, true, JSON.stringify(started));
        await BG._settled(started.jobId);
        return store.getRun('app_1', started.jobId);
    }

    return { s, pg, db, store, deps, input: tracked, startAndSettle, APP, status };
}

module.exports = { backgroundRunHarness };
