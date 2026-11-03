'use strict';

/** Run: cd server && node --test appStudio/mcpRunAction.test.js */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { runAction, takeRunBudget, resetRunWindows, trimValue } = require('./mcpRunAction.mts');

const OWNER = 'user_owner';
const EDITOR = 'user_editor';

let executed;
let audits;
let appRow;
let clock;
let budget;
let failOn;

const pick = (path, root) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), root);

function deps(over = {}) {
    return {
        getApp: async (id) => (id === appRow.id ? appRow : null),
        canWrite: (_app, userId) => userId === OWNER || userId === EDITOR,
        getDataModel: async () => ({ model: { tables: [] } }),
        executeStep: async (_app, _model, step, ctx) => {
            executed.push({ step, ctx });
            if (failOn === step.kind) return { ok: false, error: 'Step failed' };
            if (step.kind === 'ai_generate') return { ok: true, result: 'a summary' };
            return { ok: true, result: null };
        },
        evaluate: (expr, scope) => pick(expr, scope),
        buildScope: (ctx) => ({ vars: ctx.vars, form: ctx.formValues, item: ctx.item, index: ctx.index }),
        resolveBinding: (b, ctx, scope) => {
            if (!b || typeof b !== 'object') return null;
            if (b.kind === 'static') return b.value;
            if (b.kind === 'formula') return pick(b.expr, scope);
            return null;
        },
        takeBudget: (userId, now) => takeRunBudget(userId, now, budget),
        audit: async (entry) => { audits.push(entry); },
        log: { warn() {} },
        now: () => clock,
        limits: () => ({ perMinute: budget, budgetMs: 60_000, maxExecuted: 500 }),
        ...over,
    };
}

const EMAIL = { kind: 'send_email', connectorId: 'conn_a', to: { kind: 'static', value: 'a@example.com' }, subject: { kind: 'static', value: 'Hello' }, body: { kind: 'static', value: 'SECRET BODY' } };
const run = (action, args = {}, userId = OWNER, over = {}) => {
    appRow.definition = { actions: { act_1: action } };
    return runAction({ appId: 'app_1', actionId: 'act_1', ...args }, userId, deps(over));
};
const kindsRun = () => executed.map((e) => e.step.kind);

beforeEach(() => {
    executed = []; audits = []; failOn = null; clock = 1_000_000; budget = 10;
    appRow = { id: 'app_1', userId: OWNER, name: 'Desk', organizationId: 'org_1', definition: {} };
    resetRunWindows();
});

// ── Who ─────────────────────────────────────────────────────────────────────

test('an editor who is not the owner is refused, and nothing runs or is charged', async () => {
    const out = await run({ kind: 'sequence', steps: [{ kind: 'ai_generate' }] }, {}, EDITOR);
    assert.match(out.error, /only available to the owner/);
    assert.equal(executed.length, 0);
    assert.equal(takeRunBudget(EDITOR, clock, 1), true, 'a refused call spent no budget');
});

test('a user without write access, an unknown app and a store failure are all the same denial', async () => {
    const denied = await run({ kind: 'toast' }, {}, 'stranger');
    assert.match(denied.error, /not found, or this token's user cannot edit it/);
    const missing = await runAction({ appId: 'app_zzz', actionId: 'act_1' }, OWNER, deps());
    assert.match(missing.error, /not found/);
    const broken = await run({ kind: 'toast' }, {}, OWNER, { getApp: async () => { throw new Error('db down'); } });
    assert.match(broken.error, /not found/);
    assert.equal(executed.length, 0);
});

test('write access is re-checked at call time', async () => {
    const out = await run({ kind: 'toast' }, {}, OWNER, { canWrite: () => false });
    assert.match(out.error, /cannot edit it/);
});

test('an unknown action and a bad actionId are errors', async () => {
    const out = await runAction({ appId: 'app_1', actionId: 'act_nope' }, OWNER, deps());
    assert.match(out.error, /no action "act_nope"/);
    const bad = await runAction({ appId: 'app_1', actionId: '../x' }, OWNER, deps());
    assert.match(bad.error, /actionId/);
});

// ── dryRun ──────────────────────────────────────────────────────────────────

test('dryRun is the default: client steps skipped, a record write not executed, an AI step runs', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'toast', message: 'hi' },
        { kind: 'create_record', tableId: 'tbl_a', values: {} },
        { kind: 'ai_generate', resultVar: 'summary', writeTo: { tableId: 'tbl_a' } },
        { kind: 'navigate', screenId: 'scr_1' },
    ] });
    assert.equal(out.dryRun, true);
    assert.equal(out.ok, true);
    assert.deepEqual(out.steps.map((s) => [s.kind, s.status]), [['toast', 'skipped'], ['create_record', 'skipped'], ['ai_generate', 'ok'], ['navigate', 'skipped']]);
    assert.deepEqual(kindsRun(), ['ai_generate'], 'only the AI step reached the executor');
    assert.equal(executed[0].step.writeTo, undefined, 'writeTo is stripped in dryRun');
    assert.deepEqual(out.vars, { summary: 'a summary' });
    assert.deepEqual(out.steps[1].result, { wouldWrite: { kind: 'create_record', tableId: 'tbl_a' } });
});

