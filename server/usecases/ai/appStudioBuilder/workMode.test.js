'use strict';
/**
 * The App Studio builder's work modes (workMode.mts) and how the build loop
 * applies them (buildTools.js): the question card, the per-mode caps, discuss
 * refusing everything that is not a read, the note for the next turn, and a
 * request without a workMode changing nothing.
 *
 * Run: cd server && node --test usecases/ai/appStudioBuilder/workMode.test.js
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('./workMode.mts');
const { MUTATING_TOOLS, TOOL_SCHEMAS } = require('../../../appStudio/builderTools');
const { sanitizeHistory, WORK_MODE_PREFIX } = require('./turnLoop');
const { renderWorkModeNote } = require('./turnNotes');
const { runRoundTools } = require('../../../routes/ai/appStudioBuilder/buildTools');
const { classifyTurnOutcome, persistTurnSnapshot } = require('./turnClosing');

const q = (n, extra = {}) => ({ prompt: `Question ${n}?`, options: ['Yes', 'No', 'Maybe'], ...extra });
const many = (n) => ({ questions: Array.from({ length: n }, (_, i) => q(i + 1)) });
const ask = (args, o = {}) => W.askQuestions(args, { mode: 'plan', approved: false, closed: false, ...o });

test('workMode is one of describe / discuss / plan / build', () => {
    assert.deepEqual([...W.WORK_MODES], ['describe', 'discuss', 'plan', 'build']);
});

test('the question cap per mode: describe 4, plan 6, build 1, discuss and an approved plan 0', () => {
    assert.equal(ask(many(6), { mode: 'describe' }).questions.length, 4);
    assert.equal(ask(many(9), { mode: 'plan' }).questions.length, 6);
    assert.equal(ask(many(3), { mode: 'build' }).questions.length, 1);
    assert.match(ask(many(1), { mode: 'discuss' }).error, /Discuss mode/);
    assert.match(ask(many(1), { mode: 'describe', approved: true }).error, /approved/);
    assert.match(ask(many(1), { mode: 'build', approved: true }).error, /approved/);
});

test('a cut question is reported to the model so it can list it as an assumption', () => {
    const r = ask(many(6), { mode: 'describe' });
    assert.match(r.result._note, /2 question\(s\) were not shown \(limit 4\)/);
});

test('ONE question round per plan: a second call is refused and points at app_propose_plan', () => {
    const plan = ask(many(2), { mode: 'plan', closed: true });
    assert.match(plan.error, /app_propose_plan now/);
    assert.match(plan.error, /assumptions/);
    assert.match(ask(many(1), { mode: 'build', closed: true }).error, /Do not ask again/);
});

test('questions are validated and cut, not rejected: bad ones dropped, markers and (recommended) stripped', () => {
    const r = W.writeQuestions({
        questions: [
            null,
            { prompt: '   ', options: ['a', 'b'] },
            { prompt: 'No options?', options: ['only one'] },
            { prompt: '1. Who uses it?', header: '  The   users  ', options: ['- Staff (recommended)', '2) Customers', 'Everyone', 'Other', 'Fifth is cut'] },
            { prompt: 'who uses it?', options: ['dup', 'dup2'] },
            { prompt: 'Which data?', options: ['Orders', 7, 'Invoices'] },
        ],
    });
    assert.equal(r.questions.length, 2);
    assert.equal(r.questions[0].prompt, 'Who uses it?');
    assert.equal(r.questions[0].header, 'The users');
    assert.deepEqual(r.questions[0].options, ['Staff', 'Customers', 'Everyone', 'Other']);
    assert.deepEqual(r.questions[1].options, ['Orders', 'Invoices']);
    for (const x of r.questions) assert.match(x.id, /^[0-9a-f-]{36}$/);
    assert.equal('header' in r.questions[1], false);
});

test('nothing usable: null from writeQuestions, a clear error from the tool', () => {
    assert.equal(W.writeQuestions({ questions: [{ prompt: 'x', options: ['a'] }] }), null);
    assert.equal(W.writeQuestions({}), null);
    assert.equal(W.writeQuestions(null), null);
    assert.match(ask({ questions: [] }).error, /Provide 1-6 questions/);
    assert.match(ask({ questions: [] }, { mode: 'describe' }).error, /Provide 1-4 questions/);
});

test('the tool schema: questions[ {prompt, options 2..4, header?} ] with maxItems 6', () => {
    const p = W.ASK_QUESTIONS_TOOL.function.parameters;
    assert.equal(W.ASK_QUESTIONS_TOOL.function.name, 'app_ask_questions');
    assert.equal(p.properties.questions.maxItems, 6);
    const item = p.properties.questions.items;
    assert.equal(item.properties.options.minItems, 2);
    assert.equal(item.properties.options.maxItems, 4);
    assert.deepEqual(Object.keys(item.properties), ['prompt', 'options', 'header']);
});

test('discuss fails closed: every mutating tool, plan, finalize and an unknown tool are refused; reads pass', () => {
    for (const name of MUTATING_TOOLS) assert.match(W.gateWorkModeCall(name, 'discuss') || '', /Discuss mode/, name);
    for (const name of ['app_propose_plan', 'app_finalize', 'app_apply_template', 'app_save_as_template', 'app_mark_phase', 'app_set_plan', 'app_ask_questions', 'app_invented_next_year', '']) {
        assert.ok(W.gateWorkModeCall(name, 'discuss'), name);
    }
    for (const name of ['app_get_draft', 'app_query_data', 'app_dry_run', 'app_inspect_catalog', 'app_search_documents']) {
        assert.equal(W.gateWorkModeCall(name, 'discuss'), null, name);
    }
});

test('the discuss allow-list names real tools and none that mutates', () => {
    const real = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
    for (const name of W.DISCUSS_READ_TOOLS) {
        assert.ok(real.has(name) || ['app_search_documents', 'app_read_document'].includes(name), `${name} is not a tool`);
        assert.equal(MUTATING_TOOLS.has(name), false, name);
    }
});

test('the other modes gate nothing here', () => {
    for (const mode of ['describe', 'plan', 'build']) assert.equal(W.gateWorkModeCall('app_add_screen', mode), null);
});

test('the directive: describe has the everyday-words rule, plan not; ask-first only on a fresh draft', () => {
    const base = { approved: false, fresh: false, closed: false };
    const d = W.workModeDirective({ ...base, mode: 'describe', fresh: true });
    assert.match(d, /everyday words/);
    assert.match(d, /NEW app/);
    assert.match(d, /at most 4/);
    const p = W.workModeDirective({ ...base, mode: 'plan' });
    assert.doesNotMatch(p, /everyday words/);
    assert.doesNotMatch(p, /NEW app/);
    assert.match(p, /at most 6/);
    assert.match(W.workModeDirective({ ...base, mode: 'plan', closed: true }), /spent.*app_propose_plan now/);
    assert.match(W.workModeDirective({ ...base, mode: 'build' }), /at most ONE question/);
    assert.match(W.workModeDirective({ ...base, mode: 'discuss' }), /app must stay unchanged/);
    const approved = W.workModeDirective({ ...base, mode: 'describe', approved: true });
    assert.match(approved, /approved plan/);
    assert.match(approved, /everyday words/);
    assert.doesNotMatch(W.workModeDirective({ ...base, mode: 'plan', approved: true }), /everyday words/);
});

const prior = [{ id: '1', prompt: 'Who uses it?', options: ['Staff', 'Customers'] }, { id: '2', prompt: 'Which data?', options: ['Orders', 'Invoices'] }];
const note = (o) => W.questionStatusNote({ prior, answeredText: '', mode: 'plan', approved: false, ...o });

test('next turn, answered on the card: do not ask again, propose the plan now', () => {
    const n = note({ answeredText: 'Q: Who uses it?\nA: Staff\n\nQ: Which data?\nA: Orders' });
    assert.match(n, /answered the 2 questions/);
    assert.match(n, /Do not ask them again/);
    assert.match(n, /app_propose_plan now/);
    assert.doesNotMatch(note({ answeredText: 'Q: Who uses it?\nA: Staff', mode: 'build' }), /app_propose_plan/);
    assert.match(note({ answeredText: 'Q: Who uses it?\nA: Staff', approved: true }), /approved plan/);
});

test('next turn, typed instead: use it, take the suggested answers, do not ask again', () => {
    const n = note({ answeredText: 'just make a simple order list' });
    assert.match(n, /1\) Who uses it\? \(suggested: Staff\)/);
    assert.match(n, /2\) Which data\? \(suggested: Orders\)/);
    assert.match(n, /instead of using the card/);
    assert.match(n, /Do not ask these again/);
});

test('no open questions: no status line', () => {
    assert.equal(note({ prior: null }), '');
    assert.equal(note({ prior: [] }), '');
});

test('the WORK MODE note is a machine note: absent without a mode, stripped from history with one', () => {
    assert.equal(renderWorkModeNote(null), null);
    const n = renderWorkModeNote({ mode: 'plan', approved: false, fresh: true, closed: false }, { priorQuestions: prior, message: 'hi' });
    assert.ok(n.startsWith(WORK_MODE_PREFIX));
    assert.match(n, /Your last turn asked/);
    assert.deepEqual(sanitizeHistory([{ role: 'user', content: n }]), []);
});

// ── The build loop ───────────────────────────────────────────────────

function loop(workMode) {
    const sent = [];
    const messages = [];
    const draftWrap = { def: { screens: [] }, userId: 'u1', appId: null, builderSessionId: 's1', _todos: [] };
    const ctx = {
        send: (name, data) => sent.push({ name, data }), sendError: () => {}, messages, draftWrap,
        modelSupportsVision: false, approvedPlanForTurn: null, writeCheckpoint: async () => {}, workMode,
    };
    const ls = { toolRefusalStreak: new Map(), pendingVisionImages: [], escalateNextRound: false, repeatedStop: null };
    const turn = { toolCallCount: 0, mutatingToolCalls: 0, builtThisTurn: false, proposedPlan: null, reviewQuestions: null, persistBroken: false };
    const call = (name, args) => ({ id: `c_${name}`, function: { name, arguments: JSON.stringify(args) } });
    return { sent, messages, draftWrap, ctx, ls, turn, call };
}
const toolMessage = (messages, i = 0) => JSON.parse(messages.filter((m) => m.role === 'tool')[i].content);
const state = (mode, o = {}) => ({ mode, approved: false, fresh: true, closed: false, ...o });

test('discuss: a mutating call is refused, the draft is untouched and no draft event goes out', async () => {
    const t = loop(state('discuss'));
    const before = JSON.stringify(t.draftWrap.def);
    const mutated = await runRoundTools(t.turn, [t.call('app_add_screen', { name: 'Home' }), t.call('app_finalize', {}), t.call('app_made_up', {})], t.ctx, t.ls);
    assert.equal(mutated, false);
    assert.equal(JSON.stringify(t.draftWrap.def), before);
    for (let i = 0; i < 3; i++) assert.match(toolMessage(t.messages, i).error, /Discuss mode/);
    assert.equal(t.sent.some((e) => e.name === 'draft'), false);
    assert.equal(t.turn.mutatingToolCalls, 0);
});

test('discuss: a read still runs', async () => {
    const t = loop(state('discuss'));
    await runRoundTools(t.turn, [t.call('app_get_draft', {})], t.ctx, t.ls);
    assert.equal(toolMessage(t.messages).error, undefined);
});

test('an accepted card sends review_questions once, records the questions and stops the rest of the round', async () => {
    const t = loop(state('describe'));
    await runRoundTools(t.turn, [t.call('app_ask_questions', many(6)), t.call('app_ask_questions', many(2)), t.call('app_add_screen', { name: 'Home' })], t.ctx, t.ls);
    const events = t.sent.filter((e) => e.name === 'review_questions');
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0].data), ['questions']);
    assert.equal(events[0].data.questions.length, 4);
    for (const x of events[0].data.questions) assert.deepEqual(Object.keys(x).sort(), ['id', 'options', 'prompt']);
    assert.deepEqual(t.turn.reviewQuestions, events[0].data.questions);
    assert.equal(toolMessage(t.messages, 0).awaitingAnswers, true);
    assert.match(toolMessage(t.messages, 1).error, /Wait for the user/);
    assert.match(toolMessage(t.messages, 2).error, /Wait for the user/);
    assert.equal(t.sent.some((e) => e.name === 'draft'), false);
});

test('a second round is refused in the loop and sends no card', async () => {
    const t = loop(state('plan', { closed: true }));
    await runRoundTools(t.turn, [t.call('app_ask_questions', many(2))], t.ctx, t.ls);
    assert.match(toolMessage(t.messages).error, /app_propose_plan now/);
    assert.equal(t.sent.some((e) => e.name === 'review_questions'), false);
    assert.equal(t.turn.reviewQuestions, null);
});

test('build caps the card at one question', async () => {
    const t = loop(state('build'));
    await runRoundTools(t.turn, [t.call('app_ask_questions', many(3))], t.ctx, t.ls);
    assert.equal(t.turn.reviewQuestions.length, 1);
});

test('without a workMode nothing changes: the question tool is unknown and a mutating call goes through the normal path', async () => {
    const t = loop(null);
    await runRoundTools(t.turn, [t.call('app_ask_questions', many(2)), t.call('app_get_draft', {})], t.ctx, t.ls);
    assert.match(toolMessage(t.messages, 0).error, /Unknown app builder tool/);
    assert.equal(toolMessage(t.messages, 1).error, undefined);
    assert.equal(t.sent.some((e) => e.name === 'review_questions'), false);
    assert.equal(t.turn.reviewQuestions, null);
});

test('a plan proposed in this turn blocks a question card on top of it', async () => {
    const t = loop(state('plan'));
    t.turn.proposedPlan = { planId: 'p1', plan: {} };
    await runRoundTools(t.turn, [t.call('app_ask_questions', many(2))], t.ctx, t.ls);
    assert.match(toolMessage(t.messages).error, /already proposed a plan/);
    assert.equal(t.sent.some((e) => e.name === 'review_questions'), false);
});

test('discuss wins over an approved plan in the directive: no "build it" next to a gate that refuses writes', () => {
    const d = W.workModeDirective({ mode: 'discuss', approved: true, fresh: false, closed: false });
    assert.match(d, /app must stay unchanged/);
    assert.doesNotMatch(d, /build it/);
});

test('the auto-finalize net never saves in discuss or with an open card', async () => {
    const { runAutoFinalizeNet } = require('./turnClosing');
    const turn = { iter: 99, lastFinalized: false, persistBroken: false, proposedPlan: null, modelEndedTurn: true, builtThisTurn: true, reviewQuestions: null };
    const draftWrap = { appId: 'app_1', def: {}, dataModel: null, datasetIds: [], _ownerDatatables: [] };
    const sent = [];
    const opts = { draftWrap, iterationBudget: 10, approvedPlanForTurn: null, send: (name, data) => sent.push({ name, data }), sendError: (code) => sent.push({ name: 'error', code }) };
    assert.deepEqual(await runAutoFinalizeNet(turn, { ...opts, workMode: 'discuss' }), { continuation: null, budgetExhausted: false });
    assert.deepEqual(await runAutoFinalizeNet({ ...turn, reviewQuestions: [{ id: '1' }] }, { ...opts, workMode: 'plan' }), { continuation: null, budgetExhausted: false });
    assert.equal(sent.length, 0);
});

// ── The turn's end ───────────────────────────────────────────────────

const OUTCOME_ARGS = { awaitingPlan: false, continuation: null, budgetExhausted: false };

test('an open card classifies the turn awaiting_questions', () => {
    assert.equal(classifyTurnOutcome({ lastFinalized: false, reviewQuestions: [{}] }, OUTCOME_ARGS), 'awaiting_questions');
    assert.equal(classifyTurnOutcome({ lastFinalized: false, reviewQuestions: null }, OUTCOME_ARGS), 'incomplete');
});

async function snapshotOf(turn, { priorSnapshot = null, isApproval = false } = {}) {
    const studioAppStore = require('../../../stores/studioAppStore');
    const orig = studioAppStore.setBuilderSession;
    let saved = null;
    studioAppStore.setBuilderSession = async (_a, _u, body) => { saved = body; return { ok: true }; };
    try {
        await persistTurnSnapshot(
            { lastFinalized: false, proposedPlan: null, reviewQuestions: null, lastValidation: null, ...turn },
            {
                draftWrap: { appId: 'app_1', builderSessionId: 's1', def: { screens: [] }, _turnMessage: 'x' }, userId: 'u1', history: [],
                inboundImages: [], effectiveMessage: 'hi', proseParts: [], resolvedTier: 'smart', approvedPlanForTurn: null,
                isApproval, priorSnapshot, continuation: null,
            },
        );
    } finally { studioAppStore.setBuilderSession = orig; }
    return saved;
}

test('the snapshot keeps the open card and marks the plan\'s question round as spent', async () => {
    const reviewQuestions = [{ id: 'a', prompt: 'Who?', options: ['A', 'B'] }];
    const snap = await snapshotOf({ reviewQuestions });
    assert.deepEqual(snap.reviewQuestions, reviewQuestions);
    assert.deepEqual(snap.questionsMeta, { round: 1 });
});

test('the next turn closes the card but keeps the mark; a proposed plan, an approval or a finalize starts a new cycle', async () => {
    const priorSnapshot = { questionsMeta: { round: 1 }, reviewQuestions: [{ id: 'a' }] };
    const kept = await snapshotOf({}, { priorSnapshot });
    assert.equal('reviewQuestions' in kept, false);
    assert.deepEqual(kept.questionsMeta, { round: 1 });
    assert.equal('questionsMeta' in await snapshotOf({ proposedPlan: { planId: 'p', plan: {} } }, { priorSnapshot }), false);
    assert.equal('questionsMeta' in await snapshotOf({}, { priorSnapshot, isApproval: true }), false);
    assert.equal('questionsMeta' in await snapshotOf({ lastFinalized: true }, { priorSnapshot }), false);
});

test('a session without a work mode leaves both keys out', async () => {
    const snap = await snapshotOf({});
    assert.equal('reviewQuestions' in snap, false);
    assert.equal('questionsMeta' in snap, false);
});

// ── The prompt ───────────────────────────────────────────────────────

test('the tools array: unchanged without a workMode, plus app_ask_questions in EVERY mode (one cached menu)', async () => {
    // No database: the three best-effort lookups the assembly makes are stubbed.
    require('../../../stores/configStore').getConfig = async () => null;
    require('../../../stores/automationStore').getAutomationsForUser = async () => [];
    require('../../../automation/builderDocumentCatalog').buildDocumentCatalogForUser = async () => [];
    const { assembleTurnPrompt } = require('./promptAssembly');
    const { emptyDefinition } = require('../../../appStudio/componentSpecs');
    const run = (workMode, priorSnapshot = null) => assembleTurnPrompt({
        send: () => {}, userId: 'u1', modelId: 'claude-sonnet-5-5', resolvedTier: 'smart',
        draftWrap: { def: emptyDefinition('T'), userId: 'u1' }, priorSnapshot, isApproval: false, planMode: 'always', workMode,
        editorContext: null, inboundImages: [], modelSupportsVision: true, effectiveMessage: 'Build me an order app',
    });
    const names = (r) => r.tools.map((t) => t.function?.name || t.name);
    const base = await run(undefined);
    assert.equal(names(base).includes('app_ask_questions'), false);
    assert.equal(base.workModeState, null);
    assert.equal(JSON.stringify(base.messages).includes(WORK_MODE_PREFIX), false);
    const menus = [];
    for (const mode of W.WORK_MODES) {
        const r = await run(mode);
        menus.push(JSON.stringify(r.tools));
        assert.deepEqual(names(r), [...names(base), 'app_ask_questions']);
        assert.equal(r.workModeState.mode, mode);
        assert.equal(r.workModeState.fresh, true);
        assert.equal(r.workModeState.closed, false);
        // the system prefix is the same text with or without a mode
        assert.equal(r.messages[0].content, base.messages[0].content);
        assert.ok(r.messages.at(-1).content.includes(WORK_MODE_PREFIX));
    }
    assert.equal(new Set(menus).size, 1);
    const spent = await run('plan', { questionsMeta: { round: 1 }, reviewQuestions: [{ prompt: 'Who?', options: ['A', 'B'] }] });
    assert.equal(spent.workModeState.closed, true);
    assert.match(spent.messages.at(-1).content, /Your last turn asked: 1\) Who\?/);
});
