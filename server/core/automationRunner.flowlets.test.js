/**
 * Unit tests for the INLINE Layers runtime in automationRunner.
 *
 * Layers live at definition.layers[<key>] (resolved via ctx.layers — no DB
 * fetch). Exercises execCallLayer's key resolution, legacy-layerId error,
 * recursion + depth guards, the layer_output contract, shared-vars
 * semantics, namespaced sub-step recording (stepId 'cl1/out' +
 * parentStepId 'cl1', nested 'cl1/cl2/out'), loop suppression, the
 * approval-inside-layer guard, and that recordRunStep still receives
 * secretValues (WS5.2) — WITHOUT a DB or any external services; heavy deps
 * are pre-mocked via the require cache.
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Capture every recordRunStep call so the sub-step recording assertions can
// inspect stepId / parentStepId / secretValues.
let recorded = [];
mock('../stores/automationStore', {
    getAutomation: async () => null,
    // UPSERT, like the real store's ON CONFLICT (run_id, step_id, attempts):
    // the engine writes each step twice — a `running` row at dispatch so the
    // public form's progress trail has something to read, then the outcome.
    // An append-only stub would show every step here twice.
    recordRunStep: async (row) => {
        const i = recorded.findIndex(r => r.stepId === row.stepId && (r.attempts || 1) === (row.attempts || 1));
        if (i >= 0) recorded[i] = { ...recorded[i], ...row };
        else recorded.push(row);
    },
});
// DB + service deps the runner pulls in at load time (unused by these tests).
mock('../stores/configStore', {});
mock('../stores/notificationStore', {});
// builderTools (the flowlet built through the builder, below) pulls in stores
// that initialise against the db at load time.
mock('../db', {
    pool: {},
    run: async () => ({ rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    exec: async () => {},
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    withTransaction: async fn => fn({ query: async () => ({ rows: [] }) }),
    getRedis: () => null,
    redisHealthy: () => false,
});
mock('./aiAgent', { getProviderForModel: async () => null });
mock('./providers', { getAdapter: () => ({}) });
mock('../automation/codeSandbox', { run: async () => ({}) });

const runner = require('./automationRunner');

// A dispatch stub: call_layer routes back into the real execCallLayer (so
// nested layers + sub-recording work); everything else returns a fixed
// output, like the original stub did.
const dispatch = async (step, ctx, runState, mode) => {
    if (step.type === 'call_layer') {
        const r = await runner.execCallLayer(step, ctx, runState, mode, dispatch);
        r.startedAt = new Date().toISOString();
        r.inputSnapshot = null;
        return r;
    }
    return { output: { result: 42 }, startedAt: new Date().toISOString(), inputSnapshot: null };
};

function layerDef() {
    return {
        title: 'Test layer',
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'x', type: 'string' }] },
        steps: [{ id: 'out', type: 'layer_output', fields: { result: { kind: 'literal', value: 42 } } }],
        edges: [{ from: 'trg', to: 'out' }],
    };
}

function rootRecord() {
    return { prefix: '', parentStepId: null, suppress: false };
}

test.beforeEach(() => { recorded = []; });

test('execCallLayer rejects a legacy layerId reference with a migration hint', async () => {
    const step = { id: 'cl1', type: 'call_layer', layerId: 'L1', inputs: {} };
    await assert.rejects(
        () => runner.execCallLayer(step, { layers: {} }, { secrets: {} }, 'dry_run', dispatch),
        /legacy layer reference.*re-save/i,
    );
});

test('execCallLayer rejects a step with no layerKey at all', async () => {
    const step = { id: 'cl1', type: 'call_layer', inputs: {} };
    await assert.rejects(
        () => runner.execCallLayer(step, { layers: {} }, { secrets: {} }, 'dry_run', dispatch),
        /missing layerKey/i,
    );
});

test('execCallLayer rejects an unknown layerKey, listing available keys', async () => {
    const step = { id: 'cl1', type: 'call_layer', layerKey: 'nope', inputs: {} };
    const ctx = { layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    await assert.rejects(
        () => runner.execCallLayer(step, ctx, { secrets: {} }, 'dry_run', dispatch),
        /Unknown layer "nope".*enrich/s,
    );
});

test('execCallLayer rejects direct + transitive recursion (layerKey stack)', async () => {
    const step = { id: 'cl1', type: 'call_layer', layerKey: 'b', inputs: {} };
    const ctx = { layers: { a: layerDef(), b: layerDef() }, layerStack: ['a', 'b'] };
    await assert.rejects(
        () => runner.execCallLayer(step, ctx, { secrets: {} }, 'dry_run', dispatch),
        /recursion.*a → b → b/i,
    );
});

test('execCallLayer enforces the max nesting depth', async () => {
    const step = { id: 'cl1', type: 'call_layer', layerKey: 'x', inputs: {} };
    const stack = Array.from({ length: runner.MAX_LAYER_DEPTH }, (_, i) => `l${i}`);
    const ctx = { layers: { x: layerDef() }, layerStack: stack };
    await assert.rejects(
        () => runner.execCallLayer(step, ctx, { secrets: {} }, 'dry_run', dispatch),
        /depth/i,
    );
});

test('execCallLayer resolves ctx.layers, runs the mini-def, returns the layer_output contract', async () => {
    const step = {
        id: 'cl1', type: 'call_layer', layerKey: 'enrich',
        inputs: { x: { kind: 'literal', value: 'hi' } },
    };
    const ctx = { layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    const res = await runner.execCallLayer(step, ctx, { secrets: {}, vars: {} }, 'dry_run', dispatch);
    assert.deepStrictEqual(res.output, { result: 42 });
});

test('layer sub-state shares the parent vars object BY REFERENCE and maps inputs into trigger.output', async () => {
    let seenSub = null;
    const probe = async (step, ctx, runState) => {
        seenSub = runState;
        return { output: { ok: true }, startedAt: '', inputSnapshot: null };
    };
    const step = { id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: { x: { kind: 'literal', value: 'val-1' } } };
    const parentVars = { shared: 1 };
    const ctx = { layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    await runner.execCallLayer(step, ctx, { secrets: {}, vars: parentVars }, 'dry_run', probe);
    assert.ok(seenSub, 'sub-dispatch ran');
    assert.strictEqual(seenSub.vars, parentVars, 'vars must be the SAME object reference');
    assert.strictEqual(seenSub.trigger.output.x, 'val-1', 'resolved inputs land in trigger.output');
});

test('sub-step recording: stepId "cl1/out" with parentStepId "cl1"; secretValues still passed', async () => {
    const parentDef = {
        trigger: { id: 'ptrg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
        edges: [{ from: 'ptrg', to: 'cl1' }],
    };
    const ctx = { runId: 'r1', layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    const state = { trigger: { output: {} }, steps: {}, vars: {}, secrets: { tok: 's3cr3t-value' }, loop: {} };
    await runner.runDag(parentDef, ctx, state, 'live', dispatch, { recordSteps: true });

    // The caller comes FIRST now: every step writes a `running` row when it is
    // dispatched, so the public form's progress trail can say where the automation
    // is. A call_layer is therefore on record before the sub-steps it runs,
    // where it used to appear only on completion — i.e. after them.
    const ids = recorded.map(r => [r.stepId, r.parentStepId ?? null]);
    assert.deepStrictEqual(ids, [
        ['cl1', null],
        ['cl1/out', 'cl1'],
    ], `unexpected recorded rows: ${JSON.stringify(ids)}`);
    // WS5.2 — every record site must keep threading secretValues so the
    // persistence chokepoint can mask them.
    for (const r of recorded) {
        assert.ok(Array.isArray(r.secretValues), 'secretValues array present');
        assert.ok(r.secretValues.includes('s3cr3t-value'), 'in-flight secret handed to recordRunStep');
    }
});

test('nested layers record "cl1/cl2/out" with parentStepId "cl1/cl2"', async () => {
    const layerB = layerDef();
    const layerA = {
        title: 'A',
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [
            { id: 'cl2', type: 'call_layer', layerKey: 'b', inputs: {} },
            { id: 'out', type: 'layer_output', fields: { r: { kind: 'ref', path: 'steps.cl2.output.result' } } },
        ],
        edges: [{ from: 'trg', to: 'cl2' }, { from: 'cl2', to: 'out' }],
    };
    const parentDef = {
        trigger: { id: 'ptrg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'a', inputs: {} }],
        edges: [{ from: 'ptrg', to: 'cl1' }],
    };
    const ctx = { runId: 'r1', layers: { a: layerA, b: layerB }, stepRecord: rootRecord() };
    const state = { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {} };
    await runner.runDag(parentDef, ctx, state, 'live', dispatch, { recordSteps: true });

    const byId = new Map(recorded.map(r => [r.stepId, r.parentStepId ?? null]));
    assert.strictEqual(byId.get('cl1'), null);
    assert.strictEqual(byId.get('cl1/cl2'), 'cl1');
    assert.strictEqual(byId.get('cl1/cl2/out'), 'cl1/cl2');
    assert.strictEqual(byId.get('cl1/out'), 'cl1');
    assert.strictEqual(recorded.length, 4, `expected 4 rows, got ${JSON.stringify([...byId.keys()])}`);
});

test('loop suppression: a call_layer inside a loop body records NOTHING', async () => {
    const loopStep = {
        id: 'loop1', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item',
        maxIterations: 10,
        body: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
    };
    const ctx = { runId: 'r1', layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    const state = { trigger: { output: { items: [1, 2] } }, steps: {}, vars: {}, secrets: {}, loop: {} };
    const res = await runner.execLoop(loopStep, ctx, state, 'live', dispatch);
    assert.strictEqual(res.output.iterations, 2, 'loop ran');
    assert.deepStrictEqual(res.output.results.map(r => r.output), [{ result: 42 }, { result: 42 }], 'layer output flowed back');
    assert.strictEqual(recorded.length, 0, `loop bodies stay unrecorded, got ${JSON.stringify(recorded.map(r => r.stepId))}`);
});

test('execApproval throws inside a layer (runtime backstop)', async () => {
    const step = { id: 'ap1', type: 'approval', prompt: 'ok?' };
    await assert.rejects(
        () => runner.execApproval(step, { layerStack: ['a'] }, { secrets: {} }, 'live'),
        /not supported inside layers/i,
    );
});

test('execLayerOutput resolves its fields map', async () => {
    const step = { id: 'out', type: 'layer_output', fields: { a: { kind: 'literal', value: 7 } } };
    const res = await runner.execLayerOutput(step, {}, { secrets: {} });
    assert.deepStrictEqual(res.output, { a: 7 });
});

// ═══ A flowlet that returns a Code step's fields ═══════════════════════════
//
// Built the way the AI builder builds it, run through the real layer runtime
// (runDag → execCallLayer → execLayerOutput, real bind.js).
//
// The bug (2026-10-09, "1.2 Get ticketlist"): Flowlet input → web service →
// Code "Format Output" returning { count, tickets } → Return { count, tickets }.
// The Return step said "nothing · Mappings that found nothing" and the calling
// "Sub: Get Ticket List" step produced an empty record. Two causes, both in
// what the builder saved:
//   - a Code step's output is execCode's envelope { result, logs, httpCalls };
//     the canvas picker binds `steps.<code>.output.result.count`, the builder
//     saved `steps.<code>.output.count`, which holds nothing;
//   - "add after the flowlet input" became a branch BESIDE the Return
//     (trg → out, trg → code), so the Return ran before the code step.
//
// The code step is a stub returning execCode's exact envelope
// (core/automationRunner/execOutbound.js): the sandbox is not what is under
// test, the path from its output to the caller is.

const { applyToolCall, emptyDefinition } = require('../automation/builderTools');
const { execSet } = require('./automationRunner/engine');

const TICKETS = Array.from({ length: 15 }, (_, i) => ({
    id: 1000 + i, description: `Ticket ${i + 1}`, status: 'open', createdAt: '2026-10-01',
}));

// What execCode leaves in runState for a code that returned `returned`.
const codeEnvelope = returned => ({ result: returned, logs: [], httpCalls: 0 });

/** Dispatch with the real control-flow and data executors; code is a stub. */
function makeDispatch(codeReturns) {
    const dispatch = async (step, ctx, runState, mode) => {
        const at = new Date().toISOString();
        if (step.type === 'call_layer') return { ...(await runner.execCallLayer(step, ctx, runState, mode, dispatch)), startedAt: at, inputSnapshot: null };
        if (step.type === 'layer_output') return { ...(await runner.execLayerOutput(step, ctx, runState)), startedAt: at, inputSnapshot: null };
        if (step.type === 'set') return { ...(await execSet(step, ctx, runState)), startedAt: at, inputSnapshot: null };
        if (step.type === 'code') return { output: codeEnvelope(codeReturns), startedAt: at, inputSnapshot: null };
        throw new Error(`unexpected step type ${step.type}`);
    };
    return dispatch;
}

