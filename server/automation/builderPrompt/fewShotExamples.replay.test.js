/**
 * Every few-shot call replays through the REAL builders, and every recorded
 * echo IS the real result — the whole value, not just its key set.
 *
 * A worked example is the strongest signal the small band gets, and a
 * recorded echo that the builders never produce teaches a shape the model
 * then argues with on first contact: `{ok:true, stepId}` where the real
 * answer is `{added, idMap, _draftSteps, _wiring}`, a `'simulated'` status
 * the runner has never emitted, real-looking extraction values where a dry
 * run returns typed samples, a hand-written summary in a wording
 * summariseDefinition never uses, an inspect `shape` with its annotations
 * cut off. schemas.doctrine.test.js replays the one invoice batch; this file
 * replays all three ordered examples, call by call, with the same stubs the
 * route would need (a datatable catalog, tool schemas, the create-table
 * dependencies) and none of the route's DB, and compares each echo with the
 * real result after mapping the ids the replay minted back to the recorded
 * ones. No runner is replayed, so a dry-run echo is checked two ways: every
 * step for the compactDryRunForModel shape, and every FLAT step whose output
 * the runner synthesises (a side-effect send, an extraction, a datatable
 * write) against the runner's own synthesis functions plus runDag's stamps —
 * the head the model reads, derived, not transcribed. The 2026-09 compose
 * echo taught four keys where the runner records eight.
 *
 * Route-added keys are excluded from the comparison: `_plan` (the plan tick
 * in chatStream.js) and `_hints` (leaked-call recovery) ride on results the
 * builders never see.
 *
 * Run: cd server && node --test --test-force-exit automation/builderPrompt/fewShotExamples.replay.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildFewShotMessages } = require('./fewShotExamples');
const { applyToolCall, emptyDefinition } = require('../builderTools');
const { applyCreateDatatable } = require('../builderTools/datatableCreate');
const { normalizePlanTodos, applyPlanMarkDone } = require('../../routes/ai/automationBuilder/chatTurnLoop');
const { synthesizeDryRunOutput } = require('../outputSchemas');
const { isSideEffect } = require('../sideEffectMap');
const { synthesiseDryRunExtraction, normaliseFields } = require('../../core/automationRunner/execDataExtraction');
const { resolveInputs } = require('../bind');
const shapeCache = require('../shapeCache');

const ROUTE_ADDED = new Set(['_plan', '_hints']);
const keysOf = (o) => Object.keys(o || {}).filter(k => !ROUTE_ADDED.has(k)).sort();
const withoutRouteKeys = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !ROUTE_ADDED.has(k)));

// The three ordered examples the small profile sees, split on user turns.
function examples() {
    const msgs = buildFewShotMessages(3, { toolset: 'core' });
    const out = [];
    for (const m of msgs) {
        if (m.role === 'user') out.push([]);
        out[out.length - 1].push(m);
    }
    return out;
}

/** Recorded (call, echo) pairs of one example, in emission order. */
function callsOf(example) {
    const echoes = new Map(example.filter(m => m.role === 'tool').map(m => [m.tool_call_id, JSON.parse(m.content)]));
    const calls = [];
    for (const m of example) {
        for (const tc of (m.tool_calls || [])) {
            calls.push({ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments), echo: echoes.get(tc.id) });
        }
    }
    return calls;
}

const STRING = { type: 'string' };
const SCHEMAS = {
    gmail_search: { type: 'object', properties: { query: STRING, maxResults: { type: 'number' } }, required: ['query'] },
    gmail_compose: { type: 'object', properties: { to: STRING, subject: STRING, body: STRING }, required: ['to', 'subject', 'body'] },
    nextcloud_list_files: { type: 'object', properties: { path: STRING }, required: ['path'] },
    nextcloud_read_file: { type: 'object', properties: { path: STRING }, required: ['path'] },
};
// The invoice example's placeholder id IS the id here, so the replay takes
// the warning-free path (schemas.doctrine.test.js covers the key resolution).
const FACTUREN = {
    id: 'tbl_fact01', key: 'facturen', name: 'Facturen', canWrite: true,
    columns: ['datum', 'leverancier', 'factuurnummer', 'excl_btw', 'btw', 'totaal'].map(k => ({ key: k, name: k, type: k === 'datum' ? 'date' : (/btw|totaal/.test(k) ? 'number' : 'text') })),
};

function freshWrap() {
    return {
        userId: 'u_test',
        def: emptyDefinition(),
        _resultDetail: 'full',
        _inputSchemasByTool: { ...SCHEMAS },
        _availableToolNames: new Set(Object.keys(SCHEMAS)),
        _inspectedTools: new Set(),
        _allowedModelTiers: new Set(['auto', 'fast']),
        _datatables: [FACTUREN],
        _todos: [],
    };
}

