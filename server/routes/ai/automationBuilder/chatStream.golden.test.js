// @typecheck
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

/** Records `rec` under `name`, or compares it with the record on file. */
function compare(name, rec) {
    if (RECORD) { golden[name] = rec; return; }
    assert.ok(golden[name], `no golden record for "${name}" — re-record`);
    assert.deepEqual(rec, golden[name]);
}

async function golden_(name, spec) {
    const run = await h.run(spec);
    compare(name, recordOf(run));
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

test('golden: Plan first on a new automation with a thin brief: the plan goes back once, the questions end the turn', async () => {
    await golden_('plan-ask-first', {
        message: 'Automatiseer mijn facturen',
        body: { workMode: 'plan' },
        rounds: [
            { toolCalls: [call('builder_write_plan', { title: 'Plan', goal: 'Doel', steps: ['Stap'] })] },
            { toolCalls: [call('builder_ask_questions', { questions: [{ prompt: 'Waar komen de facturen binnen?', options: ['Gmail', 'Outlook'] }, { prompt: 'Wie keurt ze goed?', options: ['Ik', 'Finance'] }] })] },
        ],
    });
});

// ── The tool dispatch, the route's own answers, the setup and the closing ──
// Scenarios that reach the branches of toolDispatch / routeTools / turnSetup /
// turnClosing one by one. Their record also holds the builder's own log lines
// (a rejected call and the usage of a turn are only said there) and what a
// tool saw on the draft wrapper the setup prepared (`seen`).

const log = require('../../../telemetry/log');
const webResearch = require('../../../usecases/ai/automationBuilder/webResearch');

/** The golden record of a run plus the `[AutomationBuilder]` log lines it wrote. */
async function goldenWithLogs(name, spec, extra = () => ({})) {
    const lines = [];
    const real = { info: log.info, warn: log.warn };
    // Not the lines every turn writes alike (the model profile, the tier pick, the prompt prefix hashes, the web research gate of the harness).
    const everyTurn = /^\[AutomationBuilder\] (model=|Auto: tier=|web research gate failed|prefix sys=)/;
    const keep = (level) => (...parts) => { if (String(parts[0]).startsWith('[AutomationBuilder]') && !everyTurn.test(String(parts[0]))) lines.push(`${level} ${parts.map(String).join(' ')}`); };
    log.info = keep('info'); log.warn = keep('warn');
    let run;
    try { run = await h.run(spec); } finally { Object.assign(log, real); }
    // A long run of one character (the argument cap) is written as its length.
    const rec = JSON.parse(JSON.stringify({ ...recordOf(run), ...normalise({ logs: lines, ...extra() }) }).replace(/([a-z])\1{99,}/g, (run_, c) => `${c}×${run_.length}`));
    // The tool menu of a round that is the previous round's is not repeated.
    rec.rounds.forEach((r, i) => { if (i > 0) r.sameTools = JSON.stringify(r.tools) === JSON.stringify(rec.rounds[0].tools); });
    rec.rounds.forEach((r, i) => { if (i > 0 && r.sameTools) delete r.tools; else delete r.sameTools; });
    compare(name, rec);
}

/** What the setup left on the draft wrapper, as a tool sees it. */
const seen = (wrap) => ({
    title: wrap.title, steps: wrap.def.steps.map((s) => s.label || s.id), todos: wrap._todos, stagedDryRun: wrap._stagedDryRun,
    stageDatatables: !!wrap._stageDatatables, datatables: wrap._datatables, documents: wrap._documents,
    documentDiscoveryRequired: wrap._documentDiscoveryRequired, blocks: wrap._blocks,
    availableToolNames: wrap._availableToolNames ? [...wrap._availableToolNames] : wrap._availableToolNames,
    inspectedTools: [...(wrap._inspectedTools || [])], inputSchemas: Object.keys(wrap._inputSchemasByTool || {}), runtimeShapes: wrap._runtimeShapes,
});
const peek = (_args, wrap) => ({ summary: 'Leest facturen.', seen: seen(wrap) });
const relabel = (args, wrap) => { wrap.def.steps[0].label = args.label; return { ok: true }; };
const TWO_STEPS = () => {
    const def = VALID_DEF();
    def.steps.push({ id: 's2', type: 'set', label: 'Mail sturen', spec: {}, settings: { assignments: [{ var: 'y', value: '2' }] } });
    def.edges.push({ from: 's1', to: 's2' });
    return def;
};
const plan = (over = {}) => ({ id: 'p1', status: 'review', title: 'Plan', goal: 'Doel', steps: ['Rename the first step'], ...over });

test('golden: an org webpage tool and a builder tool in one turn; what the setup left on the draft', async () => {
    await goldenWithLogs('dispatch-webpage-and-builder-tool', {
        draft: draftRow(),
        betaFeatures: ['automations', 'webpages'],
        body: { automationId: 'a1' },
        catalog: { apps: [{ id: 'mail', name: 'Mail', tools: [{ name: 'mail_send', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } }] }], toolNames: new Set(['mail_send', 'mail_read']), triggerOutputs: {} },
        builderSession: { inspectedTools: ['mail_send', 'gone_tool', 7], todos: [{ text: 'Een', done: true }, { text: 'Twee' }], catalogOrder: ['mail'] },
        datatables: [{ id: 'tbl_1', key: 'orders', name: 'Orders', fields: [] }],
        documents: [{ id: 'doc_1', name: 'Offer' }],
        pickers: { agents: [{ id: 'ag1', name: 'Agent' }], blocks: [{ id: 'blk1' }] },
        rounds: [{ toolCalls: [call('builder_summarise'), call('webpages_list', {})] }, { text: 'Klaar.' }],
        tools: { builder_summarise: peek },
    });
    await goldenWithLogs('setup-catalogues-unreadable', {
        draft: draftRow(),
        body: { automationId: 'a1', workMode: 'discuss' },
        builderSession: { todos: [{ text: 'Een', done: true }] },
        datatables: new Error('datatable store down'),
        documents: new Error('document store down'),
        pickers: { blocks: [{ id: 'blk1' }], blocksError: 'could not read' },
        rounds: [{ toolCalls: [call('builder_summarise')] }, { text: 'Klaar.' }],
        tools: { builder_summarise: peek },
    });
    await goldenWithLogs('setup-no-blocks-list', {
        draft: draftRow(), body: { automationId: 'a1' }, pickers: { blocks: 'none' },
        rounds: [{ toolCalls: [call('builder_summarise')] }, { text: 'Klaar.' }],
        tools: { builder_summarise: peek },
    });
});