async function runWhole(def, codeReturns) {
    const ctx = { runId: 'r1', layers: def.layers, stepRecord: { prefix: '', parentStepId: null, suppress: false } };
    const state = { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {} };
    await runner.runDag(def, ctx, state, 'live', makeDispatch(codeReturns), { recordSteps: true });
    return state;
}

/**
 * The flowlet as the builder makes it: Flowlet input (paginate, page) →
 * Code "Format Output" → Return; the root: Edit data → Sub: Get Ticket List.
 * `outputs` is what the model asked set_layer_contract for.
 */
async function buildTicketFlowlet(outputs) {
    const dw = { userId: 'u_test', def: emptyDefinition() };
    const layer = await applyToolCall('builder_create_layer', {
        title: 'Get ticketlist',
        params: [{ name: 'paginate', type: 'boolean', required: true }, { name: 'page', type: 'number', required: true }],
    }, dw);
    assert.ok(!layer.error, layer.error);
    const key = layer.layerKey;
    const code = await applyToolCall('builder_add_code_step', {
        scope: key, afterStepId: 'trg', label: 'Format Output',
        code: '/** Format the tickets.\n * @param {number} inputs.page - Page */\nasync function main(inputs) { return { count: 0, tickets: [] }; }',
        inputs: { page: { kind: 'ref', path: 'trigger.output.page' } },
        outputSchema: { count: 'number', tickets: 'array' },
    }, dw);
    assert.ok(!code.error, code.error);
    const codeId = code.added.id;
    const contract = await applyToolCall('builder_set_layer_contract', { layerKey: key, outputs: outputs(codeId) }, dw);
    assert.ok(!contract.error, contract.error);

    const set = await applyToolCall('builder_add_set', {
        afterStepId: 'trg', label: 'Edit data',
        fields: { page: { kind: 'literal', value: 1 }, paginate: { kind: 'literal', value: false } },
    }, dw);
    assert.ok(!set.error, set.error);
    const call = await applyToolCall('builder_add_call_layer', {
        layerKey: key, afterStepId: set.added.id, label: 'Sub: Get Ticket List',
        inputs: {
            page: { kind: 'ref', path: `steps.${set.added.id}.output.page` },
            paginate: { kind: 'ref', path: `steps.${set.added.id}.output.paginate` },
        },
    }, dw);
    assert.ok(!call.error, call.error);
    return { def: dw.def, key, codeId, callId: call.added.id, contract };
}