/** The create-table dependencies, stubbed the way datatableCreate.test.js stubs them. */
function createDeps() {
    return {
        resolvePrincipal: async () => ({ kind: 'user', id: 'u_test' }),
        hasManageDatatables: async () => true,
        createStudioDatatable: async ({ name, fields }) => ({
            ok: true,
            table: { id: 'tbl_7c2d9e', name, key: 'inkomende_facturen', scope: { kind: 'personal' }, fields: fields.map(f => ({ key: f.key, name: f.name, type: f.type })) },
        }),
        catalogFor: async () => null,
    };
}

/** Rewrite the recorded ids in a call to the ids the replay minted. */
function withRealIds(value, idMap) {
    if (typeof value === 'string') {
        let out = value;
        for (const [rec, real] of idMap) out = out.split(rec).join(real);
        return out;
    }
    if (Array.isArray(value)) return value.map(v => withRealIds(v, idMap));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withRealIds(v, idMap)]));
    return value;
}

const RUN_STATUSES = new Set(['success', 'skipped', 'pinned', 'error', 'failed', 'handled_error']);

/**
 * Stand-in outputs for the LIVE steps of the examples (a Gmail search, an AI
 * digest, a Nextcloud listing/read): what those steps returned when the
 * examples were recorded. The echo itself no longer carries payloads — only
 * the _hint — so the replay keeps them here for the synthesised steps that
 * bind into them (the digest the gmail_compose sends, the file list the
 * fan-out reads).
 */
const LIVE_STEP_OUTPUTS = {
    a_5e1c2b: { results: [{ id: '18f2a9c4e1b7', from: 'billing@acme.example', to: 'me@example.com', subject: 'Invoice 2026-118', date: 'Tue, 15 Sep 2026 09:12:00 +0200', snippet: 'Please find attached invoice 2026-118 for EUR 1.240,00…' }], total: 2 },
    ai_9d4f7a: { digest: '- Acme BV — Invoice 2026-118 — EUR 1.240,00\n- Beta NV — Invoice 771 — EUR 380,00' },
    a_1f2e3d: { path: '/Invoices-Test', count: 1, items: [{ name: 'Invoice-2026-001.pdf', path: '/Invoices-Test/Invoice-2026-001.pdf', type: 'file', size: 51200, contentType: 'application/pdf', modified: 'Thu, 10 Sep 2026 09:00:00 GMT', fileId: '1234' }] },
    a_4b5c6d: { iterations: 1, succeeded: 1, failed: 0, results: [{ index: 0, item: { name: 'Invoice-2026-001.pdf', path: '/Invoices-Test/Invoice-2026-001.pdf', type: 'file' }, output: { content: 'INVOICE\nVendor: Acme BV\nAmount: EUR 1.240,00…' }, status: 'success' }] },
};

/**
 * What the runner RECORDS for a flat (non-fan-out) step whose dry-run output
 * it synthesises, derived from the real step the replay built:
 *   - a side-effect integration_action is the tool's curated sample
 *     (execAi → outputSchemas.synthesizeDryRunOutput), which runDag stamps
 *     `_dryRunSynthesised` / `_dryRunFallback: null`;
 *   - a data_extraction is the typed samples of its fields
 *     (execDataExtraction.synthesiseDryRunExtraction), stamped the same way;
 *   - a datatable add_row is execDatatable's preview of the resolved values
 *     (`{row, id, created, updated}`), which stamps `_dryRunSynthesised`
 *     itself and so carries no `_dryRunFallback`.
 * `bound` is what downstream bindings read (runState.steps — unstamped);
 * `recorded` is the persisted output the _hint and outputHead are made of,
 * after the JSON round trip through the store (an unresolved ref is not a
 * key on the wire). null for a live read, an ai_step or a fan-out: their
 * recorded output is real data or the execFlow envelope, which nothing here
 * can predict — those stay shape-checked.
 */
function synthesisedOutput(step, runState) {
    if (!step || step.forEach?.overRef) return null;
    let bound;
    let stamps;
    if (step.type === 'integration_action' && isSideEffect(step.tool)) {
        bound = synthesizeDryRunOutput(step.tool, resolveInputs(step.inputs || {}, runState, { allowSecrets: false }));
        stamps = { _dryRunSynthesised: true, _dryRunFallback: null };
    } else if (step.type === 'data_extraction') {
        bound = synthesiseDryRunExtraction(normaliseFields(step.fields));
        stamps = { _dryRunSynthesised: true, _dryRunFallback: null };
    } else if (step.type === 'datatable' && step.op === 'add_row') {
        bound = { row: resolveInputs(step.values || {}, runState, { allowSecrets: false }), id: null, created: true, updated: 0, _dryRunSynthesised: true };
        stamps = {};
    } else {
        return null;
    }
    return { bound, recorded: JSON.parse(JSON.stringify({ ...bound, ...stamps })) };
}