test('golden: dry runs: started, answered, refused; a summary that is no text; a result with a run from another tool', async () => {
    await goldenWithLogs('dispatch-dry-runs', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [
            { toolCalls: [call('builder_summarise'), call('builder_request_dry_run')] },
            { toolCalls: [call('builder_request_dry_run'), call('builder_update_step', { stepId: 's1', label: 'B' }), call('builder_summarise')] },
            { toolCalls: [call('builder_request_dry_run')] },
            { text: 'Klaar.' },
        ],
        tools: {
            builder_summarise: (() => { let n = 0; return () => (n++ ? { summary: 42 } : { summary: 'Leest facturen.' }); })(),
            builder_request_dry_run: (() => {
                let n = 0;
                return (_args, wrap) => {
                    n += 1;
                    if (n === 1) { wrap._onDryRunStarted({ id: 'r1' }); return { run: { id: 'r1', status: 'failed' }, steps: [{ stepId: 's1', status: 'failed', error: 'boom', output: { total: 12, name: 'x' } }] }; }
                    if (n === 2) { wrap._onDryRunStarted({ id: 'r2', status: 'queued', startedAt: '2026-01-01T00:00:00.000Z' }); return { error: 'The run could not start.' }; }
                    return { run: { id: 'r3', status: 'success' } };
                };
            })(),
            builder_update_step: (args, wrap) => { wrap.def.steps[0].label = args.label; return { ok: true, run: { id: 'not-a-dry-run' } }; },
        },
    });
});

