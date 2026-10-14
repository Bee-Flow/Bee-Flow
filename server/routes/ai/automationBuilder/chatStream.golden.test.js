/**
 * Golden behaviour of one whole builder turn (POST /stream), pinned before
 * the route was split into turnSetup / modelSelection / toolMenu / buildLoop /
 * toolDispatch / turnClosing.
 *
 * Every scenario drives the real route through the harness and compares a
 * normalised record of what left it — every SSE event with its payload, the
 * tool calls the dispatch saw, the persists, the stored builder session and
 * the shape of each model round (roles, tool menu, options) — with the record
 * in ./chatStream.golden.json. Random ids and timestamps are normalised; the
 * prompt text itself is pinned by turnMessages/builderPrompt's own tests and
 * here only by message roles and count.
 *
 * Re-record (only when a behaviour change is intended):
 *   GOLDEN_RECORD=1 node --test routes/ai/automationBuilder/chatStream.golden.test.js
 *
 * Run: cd server && node --test routes/ai/automationBuilder/chatStream.golden.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

const h = createBuilderStream();
after(() => h.restore());

const GOLDEN_FILE = path.join(__dirname, 'chatStream.golden.json');
const RECORD = process.env.GOLDEN_RECORD === '1';
const golden = RECORD ? {} : JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
if (RECORD) after(() => fs.writeFileSync(GOLDEN_FILE, JSON.stringify(golden, null, 1) + '\n'));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SESSION = /\bbs_[a-z0-9]+/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

/** Ids and clocks out; everything else verbatim. */
function normalise(value) {
    return JSON.parse(JSON.stringify(value ?? null, (key, v) => {
        if (key === 'promptChars' && typeof v === 'number') return '<n>';
        if (v instanceof Set) return [...v];
        if (typeof v === 'string') return v.replace(UUID, '<uuid>').replace(ISO, '<ts>').replace(SESSION, 'bs_<id>');
        return v;
    }));
}

/** The record of one run that the golden file holds. */
function recordOf(run) {
    return normalise({
        events: run.events,
        toolCalls: run.toolCalls,
        persists: run.persists,
        storedSessions: run.storedSessions.map((s) => ({ automationId: s.automationId, userId: s.userId, payload: s.payload, opts: s.opts })),
        rounds: run.rounds.map((r) => ({
            roles: r.messages.map((m) => m.role),
            tools: (r.options.tools || []).map((t) => t.function.name),
            toolChoice: r.options.toolChoice,
            maxTokens: r.options.maxTokens,
            temperature: r.options.temperature,
            reasoningEffort: r.options.reasoningEffort,
            reasoningSummary: r.options.reasoningSummary,
            promptCacheKey: r.options.promptCacheKey,
            // The tail the loop appends after the composed prompt (notes,
            // tool results, nudges) is pinned verbatim.
            tail: r.messages.slice(-4).filter((m) => m.role !== 'system'),
        })),
    });
}

async function golden_(name, spec) {
    const run = await h.run(spec);
    const rec = recordOf(run);
    if (RECORD) { golden[name] = rec; return; }
    assert.ok(golden[name], `no golden record for "${name}" — re-record`);
    assert.deepEqual(rec, golden[name]);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const VALID_DEF = () => ({
    schemaVersion: 1,
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
    steps: [{ id: 's1', type: 'set', label: 'Factuur lezen', spec: {}, settings: { assignments: [{ var: 'x', value: '1' }] } }],
    edges: [{ from: 'trg', to: 's1' }],
    vars: {},
});
const draftRow = (over = {}) => ({ id: 'a1', userId: 'u1', title: 'Facturen', description: '', definition: VALID_DEF(), ...over });
const EMPTY_ROW = () => ({ id: 'a1', userId: 'u1', title: 'Facturen', description: '', definition: { schemaVersion: 1, steps: [], edges: [], vars: {} } });

const buildSteps = (_args, wrap) => { wrap.def = VALID_DEF(); return { ok: true, added: [{ id: 's1', type: 'set' }] }; };
const finalize = (_args, wrap) => ({ ok: true, automation: { id: wrap.automationId || 'auto_minted' } });

// ── Scenarios ──────────────────────────────────────────────────────────────

test('golden: a fresh build that lands steps, then talks — auto-finalized and named', async () => {
    await golden_('fresh-build-auto-finalize', {
        message: 'Lees elke nieuwe factuur uit Nextcloud en schrijf de boeking weg.',
        rounds: [
            { toolCalls: [call('builder_set_plan', { todos: [{ text: 'Trigger' }, { text: 'Stap' }] }), call('builder_add_steps', { steps: [{ type: 'set' }] })], usage: { input_tokens: 100, output_tokens: 20 } },
            { text: 'Klaar.' },
        ],
        tools: { builder_add_steps: buildSteps, builder_finalize: finalize },
    });
});

test('golden: an existing draft, explicit finalize and summary in one reply', async () => {
    await golden_('existing-finalize', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [
            { toolCalls: [call('builder_summarise'), call('builder_request_dry_run'), call('builder_finalize')] },
            { text: 'Gereed.' },
        ],
        tools: {
            builder_summarise: () => ({ summary: 'Leest facturen.' }),
            builder_request_dry_run: () => ({ run: { id: 'r1', status: 'success' }, steps: [{ id: 's1', status: 'success' }] }),
            builder_finalize: finalize,
        },
    });
});

