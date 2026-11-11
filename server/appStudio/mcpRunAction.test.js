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
let reads;
let readAnswer;
let budgetCalls;

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
        readData: async (_app, _model, binding, opts) => { reads.push({ binding, opts }); return readAnswer(binding, opts); },
        takeBudget: (userId, now) => { budgetCalls += 1; return takeRunBudget(userId, now, budget); },
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
    reads = []; readAnswer = () => null; budgetCalls = 0;
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

test('a server step whose guard is false is reported as skipped and never simulated or run; a true guard changes nothing', async () => {
    const steps = [
        { kind: 'create_record', tableId: 'tbl_a', values: {}, guard: 'vars.go == true' },
        { kind: 'ai_generate', resultVar: 'summary', guard: 'vars.go == true' },
    ];
    const held = await run({ kind: 'sequence', steps }, { scope: { vars: { go: false } } });
    assert.deepEqual(held.steps.map((s) => [s.kind, s.status]), [['create_record', 'skipped'], ['ai_generate', 'skipped']]);
    assert.match(held.steps[0].error, /^guard: /);
    assert.equal(held.steps[0].result, undefined, 'no wouldWrite for a step the server would skip');
    assert.deepEqual(kindsRun(), []);
    const open = await run({ kind: 'sequence', steps }, { scope: { vars: { go: true } } });
    assert.deepEqual(open.steps.map((s) => [s.kind, s.status]), [['create_record', 'skipped'], ['ai_generate', 'ok']]);
    assert.deepEqual(open.steps[0].result, { wouldWrite: { kind: 'create_record', tableId: 'tbl_a' } });
});

test('the step context says dryRun, so a dry run or a test writes no KB query log', async () => {
    const step = { kind: 'ai_generate', prompt: { kind: 'static', value: 'x' }, resultVar: 'r' };
    await run({ kind: 'sequence', steps: [step] });
    assert.equal(executed[0].ctx.dryRun, true);
    executed = [];
    await run({ kind: 'sequence', steps: [step] }, { dryRun: false });
    assert.equal(executed[0].ctx.dryRun, false);
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

test('dryRun wouldSend resolves `to` like the real email step: a records-bound `to` is not read and has no recipient', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { ...EMAIL, to: { kind: 'records', tableId: 'tbl_a', pick: 'email' } },
    ] });
    assert.equal(reads.length, 0, 'the preview triggers no data read');
    assert.equal(executed.length, 0);
    const mail = out.steps.find((s) => s.kind === 'send_email');
    assert.equal(mail.status, 'skipped');
    assert.deepEqual(mail.result, { wouldSend: { to: null, subject: 'Hello', mode: 'send' } });
    assert.ok(out.notes.some((n) => n.startsWith('steps[0]: send_email does not read a records binding')), 'a note says the step would have no recipient');
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

test('scope.trigger mocks what started a trigger run: the steps read it, its writes name no origin, a malformed one is refused', async () => {
    const trigger = { kind: 'record', record: { event: 'update', id: 'r1', row: { status: 'done' }, before: { status: 'new' }, changed: ['status'] } };
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'set_variable', name: 'was', value: { kind: 'formula', expr: 'trigger.record.before.status' } },
        { kind: 'create_record', tableId: 'tbl_a', values: {} },
    ] }, { dryRun: false, scope: { trigger } }, OWNER, { buildScope: (ctx) => ({ vars: ctx.vars, ...(ctx.trigger ? { trigger: ctx.trigger } : {}) }) });
    assert.equal(out.ok, true);
    assert.equal(out.vars.was, 'new');
    assert.deepEqual(executed[0].ctx.trigger, trigger);
    assert.equal(executed[0].ctx.writeSource, undefined, 'a test run never starts a record trigger');
    for (const bad of [{ kind: 'nope' }, { kind: 'record', webhook: {} }, { kind: 'record', record: 'x' }, 'record']) {
        assert.match((await run({ kind: 'sequence', steps: [] }, { scope: { trigger: bad } })).error, /scope\.trigger is/, JSON.stringify(bad));
    }
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