test('golden: a partial batch ticks the plan with what it built; reused entries are no progress', async () => {
    const added = (reused) => (args, wrap) => {
        if (!reused) wrap.def.steps.push({ id: `n${wrap.def.steps.length}`, type: 'set', label: 'Send the email', spec: {}, settings: { assignments: [{ var: 'z', value: '3' }] } });
        return { error: 'Step 2 has no `tool`.', failedIndex: 1, added: [{ id: 'n1', type: 'set', label: 'Send the email', ...(reused ? { reused: true } : {}) }] };
    };
    let n = 0;
    await goldenWithLogs('dispatch-partial-batch', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [
            { toolCalls: [call('builder_set_plan', { todos: [{ text: 'Send the email' }, { text: 'Add a set step that stores the total' }, { text: 'Finalize' }] })] },
            { toolCalls: [call('builder_add_steps', { steps: [{ type: 'set', label: 'Send the email' }, { type: 'action' }] })] },
            { toolCalls: [call('builder_add_steps', { steps: [{ type: 'set', label: 'Send the email' }, { type: 'action' }] })] },
            { toolCalls: [call('builder_add_steps', { steps: 'not a list' })] },
            { toolCalls: [call('builder_add_steps', { steps: [{ type: 'action' }] })] },
            { text: 'Klaar.' },
        ],
        tools: {
            builder_add_steps: (args, wrap) => {
                n += 1;
                if (n === 1) return added(false)(args, wrap);
                if (n === 2) return added(true)(args, wrap);
                if (n === 3) return { error: 'steps is a list.', added: [{ id: 'n1', type: 'set' }] };
                return { error: 'Step 1 has no `tool`.', added: [], failedIndex: 0 };
            },
        },
    });
});

test('golden: a staged table in approve mode and in a buffered build', async () => {
    const createTable = (() => {
        let n = 0;
        return (args, wrap) => {
            n += 1;
            if (n % 2 === 0) return { ok: true };
            wrap._pendingDatatables = [...(wrap._pendingDatatables || []), { ref: `pending:${args.key}`, key: args.key, name: args.name, fields: [] }];
            return { ok: true, staged: true, ref: `pending:${args.key}` };
        };
    })();
    const rounds = [{ toolCalls: [call('builder_create_datatable', { key: 'orders', name: 'Orders' }), call('builder_create_datatable', { key: 'other', name: 'Other' })] }, { text: 'Bekijk dit.' }];
    await goldenWithLogs('dispatch-staged-table-approve', { draft: draftRow(), body: { automationId: 'a1', workMode: 'approve' }, rounds, tools: { builder_create_datatable: createTable } });
    await goldenWithLogs('dispatch-staged-table-buffered', { draft: draftRow(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true }, rounds, tools: { builder_create_datatable: createTable } });
    await goldenWithLogs('dispatch-table-without-work-mode', { draft: draftRow(), body: { automationId: 'a1' }, rounds, tools: { builder_create_datatable: createTable } });
});

test('golden: a stop that names nothing, a rejected call logged with its arguments cut at the cap, a recovered call', async () => {
    await goldenWithLogs('dispatch-stop-defaults', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'x'.repeat(20050) }), call('builder_update_step', { stepId: 's1', label: 'y' }), call('builder_finalize')] }],
        tools: {
            builder_update_step: (args) => (args.label === 'y' ? { error: 'Refused again.', _stop: {} } : { error: `Refused: ${'e'.repeat(500)}` }),
            builder_finalize: finalize,
        },
    });
    await goldenWithLogs('dispatch-recovered-call', {
        draft: draftRow(),
        body: { automationId: 'a1' },
        rounds: [
            { text: '<tool_call>{"name": "builder_update_step", "arguments": {"stepId": "s1", "label": "Uit tekst"}}</tool_call>' },
            { toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Hersteld' }, { repaired: true }), call('builder_summarise', {}, { repaired: true })] },
            { text: 'Klaar.' },
        ],
        tools: { builder_update_step: (args, wrap) => { wrap.def.steps[0].label = args.label; return { ok: true, _hints: ['kept'] }; }, builder_summarise: () => 'a text result' },
    });
});

