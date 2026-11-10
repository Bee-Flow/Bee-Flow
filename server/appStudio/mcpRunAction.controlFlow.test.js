'use strict';

/**
 * app_run_action over the control kinds of the step registry: a dry run walks a while with a
 * break, a try with a catch and a return like the browser would, and reports each of them.
 *
 * Run: cd server && node --test appStudio/mcpRunAction.controlFlow.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { runAction, takeRunBudget, resetRunWindows } = require('./mcpRunAction.mts');
const { tryEvaluate } = require('../shared/expr/index.mjs');

const OWNER = 'user_owner';
let executed;
let failOn;

function deps() {
    const app = { id: 'app_1', userId: OWNER, name: 'Flow', organizationId: 'org_1', definition: {} };
    return {
        app,
        getApp: async () => app,
        canWrite: () => true,
        getDataModel: async () => ({ model: { tables: [] } }),
        executeStep: async (_app, _model, step) => {
            executed.push(step.kind);
            return failOn === step.kind ? { ok: false, error: 'The model did not answer', code: 'ai_down', retryable: false } : { ok: true, result: `${step.kind} result` };
        },
        evaluate: (expr, scope) => tryEvaluate(expr, scope).value,
        buildScope: (ctx) => ({ vars: ctx.vars, form: ctx.formValues, item: ctx.item, index: ctx.index, error: ctx.error ?? null }),
        resolveBinding: (b, _ctx, scope) => (b && b.kind === 'static' ? b.value : (b && b.kind === 'formula' ? tryEvaluate(b.expr, scope).value : null)),
        readData: async () => null,
        takeBudget: (userId, now) => takeRunBudget(userId, now, 10),
        audit: async () => {},
        log: { warn() {} },
        now: () => 1_000_000,
        limits: () => ({ perMinute: 10, budgetMs: 60_000, maxExecuted: 500 }),
    };
}

async function run(action, args = {}) {
    const d = deps();
    d.app.definition = { actions: { act_1: action } };
    return runAction({ appId: 'app_1', actionId: 'act_1', ...args }, OWNER, d);
}

const setVar = (name, expr) => ({ kind: 'set_variable', name, value: { kind: 'formula', expr } });
const byPath = (out) => Object.fromEntries(out.steps.map((s) => [s.path, s]));

beforeEach(() => { executed = []; failOn = null; resetRunWindows(); });

test('a dry run walks a while with a break and reports the rounds', async () => {
    const action = { kind: 'sequence', steps: [
        { kind: 'while', expr: 'vars.n < 10', maxIterations: 50, steps: [
            setVar('n', 'vars.n + 1'),
            { kind: 'condition', expr: 'vars.n == 3', then: [{ kind: 'break' }], else: [] },
            { kind: 'ai_generate', prompt: 'p', resultVar: 'draft' },
        ] },
        { kind: 'return', value: { kind: 'formula', expr: 'vars.n' } },
        { kind: 'ai_generate', prompt: 'never', resultVar: 'x' },
    ] };
    const out = await run(action, { scope: { vars: { n: 0 } } });
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 600));
    assert.equal(out.dryRun, true);
    assert.deepEqual(executed, ['ai_generate', 'ai_generate'], 'two full rounds before the break; nothing after the return');
    const steps = byPath(out);
    assert.equal(steps['steps[0]'].kind, 'while');
    assert.deepEqual(steps['steps[0]'].result, { iterations: 3 });
    assert.equal(steps['steps[0].steps[1].then[0]'].status, 'ok');
    assert.equal(steps['steps[1]'].status, 'ok');
    assert.equal(steps['steps[2]'], undefined, 'the step after the return never ran');
    assert.equal(out.vars.n, 3);
});

test('a dry run takes a failing step to the catch of its try, and the run is ok', async () => {
    failOn = 'kb_query';
    const action = { kind: 'sequence', steps: [
        { kind: 'try',
            steps: [{ kind: 'kb_query', query: { kind: 'static', value: 'q' }, knowledgeBaseIds: ['kb_1'], resultVar: 'hits' }, { kind: 'ai_generate', prompt: 'never', resultVar: 'x' }],
            catch: [setVar('why', 'error.code + ": " + error.message')],
            finally: [setVar('done', 'true')] },
        { kind: 'ai_generate', prompt: 'after', resultVar: 'summary' },
    ] };
    const out = await run(action);
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 600));
    assert.deepEqual(executed, ['kb_query', 'ai_generate']);
    assert.equal(out.vars.why, 'ai_down: The model did not answer');
    assert.equal(out.vars.done, true);
    const steps = byPath(out);
    assert.equal(steps['steps[0].steps[0]'].status, 'error');
    assert.equal(steps['steps[0].steps[1]'], undefined, 'the step after the failure never ran');
    assert.deepEqual(steps['steps[0]'].result, { caught: true });
});

test('raise_error without a try fails the run with the author\'s message', async () => {
    const out = await run({ kind: 'sequence', steps: [{ kind: 'raise_error', message: { kind: 'static', value: 'The order has no lines.' }, code: 'no_lines' }, { kind: 'ai_generate', prompt: 'never', resultVar: 'x' }] });
    assert.equal(out.ok, false);
    assert.deepEqual(executed, []);
    assert.match(JSON.stringify(out), /The order has no lines\./);
});