test('the per-user rate limit: the eleventh live call within a minute is refused, another user is not', async () => {
    // Live runs are charged up front. (A dry run is charged only when a step reaches the
    // executor: see the mock tests below.)
    budget = 10;
    for (let i = 0; i < 10; i += 1) assert.equal((await run({ kind: 'toast' }, { dryRun: false })).ok, true);
    const eleventh = await run({ kind: 'toast' }, { dryRun: false });
    assert.match(eleventh.error, /Too many app_run_action calls/);
    assert.match(eleventh.error, /STUDIO_MCP_RUN_ACTION_PER_MINUTE=10/);
    clock += 61_000;
    assert.equal((await run({ kind: 'toast' }, { dryRun: false })).ok, true, 'the window moves on');
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

// ── Data bindings on the server (like a click) ─────────────────────────────────

test('a loop over a records binding runs in app_run_action', async () => {
    const rows = [{ id: 'r1', title: 'One' }, { id: 'r2', title: 'Two' }, { id: 'r3', title: 'Three' }];
    readAnswer = (binding) => (binding.kind === 'records' ? rows : null);
    const source = { kind: 'records', tableId: 'tbl_tickets', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.status' } }] };
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'loop', source, itemVar: 'row', steps: [{ kind: 'ai_generate', prompt: 'Summarise {{vars.row.title}}' }] },
    ] }, { scope: { vars: { status: 'open' } } });
    assert.equal(out.ok, true);
    assert.deepEqual(executed.map((e) => e.ctx.item), rows, 'the body ran once per row, with item = that row');
    assert.deepEqual(executed.map((e) => e.ctx.vars.row.id), ['r1', 'r2', 'r3']);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].binding.limit, 50, 'no limit on the binding: what a screen gets');
    assert.equal(reads[0].opts.maxRows, 200, 'a loop source reads at most the loop cap');
    assert.equal(reads[0].opts.role, 'owner');
    // The formula-valued filter is resolved by the read, through resolveValue.
    assert.equal(reads[0].opts.resolveValue(source.filter[0].value), 'open');
    assert.deepEqual(out.steps[0].result, { iterations: 3 });
    assert.deepEqual(out.steps.filter((s) => s.kind === 'ai_generate').map((s) => s.iteration), [0, 1, 2]);
    assert.equal(out.notes.join(' ').includes('not available'), false);
});

test('set_variable from a record binding applies its path; a null read says why', async () => {
    readAnswer = (binding) => (binding.tableId === 'tbl_a' ? { id: 'r1', customer: { name: 'Ada' } } : null);
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'set_variable', name: 'who', value: { kind: 'record', tableId: 'tbl_a', path: 'customer.name' } },
        { kind: 'set_variable', name: 'gone', value: { kind: 'records', tableId: 'tbl_missing' } },
    ] });
    assert.equal(out.ok, true);
    assert.equal(out.vars.who, 'Ada');
    assert.equal(out.vars.gone, null);
    assert.match(out.notes.join(' '), /steps\[1\]: the records binding returned nothing .*app_query_data/);
});

test('a required filter without a value reads no rows and does not query', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'set_variable', name: 'rows', value: { kind: 'records', tableId: 'tbl_a', filter: [{ field: 'ticket', op: 'eq', value: { kind: 'formula', expr: 'vars.ticket' }, required: true }] } },
    ] });
    assert.deepEqual(out.vars.rows, []);
    assert.equal(reads.length, 0);
    assert.match(out.notes.join(' '), /required filter/);
});

test('a safe refusal from the read stops the run with its message', async () => {
    readAnswer = () => { const e = new Error('This table is linked to a datatable you can no longer read'); e.safe = true; e.status = 501; throw e; };
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'loop', source: { kind: 'records', tableId: 'tbl_a' }, steps: [{ kind: 'ai_generate' }] },
        { kind: 'ai_generate' },
    ] });
    assert.equal(out.ok, false);
    assert.equal(out.stopped, 'steps[0] failed');
    assert.equal(out.steps[0].error, 'This table is linked to a datatable you can no longer read');
    assert.equal(executed.length, 0);
});

test('an unsafe read failure is "returned nothing", never its message', async () => {
    readAnswer = () => { throw new Error('relation "secret_internal" does not exist'); };
    const out = await run({ kind: 'sequence', steps: [{ kind: 'set_variable', name: 'x', value: { kind: 'records', tableId: 'tbl_a' } }] });
    assert.equal(out.ok, true);
    assert.equal(JSON.stringify(out).includes('secret_internal'), false);
});