test('golden: a finalize that throws on an untitled draft keeps the default name until the turn ends', async () => {
    const untitled = () => draftRow({ title: 'Untitled automation' });
    await goldenWithLogs('finalize-throws-untitled', {
        draft: untitled(), body: { automationId: 'a1' }, message: 'Lees elke nieuwe factuur en boek hem.',
        rounds: [{ toolCalls: [call('builder_finalize')] }, { text: 'Het lukt niet.' }],
        tools: { builder_finalize: (() => { let n = 0; return (_a, wrap) => { if (n++ === 0) throw new Error('trigger resync failed'); return finalize(_a, wrap); }; })() },
    });
    await goldenWithLogs('finalize-names-untitled', {
        draft: untitled(), body: { automationId: 'a1' }, message: 'Lees elke nieuwe factuur en boek hem.',
        rounds: [{ toolCalls: [call('builder_finalize')] }, { text: 'Klaar.' }],
        tools: { builder_finalize: (_a, wrap) => ({ ok: true, automation: { id: wrap.automationId }, needs: [{ kind: 'connection', app: 'mail' }] }) },
    });
    await goldenWithLogs('auto-finalize-throws-untitled', {
        draft: untitled(), body: { automationId: 'a1' }, message: 'Lees elke nieuwe factuur en boek hem.',
        rounds: [{ text: 'Klaar.' }],
        tools: { builder_finalize: () => { throw new Error('trigger resync failed'); } },
    });
    await goldenWithLogs('auto-finalize-note-only', {
        draft: draftRow({ definition: { ...VALID_DEF(), steps: [{ id: 'n1', type: 'note', label: 'Idee', spec: {}, settings: {} }], edges: [] } }), body: { automationId: 'a1' },
        rounds: [{ text: 'Klaar.' }], tools: { builder_finalize: finalize },
    });
    await goldenWithLogs('auto-finalize-with-needs', {
        draft: draftRow(), body: { automationId: 'a1' }, rounds: [{ text: 'Klaar.' }],
        tools: { builder_finalize: (_a, wrap) => ({ ok: true, automation: { id: wrap.automationId }, needs: [{ kind: 'connection', app: 'mail' }] }) },
    });
    await goldenWithLogs('auto-finalize-answers-nothing', { draft: draftRow(), body: { automationId: 'a1' }, rounds: [{ text: 'Klaar.' }], tools: { builder_finalize: () => ({ ok: false }) } });
});

test('golden: pause after each step refuses batches and run actions; a plan names the steps it removes', async () => {
    await goldenWithLogs('route-pause-gates', {
        draft: draftRow({ definition: TWO_STEPS() }),
        builderSession: { reviewPlan: plan() },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1', pauseAfterStep: true },
        rounds: [
            { toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }, { type: 'set' }] }), call('builder_generate_layer', { key: 'sub' }), call('builder_generate_layers', { layers: [] }), call('builder_request_dry_run')] },
            { toolCalls: [call('builder_add_steps', { steps: [{ type: 'set' }] }), call('builder_summarise')] },
        ],
        tools: { builder_add_steps: () => ({ ok: true, added: [] }), builder_summarise: peek },
    });
    const removal = plan({ steps: ['Remove the step "Mail sturen"; keep the rest', 'Rename the first step'] });
    await goldenWithLogs('route-plan-removal', {
        draft: draftRow({ definition: TWO_STEPS() }),
        builderSession: { reviewPlan: removal },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' },
        rounds: [
            { toolCalls: [call('builder_remove_step', { stepId: 's1' }), call('builder_remove_step', { stepId: 'nope' }), call('builder_remove_step', { stepId: 'nope', scope: 'sub' }), call('builder_update_step', { stepId: 's1', label: 'Renamed' })] },
            { toolCalls: [call('builder_remove_step', { stepId: 's2' }), call('builder_set_plan', { todos: [{ text: 'Mine' }] }), call('builder_set_plan', { markDone: [0, 1] })] },
            { text: 'Klaar.' },
        ],
        tools: {
            builder_update_step: relabel,
            builder_remove_step: (args, wrap) => { wrap.def.steps = wrap.def.steps.filter((s) => s.id !== args.stepId); wrap.def.edges = wrap.def.edges.filter((e) => e.to !== args.stepId); return { ok: true, removed: args.stepId }; },
            builder_finalize: finalize,
        },
    });
});