test('builder: a Return field bound to a code step field is stored under output.result, and says so', async () => {
    const { def, key, codeId, contract } = await buildTicketFlowlet(id => ({
        count: { kind: 'ref', path: `steps.${id}.output.count` },
        tickets: { kind: 'ref', path: `steps.${id}.output.tickets` },
    }));
    const out = def.layers[key].steps.find(s => s.type === 'layer_output');
    assert.deepStrictEqual(out.fields, {
        count: { kind: 'ref', path: `steps.${codeId}.output.result.count` },
        tickets: { kind: 'ref', path: `steps.${codeId}.output.result.tickets` },
    });
    assert.ok((contract._warnings || []).some(w => /output\.result\.count/.test(w) && /code step/.test(w)),
        `the repair is named back to the model: ${JSON.stringify(contract._warnings)}`);
    // "Add after the flowlet input" put the code step BETWEEN the input and
    // the Return, not beside the Return.
    assert.deepStrictEqual(def.layers[key].edges, [{ from: codeId, to: 'out' }, { from: 'trg', to: codeId }]);
});

test('builder: a list read from a code step points at what the code returned', async () => {
    const { def, codeId } = await buildTicketFlowlet(id => ({ tickets: { kind: 'ref', path: `steps.${id}.output.tickets` } }));
    const dw = { userId: 'u_test', def };
    const key = Object.keys(def.layers)[0];
    const f = await applyToolCall('builder_add_filter', {
        scope: key, afterStepId: codeId, arrayRef: `steps.${codeId}.output`, expr: 'item.status == "open"',
    }, dw);
    assert.ok(!f.error, f.error);
    // outputSchema says the code returns one list, so the list is that one.
    assert.strictEqual(f.added.arrayRef, `steps.${codeId}.output.result.tickets`);
});