test('the read cap stops the run and names the variable', async () => {
    readAnswer = () => [{ id: 1 }];
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'loop', source: { kind: 'formula', expr: 'vars.n' }, steps: [{ kind: 'set_variable', name: 'r', value: { kind: 'records', tableId: 'tbl_a' } }] },
    ] }, { scope: { vars: { n: [1, 2, 3, 4] } } }, OWNER, { limits: () => ({ perMinute: budget, budgetMs: 60_000, maxExecuted: 500, maxReads: 2 }) });
    assert.equal(out.ok, false);
    assert.equal(reads.length, 2);
    assert.match(out.steps.find((s) => s.status === 'error').error, /more than 2 times \(STUDIO_MCP_RUN_ACTION_MAX_READS=2\)/);
});

test('a binding that returns its limit says so', async () => {
    readAnswer = (_b, opts) => Array.from({ length: 50 }, (_, i) => ({ id: i, max: opts.maxRows }));
    const out = await run({ kind: 'sequence', steps: [{ kind: 'set_variable', name: 'r', value: { kind: 'records', tableId: 'tbl_a' } }] });
    assert.match(out.notes.join(' '), /returned its limit of 50 rows/);
});

// ── expectVersion ─────────────────────────────────────────────────────────────

test('expectVersion: a mismatch is refused before any budget is taken', async () => {
    appRow.definitionVersion = 7;
    const out = await run({ kind: 'sequence', steps: [{ kind: 'ai_generate' }] }, { expectVersion: 6, dryRun: false });
    assert.match(out.error, /The saved draft is version 7, not 6/);
    assert.match(out._fixHint, /app_get_action/);
    assert.equal(budgetCalls, 0);
    assert.equal(executed.length, 0);
    const ok = await run({ kind: 'sequence', steps: [{ kind: 'ai_generate' }] }, { expectVersion: 7 });
    assert.equal(ok.ok, true);
    assert.equal(ok.definitionVersion, 7);
    const bad = await run({ kind: 'toast' }, { expectVersion: 'x' });
    assert.match(bad.error, /expectVersion/);
});

// ── Mocks ────────────────────────────────────────────────────────────────────

test('a mocked ai_generate never reaches the executor; resultVar gets { text }', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'ai_generate', prompt: 'Summarise {{vars.ticket}}', resultVar: 'summary', writeTo: { tableId: 'tbl_a' } },
        { kind: 'set_variable', name: 'copy', value: { kind: 'formula', expr: 'vars.summary.text' } },
    ] }, { mock: { 'steps[0]': 'A short summary' }, scope: { vars: { ticket: 'T-1' } } });
    assert.equal(out.ok, true);
    assert.equal(executed.length, 0, 'not sent to executeStep');
    assert.equal(out.steps[0].mocked, true);
    assert.deepEqual(out.vars.summary, { text: 'A short summary', citations: [] });
    assert.equal(out.vars.copy, 'A short summary');
    assert.equal(out.free, true);
    assert.equal(out.mocked, 1);
    assert.equal(budgetCalls, 0);
});

test('a mocked $error fails the step and stops the run', async () => {
    const out = await run({ kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'x' }, { kind: 'ai_generate', prompt: 'y' }] },
        { mock: { 'steps[0]': { $error: 'The model refused', $code: 'refused' } } });
    assert.equal(out.ok, false);
    assert.equal(out.stopped, 'steps[0] failed');
    assert.equal(out.steps[0].error, 'The model refused');
    assert.equal(out.steps[0].code, 'refused');
    assert.equal(executed.length, 0);
});

test('a mock key that is not a mockable step is refused with the mockable paths', async () => {
    const action = { kind: 'sequence', steps: [{ kind: 'toast' }, { kind: 'condition', expr: 'vars.x', then: [{ kind: 'ai_extract' }] }] };
    const out = await run(action, { mock: { 'steps[0]': 'x' } });
    assert.match(out.error, /"steps\[0\]", not an AI or read step/);
    assert.match(out._fixHint, /steps\[1\]\.then\[0\] \(ai_extract\)/);
    const typo = await run(action, { mock: { 'steps[9]': 'x' } });
    assert.match(typo.error, /not an AI or read step/);
    const shape = await run(action, { mock: ['x'] });
    assert.match(shape.error, /mock must be an object/);
    assert.equal(budgetCalls, 0);
});