test('golden: finalize refused by validation, then a give-up message', async () => {
    await golden_('finalize-refused', {
        draft: EMPTY_ROW(),
        body: { automationId: 'a1' },
        rounds: [{ toolCalls: [call('builder_finalize')] }, { text: 'Het lukt niet.' }],
        tools: { builder_finalize: finalize },
    });
});

test('golden: four wasted rounds end as no_progress', async () => {
    await golden_('no-progress', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [1, 2, 3, 4, 5, 6].map((i) => ({ toolCalls: [call('builder_update_step', { stepId: 's1', label: `v${i}` })] })),
        tools: { builder_update_step: () => ({ error: 'Step s1 is wrong.' }) },
    });
});

test('golden: a ladder stop skips the calls behind it', async () => {
    await golden_('ladder-stop', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [{ toolCalls: [call('builder_add_steps', { steps: [{ type: 'set', spec: { label: 'X' } }, { type: 'set' }] }), call('builder_finalize')] }],
        tools: {
            builder_add_steps: () => ({ error: 'Step 2 has no `tool`.', _repeated: 3, failedIndex: 1, _stop: { reason: 'repeated_rejection', tool: 'builder_add_steps', error: 'Step 2 has no `tool`.', entryIndex: 1 } }),
            builder_finalize: finalize,
        },
    });
});

test('golden: a tier missing from the map runs on the global model', async () => {
    await golden_('tier-unmapped', { body: { modelTier: 'pro' }, rounds: [] });
});

test('golden: the beta gate', async () => {
    await golden_('beta-off', { betaFeatures: [], rounds: [] });
});

test('golden: a permanent provider rejection and a transient one', async () => {
    const e400 = Object.assign(new Error('API error 400: template refuses system message'), { status: 400 });
    await golden_('provider-400', { draft: draftRow(), body: { automationId: 'a1' }, rounds: [{ throws: e400 }] });
    const e503 = Object.assign(new Error('API error 503: overloaded'), { status: 503 });
    await golden_('provider-503', { draft: draftRow(), body: { automationId: 'a1' }, rounds: [{ throws: e503 }, { throws: e503 }, { throws: e503 }, { throws: e503 }] });
});

test('golden: truncated round retried once, then given up', async () => {
    await golden_('truncated-twice', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [{ text: 'denk…', finishReason: 'max_tokens' }, { text: 'denk…', finishReason: 'max_tokens' }],
    });
});

test('golden: two blank replies end with an error', async () => {
    await golden_('blank-twice', { draft: draftRow(), body: { automationId: 'a1' }, rounds: [{}, {}] });
});

test('golden: plan mode writes a plan and stops', async () => {
    await golden_('plan-written', {
        draft: draftRow(),
        body: { automationId: 'a1', workMode: 'plan' },
        rounds: [{ toolCalls: [call('builder_write_plan', { title: 'Plan', goal: 'Doel', steps: ['Stap één', 'Stap twee'] }), call('builder_set_plan', { todos: [{ text: 'x' }] })] }],
    });
});

test('golden: plan mode asks questions, and the answer turn refuses a second card', async () => {
    await golden_('plan-questions', {
        draft: draftRow(),
        body: { automationId: 'a1', workMode: 'plan' },
        rounds: [{ toolCalls: [call('builder_ask_questions', { questions: [{ question: 'Welke map?', answers: ['Inbox', 'Archief'] }] })] }],
    });
    await golden_('plan-answer-turn', {
        draft: draftRow(),
        message: 'Inbox',
        builderSession: { reviewQuestions: [{ question: 'Welke map?', answers: ['Inbox', 'Archief'] }], questionsMeta: { round: 1, planId: null, mode: 'plan' } },
        body: { automationId: 'a1', workMode: 'plan' },
        rounds: [
            { toolCalls: [call('builder_ask_questions', { questions: [{ question: 'Nog iets?', answers: ['Ja', 'Nee'] }] })] },
            { text: 'Ik schrijf het plan zo.' },
            { toolCalls: [call('builder_write_plan', { title: 'Plan', goal: 'Doel', steps: ['Stap'] })] },
        ],
    });
});