test('builder: the path the canvas picker writes is kept as it is', async () => {
    const { def, key, codeId, contract } = await buildTicketFlowlet(id => ({
        count: { kind: 'ref', path: `steps.${id}.output.result.count` },
        tickets: { kind: 'ref', path: `steps.${id}.output.result.tickets` },
    }));
    const out = def.layers[key].steps.find(s => s.type === 'layer_output');
    assert.strictEqual(out.fields.count.path, `steps.${codeId}.output.result.count`);
    assert.strictEqual(out.fields.tickets.path, `steps.${codeId}.output.result.tickets`);
    assert.ok(!(contract._warnings || []).some(w => /result/.test(w)), 'no repair note for a correct path');
});

test('run: the builder-made flowlet hands count and tickets to the calling step', async () => {
    const { def, codeId, callId } = await buildTicketFlowlet(id => ({
        count: { kind: 'ref', path: `steps.${id}.output.count` },
        tickets: { kind: 'ref', path: `steps.${id}.output.tickets` },
    }));
    const state = await runWhole(def, { count: 15, tickets: TICKETS });
    assert.deepStrictEqual(state.steps[callId].output, { count: 15, tickets: TICKETS });
    // What the run history shows for the Return step and the caller: both fields.
    const byId = new Map(recorded.filter(r => r.status === 'success').map(r => [r.stepId, r]));
    assert.deepStrictEqual(Object.keys(byId.get(`${callId}/out`).output).sort(), ['count', 'tickets']);
    assert.deepStrictEqual(Object.keys(byId.get(callId).output).sort(), ['count', 'tickets']);
    assert.ok(byId.get(`${callId}/${codeId}`), 'the code step ran inside the flowlet');
    assert.strictEqual(byId.get(`${callId}/out`).bindingWarnings ?? null, null, 'no mapping found nothing');
});