test('budget: fully mocked dry runs are free, an unmocked AI step pays, a live run pays up front, the free window still holds', async () => {
    budget = 2;
    const ai = { kind: 'sequence', steps: [{ kind: 'toast' }, { kind: 'ai_generate', prompt: 'p' }] };
    assert.equal((await run(ai)).free, false, 'unmocked: charged when the AI step runs');
    assert.equal((await run(ai)).free, false);
    for (let i = 0; i < 11; i += 1) {
        const mocked = await run(ai, { mock: { 'steps[1]': 'ok' } });
        assert.equal(mocked.ok, true);
        assert.equal(mocked.free, true);
    }
    const spent = await run(ai);
    assert.equal(spent.ok, false);
    assert.equal(spent.steps[1].code, 'rate_limited');
    assert.match(spent.steps[1].error, /steps\[1\] \(ai_generate\) is not mocked and would call the model; mock it to run for free/);
    assert.equal(spent.steps[0].status, 'skipped', 'the client step before it was walked normally');
    const live = await run({ kind: 'toast' }, { dryRun: false });
    assert.match(live.error, /Too many app_run_action calls/, 'a live run is charged up front');
    // The hygiene window: every call takes it, mocked or not.
    resetRunWindows();
    const limits = () => ({ perMinute: 10, budgetMs: 60_000, maxExecuted: 500, freePerMinute: 3 });
    for (let i = 0; i < 3; i += 1) assert.equal((await run({ kind: 'toast' }, {}, OWNER, { limits })).ok, true);
    const fourth = await run({ kind: 'toast' }, {}, OWNER, { limits });
    assert.match(fourth.error, /limit 3 per minute per user, STUDIO_MCP_RUN_ACTION_FREE_PER_MINUTE=3/);
});

test('the default free window is 120 calls a minute', async () => {
    for (let i = 0; i < 120; i += 1) assert.equal((await run({ kind: 'toast' })).ok, true);
    const over = await run({ kind: 'toast' });
    assert.match(over.error, /limit 120 per minute per user/);
});

test('dryRun: a record write shows the values and record id it would use; send_email has no body', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'update_record', tableId: 'tbl_a', recordId: { kind: 'formula', expr: 'vars.id' }, values: { status: { kind: 'static', value: 'done' }, note: { kind: 'formula', expr: 'form.note' } } },
        EMAIL,
    ] }, { scope: { vars: { id: 'r7' }, form: { note: 'checked' } } });
    assert.deepEqual(out.steps[0].result, { wouldWrite: { kind: 'update_record', tableId: 'tbl_a', values: { status: 'done', note: 'checked' }, recordId: 'r7' } });
    assert.equal(JSON.stringify(out).includes('SECRET BODY'), false);
});

test('every report step carries its duration', async () => {
    const out = await run({ kind: 'sequence', steps: [{ kind: 'toast' }, { kind: 'ai_generate' }] });
    assert.ok(out.steps.every((s) => typeof s.ms === 'number' && s.ms >= 0));
});

test('the app_run_action description no longer says data bindings are unavailable, and documents mock and expectVersion', () => {
    const { buildToolList } = require('./mcpBuilder');
    const tool = buildToolList().find((t) => t.name === 'app_run_action');
    assert.equal(/not available/i.test(tool.description), false);
    assert.match(tool.description, /records binding/);
    assert.ok(tool.inputSchema.properties.mock);
    assert.ok(tool.inputSchema.properties.expectVersion);
});

// ── call_action ─────────────────────────────────────────────────────────────

// buildScope with the params root, as actionExecutor/shared.buildServerScope has it.
const runDef = (actions, actionId, args = {}) => {
    appRow.definition = { actions };
    return runAction({ appId: 'app_1', actionId, ...args }, OWNER, deps({
        buildScope: (ctx) => ({ vars: ctx.vars, form: ctx.formValues, item: ctx.item, index: ctx.index, params: ctx.params }),
    }));
};

test('call_action is followed: the callee step sees params, its result lands in resultVar', async () => {
    const out = await runDef({
        act_main: { kind: 'sequence', steps: [
            { kind: 'call_action', actionId: 'act_sum', params: { n: { kind: 'static', value: 2 } }, resultVar: 'sum' },
        ] },
        act_sum: { kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'x', resultVar: 'r' }] },
    }, 'act_main', { dryRun: false });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0].ctx.params, { n: 2 });
    assert.equal(out.vars.sum, 'a summary');
    assert.ok(out.steps.some((s) => s.path === 'steps[0].call.steps[0]'), JSON.stringify(out.steps.map((s) => s.path)));
});