test('golden: an approved plan builds, ticks its checklist and pauses after one step', async () => {
    const reviewPlan = { id: 'p1', status: 'review', title: 'Plan', goal: 'Doel', steps: ['Rename the first step', 'Add a step'] };
    await golden_('approved-plan-pause', {
        draft: draftRow(),
        builderSession: { reviewPlan },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1', pauseAfterStep: true },
        rounds: [
            { toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Renamed' }), call('builder_update_step', { stepId: 's1', label: 'Again' })] },
        ],
        tools: { builder_update_step: (args, wrap) => { wrap.def.steps[0].label = args.label; return { ok: true }; } },
    });
    await golden_('approved-plan-open-steps', {
        draft: draftRow(),
        builderSession: { reviewPlan },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' },
        rounds: [{ text: 'Klaar.' }, { text: 'Echt klaar.' }],
    });
});

test('golden: approve mode stages a proposal; a buffered small build commits', async () => {
    const update = (args, wrap) => { wrap.def.steps[0].label = args.label; return { ok: true }; };
    await golden_('approve-proposal', {
        draft: draftRow(),
        body: { automationId: 'a1', workMode: 'approve', selectedStepId: 's1' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Proposed' }), call('builder_set_metadata', { title: 'Nieuw' })] }, { text: 'Bekijk dit.' }],
        tools: { builder_update_step: update, builder_set_metadata: (args, wrap) => { wrap.title = args.title; return { ok: true }; } },
    });
    await golden_('buffered-small-commit', {
        draft: draftRow(),
        body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Small' }), call('builder_remove_step', { stepId: 's1' })] }, { text: 'Klaar.' }],
        tools: { builder_update_step: update },
    });
});

test('golden: discuss refuses mutations; truncated args and a recovered call', async () => {
    await golden_('discuss-refusal', {
        draft: draftRow(),
        body: { automationId: 'a1', workMode: 'discuss' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { text: 'Alleen advies.' }],
    });
    await golden_('invalid-args', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [
            { events: [['tool_use_invalid', { id: 'bad', name: 'builder_update_step', raw: '{"stepId": "s1"' }]] },
            { toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Ok' })] },
            { text: 'Klaar.' },
        ],
        tools: { builder_update_step: (args, wrap) => { wrap.def.steps[0].label = args.label; return { ok: true }; } },
    });
});

test('golden: resume re-emits the snapshot; auto tier and floor; narration on', async () => {
    await golden_('resume-auto-narrated', {
        draft: draftRow(),
        query: { resume: '1' },
        builderSession: { todos: [{ text: 'Een', done: true }], conversation: [], draft: VALID_DEF(), catalogOrder: [] },
        body: { automationId: 'a1', modelTier: 'auto' },
        config: { builder_narration_model: '' },
        tiers: { fast: { modelId: 'claude-haiku-4-5' }, standard: { modelId: 'claude-sonnet-4-5' }, thinking: { modelId: 'claude-sonnet-4-5', reasoningEffort: 'medium' } },
        rounds: [{ thinking: [{ text: 'Even denken', signature: 'sig' }], toolCalls: [call('builder_summarise')] }, { text: 'Klaar.' }],
        tools: { builder_summarise: () => ({ summary: 'Leest facturen.' }) },
    });
});

test('golden: flowlet delegation, an inspection read and a webpage tool in build mode; webpage tools offered', async () => {
    await golden_('delegation-inspect', {
        draft: draftRow(),
        betaFeatures: ['automations', 'webpages'],
        body: { automationId: 'a1', workMode: 'build' },
        rounds: [
            { toolCalls: [call('builder_generate_layer', { key: 'sub', brief: 'x' }), call('builder_inspect_step', { stepId: 's1' })] },
            { toolCalls: [call('builder_generate_layers', { layers: [] }), call('webpages_list', {})] },
            { text: 'Klaar.' },
        ],
        tools: {
            builder_generate_layer: (_args, wrap) => { wrap.def.layers = { sub: { steps: [] } }; return { ok: true, layer: 'sub' }; },
            builder_generate_layers: () => ({ error: 'no layers' }),
        },
    });
});