test('run: a code step that returns the 15 records as a list', async () => {
    const { def, callId } = await buildTicketFlowlet(id => ({
        tickets: { kind: 'ref', path: `steps.${id}.output.result` },
        count: { kind: 'ref', path: `steps.${id}.output.result.length` },
    }));
    const state = await runWhole(def, TICKETS);
    assert.deepStrictEqual(state.steps[callId].output, { tickets: TICKETS, count: 15 });
});

test('run: a definition saved before the fix (no .result in the Return paths) still returns its data', async () => {
    // Built by hand: the builder no longer writes this, but stored
    // automations still hold it.
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'tickets', inputs: { page: { kind: 'literal', value: 1 } } }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: {
            tickets: {
                title: 'Get ticketlist',
                trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'page' }] },
                steps: [
                    { id: 'code_1', type: 'code', code: '', inputs: {} },
                    {
                        id: 'out', type: 'layer_output', fields: {
                            count: { kind: 'ref', path: 'steps.code_1.output.count' },
                            tickets: { kind: 'template', value: '{{steps.code_1.output.tickets[0].description}}' },
                            first: { kind: 'expr', value: 'steps.code_1.output.tickets[0].id' },
                        },
                    },
                ],
                edges: [{ from: 'trg', to: 'code_1' }, { from: 'code_1', to: 'out' }],
            },
        },
    };
    const state = await runWhole(def, { count: 15, tickets: TICKETS });
    assert.deepStrictEqual(state.steps.cl1.output, { count: 15, tickets: 'Ticket 1', first: 1000 });
});

test('run: a flowlet saved with its Return BESIDE the work (trg → out, trg → code) returns the work', async () => {
    // The shape the builder used to save for "add after the flowlet input".
    // The Return used to run second, before the code step, and returned {}.
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'tickets', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: {
            tickets: {
                title: 'Get ticketlist',
                trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
                steps: [
                    {
                        id: 'out', type: 'layer_output', fields: {
                            count: { kind: 'ref', path: 'steps.fmt.output.result.count' },
                            tickets: { kind: 'ref', path: 'steps.fmt.output.result.tickets' },
                        },
                    },
                    { id: 'web', type: 'set', fields: { status: { kind: 'literal', value: 200 } } },
                    { id: 'fmt', type: 'code', code: '', inputs: {} },
                ],
                edges: [{ from: 'trg', to: 'out' }, { from: 'trg', to: 'web' }, { from: 'web', to: 'fmt' }],
            },
        },
    };
    const state = await runWhole(def, { count: 15, tickets: TICKETS });
    assert.deepStrictEqual(state.steps.cl1.output, { count: 15, tickets: TICKETS });
    // Rows land in the order the steps were dispatched (a `running` row first).
    const order = recorded.map(r => r.stepId).filter(id => id.startsWith('cl1/'));
    assert.deepStrictEqual(order, ['cl1/web', 'cl1/fmt', 'cl1/out'], 'the Return runs last');
});

test('the paths the canvas picker builds for a code step resolve at run time', async () => {
    // agent-hub mapping/upstream/realOverlay.js offers a ran code step's
    // record fields at `<basePath>.result.<key>` (pinned with these same
    // paths in agent-hub …/Builder/mapping/upstream.realOverlay.test.js).
    const { resolveInputs } = require('../automation/bind');
    const runState = { steps: { fmt: { output: codeEnvelope({ count: 15, tickets: TICKETS }) } } };
    const r = resolveInputs({
        count: { kind: 'ref', path: 'steps.fmt.output.result.count' },
        tickets: { kind: 'ref', path: 'steps.fmt.output.result.tickets' },
        description: { kind: 'ref', path: 'steps.fmt.output.result.tickets[*].description' },
    }, runState);
    assert.strictEqual(r.count, 15);
    assert.strictEqual(r.tickets.length, 15);
    assert.strictEqual(r.description[14], 'Ticket 15');
});