test('golden: an approved plan that is continued: its own checklist is kept, another one replaced; a plan without steps', async () => {
    const building = plan({ status: 'building', steps: ['Rename the first step', 'Add a step'] });
    await goldenWithLogs('setup-plan-continues-own-list', {
        draft: draftRow(),
        builderSession: { reviewPlan: building, todos: [{ text: 'Rename the first step', done: true }, { text: 'Add a step', done: false }] },
        body: { automationId: 'a1', workMode: 'approve', approvedPlanId: 'p1' },
        rounds: [{ toolCalls: [call('builder_summarise')] }, { text: 'Verder.' }],
        tools: { builder_summarise: peek },
    });
    await goldenWithLogs('setup-plan-replaces-other-list', {
        draft: draftRow(),
        builderSession: { reviewPlan: { ...building, status: 'paused' }, todos: [{ text: 'Rename the first step', done: true }, { text: 'Something else', done: true }] },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' },
        rounds: [{ toolCalls: [call('builder_summarise')] }, { text: 'Verder.' }],
        tools: { builder_summarise: peek },
    });
    await goldenWithLogs('setup-plan-shorter-list', {
        draft: draftRow(),
        builderSession: { reviewPlan: building, todos: [{ text: 'Rename the first step', done: true }] },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' },
        rounds: [{ toolCalls: [call('builder_summarise'), call('builder_set_plan', { markDone: [0, 1] })] }, { text: 'Klaar.' }],
        tools: { builder_summarise: peek },
    });
    await goldenWithLogs('setup-plan-without-steps', {
        draft: draftRow(),
        builderSession: { reviewPlan: plan({ steps: [7, null] }) },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' },
        rounds: [{ text: 'Klaar.' }, { text: 'Echt klaar.' }],
    });
    await goldenWithLogs('setup-plan-stale-review', {
        draft: draftRow(),
        builderSession: { reviewPlan: plan({ baseDefinition: { ...VALID_DEF(), steps: [] } }) },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' }, rounds: [],
    });
    await goldenWithLogs('setup-plan-built-is-over', {
        draft: draftRow(),
        builderSession: { reviewPlan: plan({ status: 'built' }) },
        body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' }, rounds: [],
    });
    await goldenWithLogs('setup-plan-id-without-work-mode', {
        draft: draftRow(), builderSession: { reviewPlan: plan() }, body: { automationId: 'a1', approvedPlanId: 'p1' }, rounds: [],
    });
});

test('golden: a waiting proposal is worked on, kept, replaced; resume replays the checklist', async () => {
    const proposal = (over = {}) => ({ id: 'prop1', definition: { ...VALID_DEF(), steps: [{ ...VALID_DEF().steps[0], label: 'Voorgesteld' }] }, baseDefinition: VALID_DEF(), title: 'Voorgestelde titel', description: 'Voorstel', ...over });
    await goldenWithLogs('setup-proposal-worked-on', {
        draft: draftRow(), builderSession: { proposal: proposal() }, body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_summarise')] }, { text: 'Het voorstel staat er nog.' }],
        tools: { builder_summarise: peek },
    });
    await goldenWithLogs('setup-proposal-added-to', {
        draft: draftRow(), builderSession: { proposal: proposal({ title: 7, description: null }) }, body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Nog een wijziging' }), call('builder_inspect_step', { stepId: 's1' }), call('builder_inspect_step', { stepId: 'nope' })] }, { text: 'Bekijk dit.' }],
        tools: { builder_update_step: relabel },
    });
    await goldenWithLogs('setup-proposal-stale', {
        draft: draftRow(), builderSession: { proposal: proposal({ baseDefinition: { ...VALID_DEF(), steps: [] } }) }, body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_summarise'), call('builder_inspect_step', { stepId: 's1' })] }, { text: 'Niets veranderd.' }],
        tools: { builder_summarise: peek },
    });
    await goldenWithLogs('setup-proposal-kept-in-build', {
        draft: draftRow(), builderSession: { proposal: proposal() }, body: { automationId: 'a1', workMode: 'build' },
        rounds: [{ toolCalls: [call('builder_summarise')] }, { text: 'Klaar.' }],
        tools: { builder_summarise: peek, builder_finalize: finalize },
    });
    await goldenWithLogs('setup-proposal-buffered-build', {
        draft: draftRow(), builderSession: { proposal: proposal() }, body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Bovenop het voorstel' })] }, { text: 'Bekijk dit.' }],
        tools: { builder_update_step: relabel },
    });
    await goldenWithLogs('setup-resume-with-todos', {
        draft: draftRow(), query: { resume: 'true' },
        builderSession: { todos: [{ text: 'Een', done: true }, { text: 'Twee' }], conversation: [{ role: 'user', content: 'eerder' }], draft: VALID_DEF() },
        body: { automationId: 'a1' }, rounds: [{ toolCalls: [call('builder_summarise')] }, { text: 'Klaar.' }],
        tools: { builder_summarise: peek, builder_finalize: finalize },
    });
    await goldenWithLogs('setup-resume-without-todos', {
        draft: draftRow(), query: { resume: '1' }, builderSession: { todos: 'none', conversation: [] },
        body: { automationId: 'a1', workMode: 'plan' }, rounds: [{ text: 'Wat wil je bouwen?' }],
    });
});