/** The `_hint` builder_request_dry_run puts on a recorded object output (builderTools.js). */
function hintFor(recorded) {
    return { outputType: 'object', topKeys: Object.keys(recorded), shape: shapeCache.renderShapeHint(shapeCache.describeValue(recorded)) };
}

/**
 * A dry-run echo has the compactDryRunForModel shape — shapes, never
 * payloads (2026-09-18): {run, ok, note, steps}, statuses the runner emits,
 * and every flat synthesised step carries exactly the _hint the runner would
 * record for the step as the replay built it.
 */
function checkDryRunEcho(echo, { knownIds, wrap, idMap }, label) {
    assert.deepEqual(Object.keys(echo).sort(), ['note', 'ok', 'run', 'steps'], `${label}: {run, ok, note, steps}`);
    assert.equal(echo.ok, !echo.steps.some(s => s.error || /fail|error/i.test(String(s.status))), `${label}: ok reflects the steps`);
    assert.equal(echo.note, echo.ok ? 'Clean run: every step succeeded. Nothing to fix: finish with builder_finalize.' : echo.note, `${label}: the clean note is the projection's own sentence`);
    assert.ok(!JSON.stringify(echo).includes('outputHead'), `${label}: no outputHead — the model gets shapes, not payloads`);
    for (const k of Object.keys(echo.run)) assert.ok(['id', 'status', 'error', 'startedAt', 'finishedAt', 'stepCount'].includes(k), `${label}: run.${k}`);
    assert.equal(echo.run.stepCount, echo.steps.length, `${label}: stepCount`);
    // The runner's binding source, grown step by step in run order: a
    // synthesised step binds against what the steps before it produced.
    const runState = { trigger: { output: {} }, steps: {} };
    const derived = [];
    for (const s of echo.steps) {
        for (const k of Object.keys(s)) assert.ok(['stepId', 'stepType', 'status', 'parentStepId', '_hint', 'error', 'errorClass', 'input', 'items', 'empty', 'nullKeys'].includes(k), `${label}: step key ${k}`);
        assert.ok(RUN_STATUSES.has(s.status), `${label}: "${s.status}" is not a status the runner records ('simulated' never was)`);
        assert.ok(knownIds.has(s.stepId), `${label}: dry-run step ${s.stepId} was never added in this example`);
        assert.deepEqual(Object.keys(s._hint).sort(), ['outputType', 'shape', 'topKeys'], `${label}: _hint shape`);
        const minted = idMap.get(s.stepId) || s.stepId;
        const step = (wrap.def.steps || []).find(x => x.id === minted);
        assert.ok(step || s.stepId === 'trg', `${label}: ${s.stepId} is a step of the draft as built`);
        const synth = synthesisedOutput(step, runState);
        if (synth) {
            assert.equal(s.stepType, step.type, `${label}: ${s.stepId} stepType`);
            assert.deepEqual(s._hint, hintFor(synth.recorded), `${label}: ${s.stepId} _hint is not what the runner records for a synthesised ${step.type}`);
            runState.steps[minted] = { output: synth.bound };
            derived.push(step.type);
        } else if (LIVE_STEP_OUTPUTS[s.stepId]) {
            // A live step: a stand-in output (what the recorded _hint was
            // made of) so a later synthesised step can resolve a ref into it.
            runState.steps[minted] = { output: LIVE_STEP_OUTPUTS[s.stepId] };
        }
    }
    return derived;
}

// The step types whose dry-run head was derived from the runner across the
// three examples (the invoice fan-out has none: every synthesised step there
// sits in a forEach envelope, which stays shape-checked).
const PINNED_SYNTHESISED = new Set();