test('a mock on a called action\'s step (steps[0].call.steps[0]) answers instead of the executor', async () => {
    const out = await runDef({
        act_main: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_sum', resultVar: 'sum' }] },
        act_sum: { kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'x', resultVar: 'r' }] },
    }, 'act_main', { mock: { 'steps[0].call.steps[0]': 'mocked text' } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(executed.length, 0);
    assert.deepEqual(out.vars.sum, { text: 'mocked text', citations: [] });
});

test('scope.params tests a called action on its own', async () => {
    const out = await runDef({
        act_sum: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'got', value: { kind: 'formula', expr: 'params.n' } }] },
    }, 'act_sum', { scope: { params: { n: 7 } } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.vars.got, 7);
});

// ── Error handling (package 2) ──────────────────────────────────────────────

const withError = { buildScope: (ctx) => ({ vars: ctx.vars, form: ctx.formValues, item: ctx.item, index: ctx.index, error: ctx.error ?? null }) };

test('spec: a failing ai_generate with onError writes a fallback and the run continues (handled: true)', async () => {
    failOn = 'ai_generate';
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'ai_generate', prompt: 'x', resultVar: 'draft', onError: { steps: [
            { kind: 'set_variable', name: 'fallback', value: { kind: 'formula', expr: 'error.message' } },
        ] } },
        { kind: 'kb_query', query: { kind: 'formula', expr: 'vars.fallback' } },
    ] }, {}, OWNER, withError);
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(out.steps[0].status, 'error');
    assert.equal(out.steps[0].handled, true);
    assert.equal(out.steps[1].path, 'steps[0].onError.steps[0]');
    assert.equal(out.vars.fallback, 'Step failed');
    assert.deepEqual(kindsRun(), ['ai_generate', 'kb_query'], 'the step after the handler ran');
});

test('spec: retry succeeds on the second attempt, driven by a $sequence mock', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'ai_generate', prompt: 'x', resultVar: 'draft', retry: { times: 2, delayMs: 0 } },
    ] }, { mock: { 'steps[0]': { $sequence: [{ $error: 'overloaded', $code: 'provider_unavailable' }, 'second time lucky'] } } });
    assert.equal(out.ok, true);
    assert.equal(out.steps[0].status, 'ok');
    assert.equal(out.steps[0].attempts, 2);
    assert.deepEqual(out.vars.draft, { text: 'second time lucky', citations: [] });
    assert.equal(out.mocked, 2, 'each attempt took its mocked answer');
    assert.equal(executed.length, 0);
});

test('$retryable: false in a mock is not retried; the last $sequence answer repeats', async () => {
    const once = await run({ kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'x', retry: { times: 3, delayMs: 0 } }] },
        { mock: { 'steps[0]': { $error: 'bad prompt', $retryable: false } } });
    assert.equal(once.ok, false);
    assert.equal(once.mocked, 1);
    const repeat = await run({ kind: 'sequence', steps: [{ kind: 'ai_generate', prompt: 'x', retry: { times: 2, delayMs: 0 } }] },
        { mock: { 'steps[0]': { $sequence: [{ $error: 'down' }] } } });
    assert.equal(repeat.ok, false);
    assert.equal(repeat.steps[0].attempts, 3);
});

test('a handler step is mockable by its path, and error is in its scope', async () => {
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'ai_generate', prompt: 'x', onError: { steps: [{ kind: 'ai_generate', prompt: 'apologise for {{error.message}}', resultVar: 'sorry' }] } },
    ] }, { mock: { 'steps[0]': { $error: 'nope', $retryable: false }, 'steps[0].onError.steps[0]': 'Sorry!' } });
    assert.equal(out.ok, true);
    assert.deepEqual(out.vars.sorry, { text: 'Sorry!', citations: [] });
    assert.equal(out.steps.find((s) => s.path === 'steps[0].onError.steps[0]').mocked, true);
});