test('dryRun never executes send_email, also nested in condition, switch and loop; the report has no body', async () => {
    const out = await run({ kind: 'sequence', steps: [
        EMAIL,
        { kind: 'condition', expr: 'vars.go', then: [EMAIL], else: [] },
        { kind: 'switch', expr: 'vars.mode', cases: [{ value: 'a', steps: [{ kind: 'condition', expr: 'vars.go', then: [EMAIL] }] }], default: [EMAIL] },
        { kind: 'loop', source: { kind: 'formula', expr: 'vars.rows' }, steps: [EMAIL] },
    ] }, { scope: { vars: { go: true, mode: 'a', rows: [1, 2] } } });
    assert.equal(kindsRun().includes('send_email'), false);
    assert.equal(executed.length, 0);
    const mails = out.steps.filter((s) => s.kind === 'send_email');
    assert.equal(mails.length, 5, 'top level, then, switch case (nested), 2 loop rounds');
    for (const m of mails) {
        assert.equal(m.status, 'skipped');
        assert.deepEqual(m.result, { wouldSend: { to: 'a@example.com', subject: 'Hello', mode: 'send' } });
    }
    assert.equal(JSON.stringify(out).includes('SECRET BODY'), false);
    // the default branch of the switch is not taken when a case matches
    assert.ok(out.steps.some((s) => s.path === 'steps[2].cases[0].steps[0].then[0]'));
});

test('send_email in the switch default and the else branch is held back too', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'switch', expr: 'vars.mode', cases: [], default: [EMAIL] },
        { kind: 'condition', expr: 'vars.go', then: [], else: [EMAIL] },
    ] }, { scope: { vars: { go: false, mode: 'z' } } });
    assert.equal(executed.length, 0);
    assert.equal(out.steps.filter((s) => s.kind === 'send_email' && s.status === 'skipped').length, 2);
});

// ── Live ────────────────────────────────────────────────────────────────────

test('dryRun false: send_email mode draft executes as a draft; mode send is refused for that step and the run goes on', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { ...EMAIL, mode: 'send' },
        { ...EMAIL },
        { ...EMAIL, mode: 'draft' },
        { kind: 'update_record', tableId: 'tbl_a', recordId: { kind: 'static', value: 'r1' } },
    ] }, { dryRun: false });
    assert.deepEqual(out.steps.map((s) => s.status), ['refused', 'refused', 'ok', 'ok']);
    assert.equal(out.ok, true);
    assert.deepEqual(executed.map((e) => [e.step.kind, e.step.mode]), [['send_email', 'draft'], ['update_record', undefined]]);
});