for (const [n, example] of examples().entries()) {
    test(`example ${n + 1}: every call replays and every echo has the real key set`, async () => {
        const wrap = freshWrap();
        const idMap = new Map();        // recorded id → minted id
        const knownIds = new Set(['trg']);
        for (const call of callsOf(example)) {
            const label = `${call.name} (${call.id})`;
            const args = withRealIds(call.args, idMap);
            let real;
            if (call.name === 'builder_set_plan') {
                // Route-handled (chatStream.js): the same two helpers, the same echo.
                const todos = Array.isArray(args.todos) && args.todos.length ? normalizePlanTodos(args.todos) : applyPlanMarkDone(wrap._todos, args.markDone);
                wrap._todos = todos;
                real = { ok: true, todos: todos.map((t, i) => ({ i, text: t.text, done: !!t.done })), next: (todos.find(t => !t.done) || {}).text || null };
                assert.deepEqual(call.echo.todos.map(t => t.done), real.todos.map(t => t.done), `${label}: the recorded done flags`);
            } else if (call.name === 'builder_create_datatable') {
                real = await applyCreateDatatable(wrap, args, createDeps());
            } else if (call.name === 'builder_request_dry_run') {
                for (const t of checkDryRunEcho(call.echo, { knownIds, wrap, idMap }, label)) PINNED_SYNTHESISED.add(t);
                continue;
            } else if (call.name === 'builder_finalize') {
                // Needs the store. The shape is _applyToolCallRaw's slim echo.
                assert.deepEqual(keysOf(call.echo), ['automation', 'ok'], label);
                assert.deepEqual(Object.keys(call.echo.automation).sort(), ['id', 'title'], label);
                assert.equal(call.echo.automation.title, wrap.title, `${label}: finalize echoes the title builder_set_metadata set`);
                continue;
            } else {
                // Through JSON, as the model reads it: a digest key whose value
                // is undefined is not a key on the wire.
                real = JSON.parse(JSON.stringify(await applyToolCall(call.name, args, wrap)));
            }
            assert.ok(!real.error, `${label}: the real builders must accept the few-shot call — ${real.error}`);
            if (call.name === 'builder_add_steps') {
                for (const a of call.echo.added) idMap.set(a.id, real.idMap[a.tempId]);
                for (const a of call.echo.added) knownIds.add(a.id);
            }
            // The key sets first (a clearer message than a whole-object diff),
            // then the WHOLE echo against the real result with the minted ids
            // mapped back to the recorded ones: a summary sentence, an inspect
            // shape string, a digest line — every byte the model reads.
            if (call.name === 'builder_inspect_tool') {
                assert.deepEqual(Object.keys(call.echo.results).sort(), Object.keys(real.results).sort(), `${label}: inspected tools`);
                for (const t of Object.keys(real.results)) assert.deepEqual(keysOf(call.echo.results[t]), keysOf(real.results[t]), `${label}: results.${t}`);
            } else {
                assert.deepEqual(keysOf(call.echo), keysOf(real), `${label}: echo keys ≠ real keys`);
            }
            const recordedIds = new Map([...idMap].map(([rec, minted]) => [minted, rec]));
            assert.deepEqual(withoutRouteKeys(call.echo), withoutRouteKeys(withRealIds(real, recordedIds)), `${label}: the recorded echo is not what the builders return`);
        }
        // Every example ends named and finalized, in the user's language.
        assert.ok(wrap.title && wrap.title !== 'Untitled automation', 'the example named the automation');
        const last = example[example.length - 1];
        assert.equal(last.role, 'assistant');
        assert.ok(typeof last.content === 'string' && last.content.length > 0 && !last.tool_calls, 'ends with one sentence for the user');
    });
}

test('a synthesised send, extraction and datatable write were each pinned against the runner', () => {
    // Runs after the three example tests (node:test runs a file in order).
    // If a rewrite removes the last flat one of a kind, this fails rather
    // than letting that kind drift back to a transcribed head.
    for (const kind of ['integration_action', 'data_extraction', 'datatable']) {
        assert.ok(PINNED_SYNTHESISED.has(kind), `a flat synthesised ${kind} dry-run head was derived from the runner`);
    }
});

test('the batched example binds the search results through inputs, not a {{template}} in the prompt', () => {
    // Found by content: on the core toolset the Gmail digest sits LAST (the
    // fan-out leads), so its position is not something to rely on.
    const batched = examples().find(ex => callsOf(ex).some(c => c.name === 'builder_inspect_tool' && c.args.tools.includes('gmail_search')));
    assert.ok(batched, 'the Gmail digest example is among the three');
    const batch = callsOf(batched).find(c => c.name === 'builder_add_steps');
    const ai = batch.args.steps.find(s => s.type === 'ai_step');
    assert.ok(!/\{\{/.test(ai.spec.prompt), 'no template in the prompt');
    assert.equal(ai.spec.inputs.emails.kind, 'ref');
});

test('builder_set_metadata is called in reply 1 of every example, beside the trigger', () => {
    for (const ex of examples()) {
        const firstReply = ex.find(m => m.role === 'assistant');
        const names = firstReply.tool_calls.map(tc => tc.function.name);
        assert.ok(names.includes('builder_set_metadata'), `reply 1 names the automation: ${names.join(', ')}`);
        assert.ok(names.includes('builder_propose_trigger'), 'beside the trigger');
        const args = JSON.parse(firstReply.tool_calls.find(tc => tc.function.name === 'builder_set_metadata').function.arguments);
        assert.ok(args.title.length <= 60, `title ≤ 60 chars: ${args.title}`);
    }
});