test('onError stop: true ends the run quietly and ok stays true', async () => {
    failOn = 'kb_query';
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'kb_query', onError: { steps: [{ kind: 'toast', message: 'x' }], stop: true } },
        { kind: 'ai_generate', prompt: 'never' },
    ] });
    assert.equal(out.ok, true);
    assert.match(out.stopped, /onError handler ends the run/);
    assert.deepEqual(kindsRun(), ['kb_query']);
});

test('dryRun: a transaction is skipped with the writes it would make', async () => {
    const out = await run({ kind: 'sequence', steps: [{ kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: {} },
        { kind: 'update_record', tableId: 'tbl_lines', recordId: { kind: 'static', value: 'r' }, values: {} },
    ] }] });
    assert.equal(out.steps[0].status, 'skipped');
    assert.deepEqual(out.steps[0].result, { wouldWrite: [{ kind: 'create_record', tableId: 'tbl_orders' }, { kind: 'update_record', tableId: 'tbl_lines' }] });
    assert.equal(executed.length, 0);
    const live = await run({ kind: 'sequence', steps: [{ kind: 'transaction', steps: [{ kind: 'create_record', tableId: 't', values: {} }] }] }, { dryRun: false });
    assert.equal(live.steps[0].status, 'ok', 'a live run commits it through the executor');
    assert.deepEqual(kindsRun(), ['transaction']);
});

// ── Background actions ──────────────────────────────────────────────────────

function fakeRuns() {
    const rows = [];
    return {
        rows,
        store: () => ({
            insertRunningRun: async (r) => {
                const holder = rows.find((x) => x.status === 'running' && x.lockKey && x.lockKey === r.lockKey);
                if (holder) return { ok: false, holder: { ...holder, startedAt: new Date().toISOString() } };
                rows.push({ ...r, status: 'running' });
                return { ok: true };
            },
            finishRun: async (id, f) => { const row = rows.find((x) => x.id === id); if (row) row.status = f.status; return true; },
        }),
    };
}

test('a background action reports its lockKey and progressVar; a dry run takes no lock', async () => {
    const runs = fakeRuns();
    const action = { kind: 'sequence', background: true, lockKey: { kind: 'formula', expr: 'form.id' }, progressVar: 'status', steps: [{ kind: 'create_record', tableId: 't' }] };
    const out = await run(action, { scope: { form: { id: 'o1' } } }, OWNER, { actionRuns: runs.store });
    assert.deepEqual(out.background, { lockKey: 'o1', progressVar: 'status' });
    assert.ok(out.notes.some((n) => /runs as a background job/.test(n)));
    assert.equal(runs.rows.length, 0, 'dryRun takes no lock');
});

test('a live run of a locked background action is refused while a job holds the key, and frees it at the end', async () => {
    const runs = fakeRuns();
    const action = { kind: 'sequence', background: true, lockKey: { kind: 'formula', expr: 'form.id' }, steps: [{ kind: 'create_record', tableId: 't' }] };
    runs.rows.push({ id: 'sar_held', lockKey: 'o2', status: 'running' });
    const refused = await run(action, { dryRun: false, scope: { form: { id: 'o2' } } }, OWNER, { actionRuns: runs.store });
    assert.match(refused.error, /already running for the same item/);
    assert.equal(executed.length, 0);
    const ok = await run(action, { dryRun: false, scope: { form: { id: 'o3' } } }, OWNER, { actionRuns: runs.store });
    assert.equal(ok.ok, true);
    const mine = runs.rows.find((r) => r.lockKey === 'o3');
    assert.equal(mine.origin, 'mcp');
    assert.equal(mine.status, 'success');
});

test('dryRun: a filter-mode delete reports how many rows it would change, read only', async () => {
    const previews = [];
    const out = await run({ kind: 'sequence', steps: [
        { kind: 'delete_record', tableId: 'tbl_a', filter: [{ field: 'status', op: 'eq', value: 'done' }], limit: 2 },
    ] }, {}, OWNER, { previewWrite: async (_app, _model, step) => { previews.push(step.kind); return { matched: 3, wouldAffect: 2, limit: 2 }; } });
    assert.deepEqual(out.steps[0].result, { wouldWrite: { kind: 'delete_record', tableId: 'tbl_a', matched: 3, wouldAffect: 2, limit: 2 } });
    assert.deepEqual(previews, ['delete_record']);
    assert.deepEqual(kindsRun(), [], 'nothing executed');
});