test('golden: a buffered build commits a new name, holds back for questions, and proposes a large change', async () => {
    const rename = (args, wrap) => { wrap.title = args.title; if (args.description) wrap.description = args.description; return { ok: true }; };
    await goldenWithLogs('closing-buffered-title-only', {
        draft: draftRow(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_set_metadata', { title: 'Nieuwe naam' })] }, { text: 'Klaar.' }],
        tools: { builder_set_metadata: rename },
    });
    await goldenWithLogs('closing-buffered-description-only', {
        draft: draftRow(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_set_metadata', { title: 'Facturen', description: 'Boekt facturen' })] }, { text: 'Klaar.' }],
        tools: { builder_set_metadata: rename },
    });
    await goldenWithLogs('closing-buffered-questions', {
        draft: draftRow(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Klein' }), call('builder_ask_questions', { questions: [{ prompt: 'Welke map?', options: ['Inbox', 'Archief'] }] }), call('builder_summarise')] }],
        tools: { builder_update_step: relabel, builder_summarise: peek },
    });
    await goldenWithLogs('closing-buffered-large-change', {
        draft: draftRow(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_add_steps', { steps: [] }), call('builder_generate_layer', { key: 'sub', brief: 'x' })] }, { text: 'Bekijk dit.' }],
        tools: {
            builder_add_steps: (_a, wrap) => { for (let i = 0; i < 8; i++) wrap.def.steps.push({ id: `b${i}`, type: 'set', label: `Stap ${i}`, spec: {}, settings: { assignments: [{ var: `v${i}`, value: '1' }] } }); return { ok: true, added: [] }; },
            builder_generate_layer: () => { throw new Error('the sub-agent failed'); },
        },
    });
    await goldenWithLogs('closing-nothing-changed-buffered', {
        draft: draftRow(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true }, rounds: [{ text: 'Niets te doen.' }],
    });
});

test('golden: an approved plan ends built, building or paused; a plan on a new automation gets a document', async () => {
    const approved = { draft: draftRow(), builderSession: { reviewPlan: plan() }, body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' } };
    await goldenWithLogs('closing-plan-built-by-checklist', {
        ...approved,
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Renamed' }), call('builder_set_plan', { markDone: [0] })] }, { toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { toolCalls: [call('builder_update_step', { stepId: 's1' })] }],
        tools: { builder_update_step: (args, wrap) => { if (!args.label) return { error: 'label is required.' }; wrap.def.steps[0].label = args.label; return { ok: true }; } },
    });
    await goldenWithLogs('closing-plan-built-by-finalize', {
        ...approved, rounds: [{ toolCalls: [call('builder_finalize')] }, { text: 'Klaar.' }], tools: { builder_finalize: finalize },
    });
    await goldenWithLogs('closing-plan-paused-by-questions', {
        ...approved, rounds: [{ toolCalls: [call('builder_ask_questions', { questions: [{ prompt: 'Welke map?', options: ['Inbox', 'Archief'] }] })] }],
    });
    await goldenWithLogs('closing-plan-on-new-automation', {
        message: 'When a new invoice e-mail arrives in my inbox, save the attachment to Nextcloud and send me a message.',
        body: { workMode: 'plan' },
        rounds: [{ toolCalls: [call('builder_summarise'), call('builder_write_plan', { title: 'Plan' }), call('builder_write_plan', { title: 'Plan', goal: 'Doel', steps: ['Stap'] }), call('builder_summarise')] }],
        tools: { builder_summarise: peek },
    });
    await goldenWithLogs('closing-questions-outside-plan', {
        draft: draftRow(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_ask_questions', { questions: [] }), call('builder_ask_questions', { questions: Array.from({ length: 9 }, (_, i) => ({ prompt: `Vraag ${i}?`, options: ['Ja', 'Nee'] })) })] }],
    });
    await goldenWithLogs('closing-no-usage-no-line', { draft: draftRow(), body: { automationId: 'a1' }, rounds: [{ throws: Object.assign(new Error('API error 400: bad request'), { status: 400 }) }] });
    await goldenWithLogs('closing-usage-line', {
        draft: draftRow(), body: { automationId: 'a1' },
        rounds: [{ toolCalls: [call('builder_summarise')], usage: { prompt_tokens: 1200, completion_tokens: 80, cached_tokens: 1000, cache_creation_tokens: 50 } }, { text: 'Klaar.', usage: { prompt_tokens: 1300, completion_tokens: 20 } }],
        tools: { builder_summarise: peek, builder_finalize: finalize },
    });
});

test('golden: flowlet delegation in a staged turn, and one that fails; web research answered and refused', async () => {
    const layer = (_a, wrap) => { wrap.def.layers = { sub: { steps: [] } }; return { ok: true, layer: 'sub' }; };
    await goldenWithLogs('route-delegation-approve', {
        draft: draftRow(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_generate_layer', { key: 'sub', brief: 'x' })] }, { text: 'Bekijk dit.' }],
        tools: { builder_generate_layer: layer },
    });
    await goldenWithLogs('route-delegation-fails', {
        draft: draftRow(), body: { automationId: 'a1' },
        rounds: [{ toolCalls: [call('builder_generate_layer', { key: 'sub', brief: 'x' })] }, { toolCalls: [call('builder_generate_layers', { layers: [] })] }, { text: 'Klaar.' }],
        tools: { builder_generate_layer: () => { throw new Error('the sub-agent failed'); }, builder_generate_layers: () => 'two layers built', builder_finalize: finalize },
    });
    const real = { ...webResearch._deps };
    const runs = [];
    Object.assign(webResearch._deps, {
        providerStatus: async () => ({ available: true, provider: 'agent-search', fallbackToNode: false }),
        isPermitted: async () => true,
        getShield: async () => null,
        run: async (name, args, egress) => { runs.push({ name, args, egress }); if (name === 'read_url') throw new Error('the page did not answer'); return '## Results\nDocs at https://docs.example.test/api'; },
    });
    try {
        await goldenWithLogs('route-web-research', {
            draft: draftRow(), body: { automationId: 'a1', webSearchEnabled: true },
            rounds: [{ toolCalls: [call('agent_search', { query: 'tickets api' }), call('read_url', { url: 'https://docs.example.test/api' })] }, { text: 'Gevonden.' }],
            tools: { builder_finalize: finalize },
        }, () => ({ webRuns: runs }));
        runs.length = 0;
        await goldenWithLogs('route-web-research-new-automation', {
            body: { webSearchEnabled: true }, message: 'Zoek de documentatie van de tickets-API op.',
            rounds: [{ toolCalls: [call('agent_search', { query: 'tickets api' })] }, { text: 'Gevonden.' }],
        }, () => ({ webRuns: runs }));
    } finally { Object.assign(webResearch._deps, real); }
    await goldenWithLogs('route-web-research-not-offered', {
        draft: draftRow(), body: { automationId: 'a1' },
        rounds: [{ toolCalls: [call('agent_search', { query: 'tickets api' })] }, { text: 'Kan niet zoeken.' }],
        tools: { agent_search: () => ({ error: 'Web search is not available in this chat.' }), builder_finalize: finalize },
    });
});