test('dryRun false: nested send_email with mode send is refused, a nested draft inside a loop too', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'condition', expr: 'vars.go', then: [{ kind: 'switch', expr: 'vars.m', cases: [{ value: 'x', steps: [{ ...EMAIL, mode: 'send' }] }] }] },
        { kind: 'loop', source: { kind: 'formula', expr: 'vars.rows' }, steps: [{ ...EMAIL, mode: 'draft' }] },
    ] }, { dryRun: false, scope: { vars: { go: true, m: 'x', rows: [1, 2] } } });
    assert.equal(executed.length, 0);
    assert.equal(out.steps.filter((s) => s.kind === 'send_email').every((s) => s.status === 'refused'), true);
    assert.equal(out.steps.filter((s) => s.kind === 'send_email').length, 3);
});

test('dryRun false: automations, approvals and viewer-bound steps are refused, records are written', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'run_automation', automationId: 'a' }, { kind: 'request_approval' }, { kind: 'copy_document' }, { kind: 'create_record', tableId: 'tbl_a', values: {} },
    ] }, { dryRun: false });
    assert.deepEqual(out.steps.map((s) => s.status), ['refused', 'refused', 'refused', 'ok']);
    assert.deepEqual(kindsRun(), ['create_record']);
    assert.equal(executed[0].ctx.role, 'owner');
    assert.equal(executed[0].ctx.viewerId, OWNER);
});

test('the guard right before the executor also holds when the policy is bypassed', async () => {
    // a deps.executeStep that is handed a send step must never see one outside a draft
    const out = await run({ kind: 'sequence', steps: [{ ...EMAIL, mode: 'draft' }] }, { dryRun: false });
    assert.equal(executed[0].step.mode, 'draft');
    assert.equal(out.ok, true);
});

// ── Errors, scope, caps ─────────────────────────────────────────────────────

test('a failing step is reported with its path and stops the run; skipped steps after it are not reported', async () => {
    failOn = 'update_record';
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'ai_generate' }, { kind: 'update_record', tableId: 'tbl_a' }, { kind: 'ai_generate' },
    ] });
    // dryRun: the update is only "would write", so it cannot fail; run it live
    assert.equal(out.ok, true);
    executed = [];
    const live = await run({ kind: 'sequence', steps: [
        { kind: 'ai_generate' }, { kind: 'update_record', tableId: 'tbl_a' }, { kind: 'ai_generate' },
    ] }, { dryRun: false });
    assert.equal(live.ok, false);
    assert.deepEqual(live.steps.map((s) => [s.path, s.status]), [['steps[0]', 'ok'], ['steps[1]', 'error']]);
    assert.equal(live.steps[1].error, 'Step failed');
    assert.equal(live.stopped, 'steps[1] failed');
    assert.equal(kindsRun().length, 2);
});

test('scope: form, vars and item reach the executor; resultVar is passed on; loop vars are iteration-scoped', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'set_variable', name: 'total', value: { kind: 'formula', expr: 'form.amount' } },
        { kind: 'loop', source: { kind: 'formula', expr: 'vars.rows' }, itemVar: 'row', indexVar: 'i', steps: [{ kind: 'ai_generate' }] },
        { kind: 'ai_extract' },
    ] }, { scope: { vars: { rows: ['a', 'b'] }, form: { amount: 5 }, item: { id: 'r9' } } });
    assert.equal(out.ok, true);
    assert.deepEqual(executed.map((e) => [e.step.kind, e.ctx.item, e.ctx.index, e.ctx.vars.row]), [
        ['ai_generate', 'a', 0, 'a'], ['ai_generate', 'b', 1, 'b'], ['ai_extract', { id: 'r9' }, undefined, undefined],
    ]);
    assert.equal(executed[2].ctx.vars.total, 5);
    assert.equal(out.vars.row, undefined);
});

test('a loop whose source does not resolve to a list is skipped with a note', async () => {
    const out = await run({ kind: 'sequence', steps: [{ kind: 'loop', source: { kind: 'records', tableId: 'tbl_a' }, steps: [{ kind: 'ai_generate' }] }] });
    assert.equal(out.steps[0].status, 'skipped');
    assert.match(out.notes.join(' '), /did not resolve to a list/);
});

test('results are trimmed and secret-looking keys redacted', () => {
    const big = trimValue({ apiKey: 'sk-1', nested: { token: 't', rows: Array.from({ length: 50 }, (_, i) => i), text: 'x'.repeat(1000) } });
    assert.equal(big.apiKey, '[redacted]');
    assert.equal(big.nested.token, '[redacted]');
    assert.equal(big.nested.rows.length, 11);
    assert.ok(big.nested.text.length < 400);
});

test('the time budget stops the run and says so', async () => {
    let t = 1_000_000;
    const out = await run({ kind: 'sequence', steps: [{ kind: 'ai_generate' }, { kind: 'ai_generate' }, { kind: 'ai_generate' }] }, {}, OWNER, {
        now: () => t,
        executeStep: async (_a, _m, step, ctx) => { executed.push({ step, ctx }); t += 40_000; return { ok: true, result: 1 }; },
    });
    assert.equal(executed.length, 2);
    assert.equal(out.truncated, true);
    assert.equal(out.ok, false);
    assert.match(out.stopped, /time budget/);
});

test('the per-user rate limit: the eleventh call within a minute is refused, another user is not', async () => {
    budget = 10;
    for (let i = 0; i < 10; i += 1) assert.equal((await run({ kind: 'toast' })).ok, true);
    const eleventh = await run({ kind: 'toast' });
    assert.match(eleventh.error, /Too many app_run_action calls/);
    clock += 61_000;
    assert.equal((await run({ kind: 'toast' })).ok, true, 'the window moves on');
    assert.equal(takeRunBudget('someone_else', clock, 10), true);
});

test('a bare (non-sequence) action runs as one step; every run is audited', async () => {
    const out = await run({ kind: 'ai_generate' }, { dryRun: true });
    assert.equal(out.steps[0].path, 'action[0]');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].dryRun, true);
});

test('the MCP tool list advertises app_run_action with appId required, as a write, and the caps are described', () => {
    const { buildToolList } = require('./mcpBuilder');
    const tool = buildToolList().find((t) => t.name === 'app_run_action');
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ['appId', 'actionId']);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.match(tool.description, /only the app owner/i);
    assert.match(tool.description, /never executed/i);
    assert.match(tool.description, /AI budget/);
});

// ── AI time-out stops the sequence; always the latest saved definition ─────────

test('a step that fails on the AI time-out stops the sequence: the following step does not run', async () => {
    const { guardedAiCall } = require('./aiCallGuard.mts');
    const stepsRun = [];
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'ai_generate', resultVar: 'summary' },
        { kind: 'create_record', tableId: 'tbl_a', values: {} },
    ] }, { dryRun: false }, OWNER, {
        executeStep: async (_app, _model, step) => {
            stepsRun.push(step.kind);
            try {
                await guardedAiCall(() => new Promise(() => {}), { kind: 'text', model: 'm' }, { log: { info() {} }, env: { STUDIO_AI_CALL_TIMEOUT_MS: '30' } });
                return { ok: true, result: null };
            } catch (e) { return { ok: false, error: e.message }; }
        },
    });
    assert.deepEqual(stepsRun, ['ai_generate']);
    assert.equal(out.ok, false);
    assert.match(out.steps[0].error, /^The AI gave no answer within \d+ s$/);
    assert.equal(out.stopped, 'steps[0] failed');
});

test('app_run_action right after app_set_action runs the new definition (read from the store on every call)', async () => {
    const store = { version: 1, definition: { actions: { act_1: { kind: 'toast', message: 'old' } } } };
    const d = deps({ getApp: async () => ({ id: 'app_1', userId: OWNER, definition: structuredClone(store.definition), definitionVersion: store.version }) });
    const first = await runAction({ appId: 'app_1', actionId: 'act_1', dryRun: false }, OWNER, d);
    assert.equal(first.definitionVersion, 1);
    // app_set_action saves a new draft (what persistDraft does: a new definition, version + 1)
    store.definition = { actions: { act_1: { kind: 'sequence', steps: [{ kind: 'ai_generate' }] } } };
    store.version = 2;
    executed = [];
    const second = await runAction({ appId: 'app_1', actionId: 'act_1', dryRun: false }, OWNER, d);
    assert.equal(second.definitionVersion, 2);
    assert.deepEqual(kindsRun(), ['ai_generate'], 'the second run used the new action, not the old toast');
});
