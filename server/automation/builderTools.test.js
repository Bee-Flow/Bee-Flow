/**
 * Unit tests for branch-aware edge wiring in the automation builder tools.
 *
 * Run: node automation/builderTools.test.js
 *
 * No DB needed — the add-* tools only mutate the in-memory draft definition
 * (only builder_request_dry_run / builder_finalize touch the store).
 */

const assert = require('assert');
const { applyToolCall, emptyDefinition, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}
function edge(def, fromId) {
    return def.edges.filter(e => e.from === fromId);
}

(async () => {
    // ── Appending after a condition auto-labels then (first) / else (second) ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        const condId = cond.added.id;
        // Incoming edge from the (manual) trigger must stay UNLABELLED — the
        // trigger is not a branching step.
        const incoming = dw.def.edges.find(e => e.to === condId);
        assert.ok(incoming && incoming.label === undefined, 'incoming edge to condition must be unlabelled');

        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: condId }, dw);
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: condId }, dw);
        const outs = edge(dw.def, condId);
        const e1 = outs.find(e => e.to === a1.added.id);
        const e2 = outs.find(e => e.to === a2.added.id);
        assert.strictEqual(e1.label, 'then', 'first append after condition → then');
        assert.strictEqual(e2.label, 'else', 'second append after condition → else');

        // The branch/caseName args must NOT leak onto the created step.
        assert.ok(!('branch' in a1.added) && !('caseName' in a1.added), 'branch/caseName must not leak onto the step');

        // Definition now validates — no dead_branch / partial_branch.
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => e.code === 'condition.dead_branch'), 'no dead_branch after wiring both branches');
        assert.ok(!v.warnings.some(e => e.code === 'condition.partial_branch'), 'no partial_branch after wiring both branches');
    }

    // ── Explicit branch override wins over auto-infer ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        const condId = cond.added.id;
        const a1 = await applyToolCall('builder_add_notification', { title: 'hi', afterStepId: condId, branch: 'else' }, dw);
        const e1 = edge(dw.def, condId).find(e => e.to === a1.added.id);
        assert.strictEqual(e1.label, 'else', 'explicit branch:"else" overrides the auto then-first');
    }

    // ── A one-sided condition is a WARNING (partial_branch), not an error ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw);
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => e.code === 'condition.dead_branch'), 'one wired branch is not a dead_branch error');
        assert.ok(v.warnings.some(e => e.code === 'condition.partial_branch'), 'one-sided condition warns partial_branch');
    }

    // ── Appending after a switch with caseName labels case:<name> ──
    {
        const dw = freshWrap();
        const sw = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dw);
        const swId = sw.added.id;
        const withCase = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: swId, caseName: 'urgent' }, dw);
        const e1 = edge(dw.def, swId).find(e => e.to === withCase.added.id);
        assert.strictEqual(e1.label, 'case:urgent', 'switch append with caseName → case:<name>');
        assert.strictEqual(e1.caseName, 'urgent', 'switch edge carries caseName');

        // default routes to case:default
        const dwd = freshWrap();
        const sw2 = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dwd);
        const def2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: sw2.added.id, caseName: 'default' }, dwd);
        const ed = edge(dwd.def, sw2.added.id).find(e => e.to === def2.added.id);
        assert.strictEqual(ed.label, 'case:default', 'switch append with caseName:"default" → case:default');
    }

    // ── Appending after a switch WITHOUT caseName leaves the edge unlabelled ──
    {
        const dw = freshWrap();
        const sw = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dw);
        const noCase = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: sw.added.id }, dw);
        const e1 = edge(dw.def, sw.added.id).find(e => e.to === noCase.added.id);
        assert.strictEqual(e1.label, undefined, 'switch append without caseName stays unlabelled (today behaviour)');
    }

    // ── Appending after a NORMAL step is unchanged (plain unlabelled edge) ──
    {
        const dw = freshWrap();
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: a1.added.id }, dw);
        const e1 = edge(dw.def, a1.added.id).find(e => e.to === a2.added.id);
        assert.strictEqual(e1.label, undefined, 'append after a normal step is an unlabelled edge');
    }

    // ═══ WS3: inline layers (create / contract / scope / call / recursion) ═══

    // ── builder_create_layer creates the skeleton + returns layerKey ──
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', {
            title: 'Enrich Contact',
            params: [{ name: 'email', type: 'string', required: true }],
        }, dw);
        assert.ok(!r.error, `create_layer must not error: ${r.error}`);
        assert.ok(/^[a-z][a-z0-9_]*$/.test(r.layerKey), `layerKey matches the key grammar: ${r.layerKey}`);
        const layer = dw.def.layers[r.layerKey];
        assert.ok(layer, 'layer stored at definition.layers[key]');
        assert.strictEqual(layer.title, 'Enrich Contact');
        assert.strictEqual(layer.trigger.kind, 'layer_input');
        assert.deepStrictEqual(layer.trigger.params, [{ name: 'email', type: 'string', required: true }]);
        assert.strictEqual(layer.steps.length, 1);
        assert.strictEqual(layer.steps[0].type, 'layer_output');
        assert.deepStrictEqual(layer.edges, [{ from: 'trg', to: 'out' }]);
        assert.strictEqual(dw.def.schemaVersion, 2, 'layers present → schemaVersion 2');
        // The _draftSteps reminder gains a per-layer section.
        const layerSection = (r._draftSteps || []).find(x => x.layer === r.layerKey);
        assert.ok(layerSection, '_draftSteps includes a per-layer section');
        assert.deepStrictEqual(layerSection.steps[0].params, ['email'], 'layer section lists the params');

        // ── scope param targets the layer graph, not the root ──
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: 'trg', scope: r.layerKey }, dw);
        assert.ok(!a1.error, `scoped add must not error: ${a1.error}`);
        assert.ok(layer.steps.some(s => s.id === a1.added.id), 'scoped step lands inside the layer');
        assert.ok(!dw.def.steps.some(s => s.id === a1.added.id), 'scoped step does NOT land in the root');
        assert.ok(layer.edges.some(e => e.from === 'trg' && e.to === a1.added.id), 'edge wired inside the layer');

        // builder_remove_step honours scope too.
        const rm = await applyToolCall('builder_remove_step', { stepId: a1.added.id, scope: r.layerKey }, dw);
        assert.ok(!rm.error && !layer.steps.some(s => s.id === a1.added.id), 'scoped remove deletes from the layer');

        // ── unknown scope → structured error ──
        const bad = await applyToolCall('builder_add_action', { tool: 'gmail_search', scope: 'nope' }, dw);
        assert.ok(bad.error && /Unknown flowlet scope/.test(bad.error), 'unknown scope rejected');

        // ── builder_set_layer_contract: params + outputFields (bindings preserved) ──
        layer.steps[0].fields = {
            score: { kind: 'ref', path: 'steps.x.output.s' },
            junk: { kind: 'literal', value: 'drop-me' },
        };
        const c = await applyToolCall('builder_set_layer_contract', {
            layerKey: r.layerKey,
            params: [{ name: 'email', required: true }, { name: 'name' }],
            outputFields: ['score', 'extra'],
        }, dw);
        assert.ok(!c.error, `set_layer_contract must not error: ${c.error}`);
        assert.deepStrictEqual(layer.trigger.params.map(p => p.name), ['email', 'name']);
        assert.deepStrictEqual(Object.keys(layer.steps[0].fields), ['score', 'extra']);
        assert.deepStrictEqual(layer.steps[0].fields.score, { kind: 'ref', path: 'steps.x.output.s' }, 'kept key keeps its binding');
        assert.deepStrictEqual(layer.steps[0].fields.extra, { kind: 'literal', value: '' }, 'new key starts as empty literal');
        const unknown = await applyToolCall('builder_set_layer_contract', { layerKey: 'nope' }, dw);
        assert.ok(unknown.error && /Unknown layerKey/.test(unknown.error), 'unknown layerKey rejected');

        // ── builder_add_call_layer by key (root scope) ──
        const cl = await applyToolCall('builder_add_call_layer', {
            layerKey: r.layerKey,
            inputs: { email: { kind: 'ref', path: 'trigger.output.email' } },
        }, dw);
        assert.ok(!cl.error, `add_call_layer must not error: ${cl.error}`);
        assert.strictEqual(cl.added.type, 'call_layer');
        assert.strictEqual(cl.added.layerKey, r.layerKey);
        assert.ok(!('layerId' in cl.added) && !('inputContract' in cl.added) && !('outputContract' in cl.added), 'no legacy fields on the new step');
        assert.ok(dw.def.steps.some(s => s.id === cl.added.id), 'call step lands in the root');

        // unknown target key
        const clBad = await applyToolCall('builder_add_call_layer', { layerKey: 'ghost' }, dw);
        assert.ok(clBad.error && /Unknown layerKey/.test(clBad.error), 'unknown layerKey rejected on call');
        // legacy layerId arg
        const clLegacy = await applyToolCall('builder_add_call_layer', { layerId: 'uuid' }, dw);
        assert.ok(clLegacy.error && /layerKey/.test(clLegacy.error), 'layerId arg rejected with a layerKey hint');
    }

    // ── recursion rejection: target closure must not reach the calling scope ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_create_layer', { title: 'Layer A' }, dw);
        const b = await applyToolCall('builder_create_layer', { title: 'Layer B' }, dw);
        // Direct self-call: inside A, call A.
        const self = await applyToolCall('builder_add_call_layer', { layerKey: a.layerKey, scope: a.layerKey, afterStepId: 'trg' }, dw);
        assert.ok(self.error && /Recursive/.test(self.error), 'A calling A is rejected');
        // Sibling call B from inside A is fine…
        const ok = await applyToolCall('builder_add_call_layer', { layerKey: b.layerKey, scope: a.layerKey, afterStepId: 'trg' }, dw);
        assert.ok(!ok.error, `sibling call must pass: ${ok.error}`);
        // …but now B (transitively reached from A) calling A would close the cycle.
        const cyc = await applyToolCall('builder_add_call_layer', { layerKey: a.layerKey, scope: b.layerKey, afterStepId: 'trg' }, dw);
        assert.ok(cyc.error && /Recursive/.test(cyc.error), 'A→B→A transitive recursion rejected');
    }

    // ── builder_propose_trigger refuses a scope (root-only) ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_create_layer', { title: 'L' }, dw);
        const r = await applyToolCall('builder_propose_trigger', { kind: 'manual', scope: 'l' }, dw);
        assert.ok(r.error && /does not accept a scope/.test(r.error), 'propose_trigger with scope rejected');
    }

    // ═══ Layers keep their layer_output ("Return") TERMINAL while building ═══
    // Regression: the skeleton wires trigger→layer_output, so naively appending
    // chained new steps AFTER the output — the layer returned nothing and ran
    // its real work as dead code. Appending (no afterStepId) must splice each
    // step in BEFORE the output so the output stays the sink.
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', {
            title: 'Find invoices',
            params: [{ name: 'supplierName', type: 'string', required: true }],
        }, dw);
        const key = r.layerKey;
        const layer = dw.def.layers[key];
        const outId = layer.steps.find(s => s.type === 'layer_output').id;

        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search', scope: key }, dw);
        const agg = await applyToolCall('builder_add_aggregate', { scope: key }, dw);

        // The output must never have an OUTGOING edge — it is the terminal node.
        assert.ok(!layer.edges.some(e => e.from === outId), 'layer_output has no outgoing edge (stays terminal)');
        // Linear chain trg → action → aggregate → out.
        assert.ok(layer.edges.some(e => e.from === 'trg' && e.to === a.added.id), 'trigger → first step');
        assert.ok(layer.edges.some(e => e.from === a.added.id && e.to === agg.added.id), 'first step → aggregate');
        assert.ok(layer.edges.some(e => e.from === agg.added.id && e.to === outId), 'aggregate → output (output is last)');
        // No duplicate edge into the output left behind by the splice.
        assert.strictEqual(layer.edges.filter(e => e.to === outId).length, 1, 'output has exactly one incoming edge');
    }

    // ═══ builder_set_layer_contract `outputs` binds the Return step directly ═══
    // The layer returns data by binding its layer_output fields — never via a
    // separate `set` step. One call declares AND binds.
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', { title: 'Bind out', params: [] }, dw);
        const key = r.layerKey;
        const layer = dw.def.layers[key];
        const agg = await applyToolCall('builder_add_aggregate', { scope: key }, dw);

        const c = await applyToolCall('builder_set_layer_contract', {
            layerKey: key,
            outputs: { invoices: { kind: 'ref', path: `steps.${agg.added.id}.output.values` } },
        }, dw);
        assert.ok(!c.error, `outputs binding must not error: ${c.error}`);
        const out = layer.steps.find(s => s.type === 'layer_output');
        assert.deepStrictEqual(out.fields.invoices, { kind: 'ref', path: `steps.${agg.added.id}.output.values` }, 'Return field bound to the aggregate output');
        assert.deepStrictEqual(c.outputFields, ['invoices'], 'contract reports the bound field');

        // A non-object outputs is rejected with a helpful message.
        const bad = await applyToolCall('builder_set_layer_contract', { layerKey: key, outputs: ['nope'] }, dw);
        assert.ok(bad.error && /outputs must be a map/.test(bad.error), 'array outputs rejected');
    }

    // ═══ Per-step forEach: a single leaf step iterates WITHOUT a loop ═══
    {
        const dw = freshWrap();
        const search = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: {} }, dw);
        const over = `steps.${search.added.id}.output.messages`;

        const read = await applyToolCall('builder_add_action', {
            tool: 'gmail_read', forEach: { overRef: over, itemVar: 'email' },
        }, dw);
        assert.ok(!read.error, `forEach add must not error: ${read.error}`);
        assert.deepStrictEqual(read.added.forEach, { overRef: over, itemVar: 'email' }, 'step carries the validated forEach');

        // itemVar defaults to "item"
        const read2 = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: { overRef: over } }, dw);
        assert.strictEqual(read2.added.forEach.itemVar, 'item', 'itemVar defaults to "item"');

        // rootless overRef rejected (same ref rules as inputs)
        const bad = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: { overRef: 'messages' } }, dw);
        assert.ok(bad.error && /forEach\.overRef/.test(bad.error), 'forEach with a rootless overRef is rejected');
        // missing overRef rejected
        const bad2 = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: {} }, dw);
        assert.ok(bad2.error && /overRef/.test(bad2.error), 'forEach without overRef is rejected');
        // maxIterations out of range rejected
        const bad3 = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: { overRef: over, maxIterations: 9999 } }, dw);
        assert.ok(bad3.error && /maxIterations/.test(bad3.error), 'forEach maxIterations range enforced');

        // a forEach action produces no `foreach.*` validation errors.
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => String(e.code).startsWith('foreach.')), 'integration_action + forEach validates with no foreach errors');
    }

    // ═══ forEach honours scope + the validator rejects it on non-leaf types ═══
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', { title: 'Iter', params: [{ name: 'items' }] }, dw);
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_read', scope: r.layerKey, forEach: { overRef: 'trigger.output.items', itemVar: 'it' } }, dw);
        assert.ok(!a.error, `scoped forEach add must not error: ${a.error}`);
        assert.ok(dw.def.layers[r.layerKey].steps.some(s => s.id === a.added.id && s.forEach?.overRef === 'trigger.output.items'), 'forEach step lands inside the layer with its overRef');

        // validate.js backstop: forEach on a loop (a container) is unsupported.
        const loopDef = {
            schemaVersion: 2,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [{ id: 'l1', type: 'loop', overRef: 'trigger.output.x', itemVar: 'i', body: [], forEach: { overRef: 'trigger.output.x', itemVar: 'i' } }],
            edges: [{ from: 'trg', to: 'l1' }],
        };
        const lv = validateDefinition(loopDef);
        assert.ok(lv.errors.some(e => e.code === 'foreach.type_unsupported'), 'forEach on a loop step is rejected by the validator');
    }

    // ═══════════════════════════════════════════════════════════════════
    // §A — in-place editing: builder_update_step / replace_step / update_steps
    //      and safe-delete reconnect.
    // ═══════════════════════════════════════════════════════════════════

    // ── update preserves id + ALL wiring; only patched fields change ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw); // then
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw);           // else
        const edgesBefore = JSON.stringify(dw.def.edges);
        const up = await applyToolCall('builder_update_step', { stepId: a1.added.id, patch: { label: 'Renamed', inputs: { q: { kind: 'literal', value: 'x' } } } }, dw);
        assert.ok(!up.error, `update must not error: ${up.error}`);
        assert.strictEqual(up.updated.id, a1.added.id, 'id unchanged by update');
        assert.strictEqual(up.updated.label, 'Renamed', 'label patched');
        assert.deepStrictEqual(up.updated.inputs.q, { kind: 'literal', value: 'x' }, 'inputs patched + validated');
        assert.strictEqual(JSON.stringify(dw.def.edges), edgesBefore, 'edges untouched by update (wiring preserved)');
    }

    // ── inputs merge (default) vs null-delete vs replace ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { q: { kind: 'literal', value: '1' }, max: { kind: 'literal', value: '2' } } }, dw);
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { inputs: { q: { kind: 'literal', value: '9' }, c: { kind: 'literal', value: '3' } } } }, dw);
        let step = dw.def.steps.find(s => s.id === a.added.id);
        assert.deepStrictEqual(Object.keys(step.inputs).sort(), ['c', 'max', 'q'], 'merge keeps untouched keys, adds new');
        assert.strictEqual(step.inputs.q.value, '9', 'merge overwrites a touched key');
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { inputs: { max: null } } }, dw);
        step = dw.def.steps.find(s => s.id === a.added.id);
        assert.ok(!('max' in step.inputs), 'value:null deletes that one key');
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { inputs: { only: { kind: 'literal', value: 'z' } } }, inputsMode: 'replace' }, dw);
        step = dw.def.steps.find(s => s.id === a.added.id);
        assert.deepStrictEqual(Object.keys(step.inputs), ['only'], 'inputsMode:replace overwrites the whole map');
    }

    // ── invalid binding in a patch is rejected with no mutation ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { q: { kind: 'literal', value: '1' } } }, dw);
        const before = JSON.stringify(dw.def.steps.find(s => s.id === a.added.id));
        const r = await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { inputs: { bad: { kind: 'ref', path: 'nope.field' } } } }, dw);
        assert.ok(r.error, 'bad ref root rejected');
        assert.strictEqual(JSON.stringify(dw.def.steps.find(s => s.id === a.added.id)), before, 'step unchanged on error');
    }

    // ── forEach add then clear; non-forEach-capable type rejects it ──
    {
        const dw = freshWrap();
        const search = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_read', afterStepId: search.added.id }, dw);
        const over = `steps.${search.added.id}.output.messages`;
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { forEach: { overRef: over, itemVar: 'email' } } }, dw);
        assert.deepStrictEqual(dw.def.steps.find(s => s.id === a.added.id).forEach, { overRef: over, itemVar: 'email' }, 'forEach added via patch');
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { forEach: null } }, dw);
        assert.ok(!('forEach' in dw.def.steps.find(s => s.id === a.added.id)), 'forEach cleared via null');
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x==1', afterStepId: a.added.id }, dw);
        const bad = await applyToolCall('builder_update_step', { stepId: cond.added.id, patch: { forEach: { overRef: over } } }, dw);
        assert.ok(bad.error && /not patchable/.test(bad.error), 'forEach not patchable on a condition');
    }

    // ── non-patchable field + type change + unknown id are rejected ──
    {
        const dw = freshWrap();
        const ai = await applyToolCall('builder_add_ai_step', { prompt: 'x' }, dw);
        const r1 = await applyToolCall('builder_update_step', { stepId: ai.added.id, patch: { type: 'condition' } }, dw);
        assert.ok(r1.error && /type/.test(r1.error), 'changing type via update_step rejected');
        const r2 = await applyToolCall('builder_update_step', { stepId: ai.added.id, patch: { tool: 'gmail_search' } }, dw);
        assert.ok(r2.error && /not patchable/.test(r2.error), 'tool not patchable on ai_step');
        const r3 = await applyToolCall('builder_update_step', { stepId: 'ghost', patch: { label: 'x' } }, dw);
        assert.ok(r3.error && /Unknown stepId/.test(r3.error), 'unknown stepId rejected');
    }

    // ── replace ai_step → integration_action keeps id + incoming edge ──
    {
        const dw = freshWrap();
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const ai = await applyToolCall('builder_add_ai_step', { prompt: 'x', afterStepId: a1.added.id }, dw);
        const incomingBefore = dw.def.edges.find(e => e.to === ai.added.id);
        const rep = await applyToolCall('builder_replace_step', { stepId: ai.added.id, newType: 'integration_action', spec: { tool: 'gmail_compose' } }, dw);
        assert.ok(!rep.error, `replace must not error: ${rep.error}`);
        assert.strictEqual(rep.replaced.id, ai.added.id, 'id preserved across type swap');
        assert.strictEqual(rep.replaced.type, 'integration_action', 'type changed');
        assert.strictEqual(rep.replaced.tool, 'gmail_compose');
        assert.ok(rep.replaced.sideEffect === true, 'derived sideEffect computed on the new step');
        assert.deepStrictEqual(dw.def.edges.find(e => e.to === ai.added.id), incomingBefore, 'incoming edge intact');
        assert.strictEqual(dw.def.steps.find(s => s.id === ai.added.id).type, 'integration_action', 'node replaced in place');
    }

    // ── replace condition → notification strips now-invalid branch labels ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x==1' }, dw);
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw); // then
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw); // else
        assert.ok(dw.def.edges.some(x => x.from === cond.added.id && x.label === 'then'), 'precondition: then label present');
        const rep = await applyToolCall('builder_replace_step', { stepId: cond.added.id, newType: 'notification', spec: { title: 'hi' } }, dw);
        assert.ok(!rep.error, `replace must not error: ${rep.error}`);
        assert.ok(rep.rewired && /Stripped/.test(rep.rewired), 'rewired note reports stripped labels');
        assert.ok(dw.def.edges.filter(x => x.from === cond.added.id).every(x => x.label === undefined), 'branch labels stripped (no dead-end)');
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => e.code === 'condition.dead_branch'), 'no dead_branch after strip');
    }

    // ── replace action → condition leaves the self-correction breadcrumb ──
    {
        const dw = freshWrap();
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: a1.added.id }, dw);
        const rep = await applyToolCall('builder_replace_step', { stepId: a1.added.id, newType: 'condition', spec: { expr: 'trigger.output.x==1' } }, dw);
        assert.ok(!rep.error, `replace must not error: ${rep.error}`);
        assert.ok(rep.rewired && /branching/.test(rep.rewired), 'breadcrumb tells the agent to wire branch targets');
    }

    // ── scoped update inside a flowlet mutates the layer, not the root ──
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', { title: 'L', params: [] }, dw);
        const a = await applyToolCall('builder_add_ai_step', { prompt: 'x', scope: r.layerKey }, dw);
        const up = await applyToolCall('builder_update_step', { stepId: a.added.id, scope: r.layerKey, patch: { prompt: 'y' } }, dw);
        assert.ok(!up.error, `scoped update must not error: ${up.error}`);
        assert.strictEqual(dw.def.layers[r.layerKey].steps.find(s => s.id === a.added.id).prompt, 'y', 'layer step patched');
        assert.ok(!dw.def.steps.some(s => s.id === a.added.id), 'root untouched by scoped update');
    }

    // ── loop-body step patch via the locator; top-level edges untouched ──
    {
        const dw = freshWrap();
        const search = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const over = `steps.${search.added.id}.output.messages`;
        const loop = await applyToolCall('builder_add_loop', { overRef: over, itemVar: 'it', afterStepId: search.added.id, body: [{ type: 'ai_step', id: 'lb1', prompt: 'a' }] }, dw);
        const edgesBefore = JSON.stringify(dw.def.edges);
        const up = await applyToolCall('builder_update_step', { stepId: 'lb1', patch: { prompt: 'b' } }, dw);
        assert.ok(!up.error, `loop-body update must not error: ${up.error}`);
        assert.strictEqual(dw.def.steps.find(s => s.id === loop.added.id).body.find(b => b.id === 'lb1').prompt, 'b', 'loop body step patched');
        assert.strictEqual(JSON.stringify(dw.def.edges), edgesBefore, 'top-level edges untouched');
    }

    // ── delete with reconnect bridges A→B→C into A→C; reconnect:false severs ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const b = await applyToolCall('builder_add_ai_step', { prompt: 'x', afterStepId: a.added.id }, dw);
        const c = await applyToolCall('builder_add_notification', { title: 't', afterStepId: b.added.id }, dw);
        const rm = await applyToolCall('builder_remove_step', { stepId: b.added.id }, dw);
        assert.ok(!rm.error, `remove must not error: ${rm.error}`);
        assert.ok(!dw.def.steps.some(s => s.id === b.added.id), 'B removed');
        assert.ok(dw.def.edges.some(e => e.from === a.added.id && e.to === c.added.id), 'A→C bridged');
        assert.ok(!dw.def.edges.some(e => e.from === b.added.id || e.to === b.added.id), 'B incident edges gone');

        const dw2 = freshWrap();
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw2);
        const b2 = await applyToolCall('builder_add_ai_step', { prompt: 'x', afterStepId: a2.added.id }, dw2);
        const c2 = await applyToolCall('builder_add_notification', { title: 't', afterStepId: b2.added.id }, dw2);
        await applyToolCall('builder_remove_step', { stepId: b2.added.id, reconnect: false }, dw2);
        assert.ok(!dw2.def.edges.some(e => e.from === a2.added.id && e.to === c2.added.id), 'reconnect:false does not bridge');
    }

    // ── deleting a branching anchor returns a dropped-targets note ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x==1', afterStepId: a.added.id }, dw);
        await applyToolCall('builder_add_notification', { title: 't', afterStepId: cond.added.id }, dw);
        await applyToolCall('builder_add_notification', { title: 'e', afterStepId: cond.added.id }, dw);
        const rm = await applyToolCall('builder_remove_step', { stepId: cond.added.id }, dw);
        assert.ok(!rm.error, `remove must not error: ${rm.error}`);
        assert.ok(rm.note && /branching/.test(rm.note), 'branch-anchor delete returns a note about dropped branches');
        assert.ok(!dw.def.steps.some(s => s.id === cond.added.id), 'condition removed');
    }

    // ── batch update is all-or-nothing (snapshot + rollback) ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_ai_step', { prompt: 'x' }, dw);
        const b = await applyToolCall('builder_add_ai_step', { prompt: 'y', afterStepId: a.added.id }, dw);
        const r = await applyToolCall('builder_update_steps', {
            updates: [
                { stepId: a.added.id, patch: { prompt: 'A2' } },
                { stepId: b.added.id, patch: { inputs: { bad: { kind: 'ref', path: 'nope.x' } } } }, // invalid → whole batch fails
            ],
        }, dw);
        assert.ok(r.error && r._rolledBack, 'batch with one bad patch errors + rolls back');
        assert.strictEqual(dw.def.steps.find(s => s.id === a.added.id).prompt, 'x', 'first (valid) patch rolled back too');
    }

    // ── a patch that changes nothing says so ──
    // Answering a bare "updated" to a no-op is how a model gets stuck: one
    // build re-sent the identical patch fifteen times, read "updated" each
    // time, and spent its whole iteration budget going nowhere (2026-09-12).
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_ai_step', { prompt: 'same' }, dw);
        const b = await applyToolCall('builder_add_ai_step', { prompt: 'other', afterStepId: a.added.id }, dw);

        const noop = await applyToolCall('builder_update_steps', {
            updates: [{ stepId: a.added.id, patch: { prompt: 'same' } }],
        }, dw);
        assert.ok(!noop.error, 'a no-op patch is not an error');
        assert.deepStrictEqual(noop.updated, [], 'nothing is reported as updated');
        assert.deepStrictEqual(noop.unchanged, [a.added.id], 'the step is reported as unchanged');
        assert.match(noop._hint, /Nothing changed/i, 'and the reply says so in words');

        // A real change still reports normally, and a mixed batch splits.
        const real = await applyToolCall('builder_update_steps', {
            updates: [{ stepId: a.added.id, patch: { prompt: 'different now' } }],
        }, dw);
        assert.deepStrictEqual(real.updated, [a.added.id]);
        assert.ok(!real.unchanged, 'a batch that only changes things has no unchanged list');

        const mixed = await applyToolCall('builder_update_steps', {
            updates: [
                { stepId: a.added.id, patch: { prompt: 'different now' } },   // no-op
                { stepId: b.added.id, patch: { prompt: 'changed' } },          // real
            ],
        }, dw);
        assert.deepStrictEqual(mixed.updated, [b.added.id]);
        assert.deepStrictEqual(mixed.unchanged, [a.added.id]);
        assert.ok(!mixed._hint, 'the loud hint is only for a batch that changed nothing at all');
    }

    // ═══════════════════════════════════════════════════════════════════
    // §B — progressive context: builder_inspect_tool inputs + add-action gate
    // ═══════════════════════════════════════════════════════════════════

    function gatedWrap() {
        return {
            userId: 'u_test',
            def: emptyDefinition(),
            _inputSchemasByTool: {
                gmail_compose: { type: 'object', properties: { to: { type: 'string', description: 'recipient' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' } }, required: ['to', 'body'] },
                gmail_archive: { type: 'object', properties: { id: { type: 'string' } }, required: [] }, // 1 input, 0 required → trivial
            },
            _inspectedTools: new Set(),
        };
    }

    // ── inspect returns inputs + requiredInputs and records the tool ──
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const insp = await applyToolCall('builder_inspect_tool', { tool: 'gmail_compose' }, dw);
        assert.ok(insp.inputs && insp.inputs.to && insp.inputs.to.required === true, 'inspect returns inputs with required flags');
        assert.deepStrictEqual(insp.requiredInputs.sort(), ['body', 'to'], 'requiredInputs listed');
        assert.ok(dw._inspectedTools.has('gmail_compose'), 'inspected tool recorded for the gate');
        // unknown tool → null inputs, empty requiredInputs
        const unk = await applyToolCall('builder_inspect_tool', { tool: 'totally_unknown_tool' }, dw);
        assert.strictEqual(unk.inputs, null, 'unknown tool → inputs null');
        assert.deepStrictEqual(unk.requiredInputs, [], 'unknown tool → requiredInputs empty');
    }

    // ── gate: non-trivial add blocked without inspect; escape hatch + trivial exempt ──
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const blocked = await applyToolCall('builder_add_action', { tool: 'gmail_compose' }, dw);
        assert.ok(blocked.error && blocked._needsInspect === 'gmail_compose', 'non-trivial add blocked without inspect');
        assert.ok(!dw.def.steps.some(s => s.type === 'integration_action'), 'no step added when blocked');
        // escape hatch: all required params already bound → allowed without inspect
        const ok = await applyToolCall('builder_add_action', { tool: 'gmail_compose', inputs: { to: { kind: 'literal', value: 'a@b.c' }, body: { kind: 'literal', value: 'hi' } } }, dw);
        assert.ok(!ok.error, `escape hatch (required bound) must allow: ${ok.error}`);
        // trivial tool (1 input, 0 required) is exempt
        const triv = await applyToolCall('builder_add_action', { tool: 'gmail_archive', afterStepId: ok.added.id }, dw);
        assert.ok(!triv.error, `trivial tool must be exempt: ${triv.error}`);
    }

    // ── gate: after inspecting, the add goes through ──
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        await applyToolCall('builder_inspect_tool', { tool: 'gmail_compose' }, dw);
        const ok = await applyToolCall('builder_add_action', { tool: 'gmail_compose', inputs: { to: { kind: 'literal', value: 'a@b.c' }, body: { kind: 'literal', value: 'hi' } } }, dw);
        assert.ok(!ok.error, `add after inspect must succeed: ${ok.error}`);
    }

    // ── gate is a no-op when no catalog map is attached (tests / older callers) ──
    {
        const dw = freshWrap(); // no _inputSchemasByTool
        const ok = await applyToolCall('builder_add_action', { tool: 'gmail_compose' }, dw);
        assert.ok(!ok.error, 'no catalog attached → gate exempt');
    }

    // ── registration sanity: new tools wired into the mutation/scope sets ──
    {
        for (const n of ['builder_update_step', 'builder_update_steps', 'builder_replace_step']) {
            assert.ok(MUTATING_TOOLS.has(n), `${n} in MUTATING_TOOLS`);
            assert.ok(SCOPED_GRAPH_TOOLS.has(n), `${n} in SCOPED_GRAPH_TOOLS`);
        }
        const us = TOOL_SCHEMAS.find(t => t.function.name === 'builder_update_step');
        assert.ok(us && us.function.parameters.properties.scope, 'scope param injected into builder_update_step');
    }

    // ── builder_add_http_request: creates a valid step + is a registered tool ──
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_add_http_request', {
            url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=K',
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: '{"text":"hi"}',
        }, dw);
        assert.ok(!r.error, `http_request should apply cleanly: ${r.error || ''}`);
        assert.strictEqual(r.added.type, 'http_request');
        assert.strictEqual(r.added.method, 'POST', 'method uppercased');
        assert.strictEqual(r.added.blockPrivateTargets, true, 'blockPrivateTargets defaults true');
        assert.strictEqual(r.added.timeoutMs, 10000, 'timeout defaults to 10000');
        // The whole definition validates.
        const v = validateDefinition(dw.def);
        assert.ok(v.ok, `definition with an http_request step must validate: ${JSON.stringify(v.errors)}`);
        // Registered as a mutating + scoped (flowlet-capable) tool with a schema.
        assert.ok(MUTATING_TOOLS.has('builder_add_http_request'), 'builder_add_http_request in MUTATING_TOOLS');
        assert.ok(SCOPED_GRAPH_TOOLS.has('builder_add_http_request'), 'builder_add_http_request in SCOPED_GRAPH_TOOLS');
        const hs = TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_http_request');
        assert.ok(hs, 'builder_add_http_request has a TOOL_SCHEMA');
        assert.ok(hs.function.parameters.properties.url, 'schema exposes url');
        assert.ok(hs.function.parameters.properties.blockPrivateTargets, 'schema exposes the security toggle');
        assert.ok(hs.function.parameters.properties.forEach, 'forEach param injected (http_request is forEach-capable)');
    }

    // ── url is required ──
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_add_http_request', { method: 'GET' }, dw);
        assert.ok(r.error && /url is required/i.test(r.error), 'missing url is rejected');
    }

    // ── an http_request step can receive an on_error branch (it's failure-capable) ──
    {
        const dw = freshWrap();
        const h = await applyToolCall('builder_add_http_request', { url: 'https://api.example.com' }, dw);
        const n = await applyToolCall('builder_add_notification', { title: 'it failed', afterStepId: h.added.id, branch: 'error' }, dw);
        assert.ok(!n.error, `http_request must allow an on_error branch: ${n.error || ''}`);
        const errEdge = dw.def.edges.find(e => e.from === h.added.id && e.to === n.added.id);
        assert.ok(errEdge && errEdge.label === 'on_error', 'the fallback edge is labelled on_error');
    }

    // ── builder_propose_trigger kind=app_trigger writes sanitized params ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', {
            kind: 'app_trigger',
            params: [
                { name: 'title', type: 'string', required: true, description: 'the title' },
                { name: 'doc', type: 'file' },
                { name: 'loose', type: 'not-a-type', required: 'truthy', description: 42 },
                { notAName: true },
                null,
            ],
        }, dw);
        assert.strictEqual(dw.def.trigger.kind, 'app_trigger');
        assert.deepStrictEqual(dw.def.trigger.params, [
            { name: 'title', type: 'string', required: true, description: 'the title' },
            { name: 'doc', type: 'file', required: false },
            { name: 'loose', type: 'string', required: true, description: '42' },
        ], 'params sanitized: unknown type → string, truthy required coerced, junk entries dropped');
    }
    {
        // Without params: an empty declaration, not undefined.
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'app_trigger' }, dw);
        assert.deepStrictEqual(dw.def.trigger.params, [], 'app_trigger without params seeds []');
    }

    // ── builder_add_data_extraction: creates a valid step + is a registered tool ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const read = await applyToolCall('builder_add_http_request', { url: 'https://example.com/invoice.txt' }, dw);
        const r = await applyToolCall('builder_add_data_extraction', {
            afterStepId: read.added.id,
            source: { kind: 'ref', path: `steps.${read.added.id}.output.body` },
            fields: [
                { name: 'datum', type: 'date', description: 'Invoice date', required: true },
                { name: 'totaal', type: 'number', description: 'Total including VAT' },
                { name: 'leverancier' },                       // type omitted → string
            ],
            instructions: '  Amounts are in euros.  ',
        }, dw);
        assert.ok(!r.error, `data_extraction should apply cleanly: ${r.error || ''}`);
        assert.strictEqual(r.added.type, 'data_extraction');
        assert.strictEqual(r.added.label, 'Extract data', 'the default label is the lockstep literal nodeDefs.serverLabels.test.js compares');
        assert.deepStrictEqual(r.added.source, { kind: 'ref', path: `steps.${read.added.id}.output.body` });
        assert.deepStrictEqual(r.added.fields, [
            { name: 'datum', type: 'date', description: 'Invoice date', required: true },
            { name: 'totaal', type: 'number', description: 'Total including VAT', required: false },
            { name: 'leverancier', type: 'string', description: '', required: false },
        ], 'fields are canonicalised: order kept, type defaults to string, required is an explicit boolean');
        assert.strictEqual(r.added.instructions, 'Amounts are in euros.', 'instructions trimmed');
        assert.ok(!('modelTier' in r.added) && !('outputSchema' in r.added), 'no tier and no outputSchema — the fields are the shape, the admin picks the model');
        // The whole definition validates.
        const v = validateDefinition(dw.def);
        assert.ok(v.ok, `definition with a data_extraction step must validate: ${JSON.stringify(v.errors)}`);
        // Registered as a mutating + scoped + forEach-capable tool with a schema.
        assert.ok(MUTATING_TOOLS.has('builder_add_data_extraction'), 'builder_add_data_extraction in MUTATING_TOOLS');
        assert.ok(SCOPED_GRAPH_TOOLS.has('builder_add_data_extraction'), 'builder_add_data_extraction in SCOPED_GRAPH_TOOLS');
        const ds = TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_data_extraction');
        assert.ok(ds, 'builder_add_data_extraction has a TOOL_SCHEMA');
        assert.ok(ds.function.parameters.properties.source && ds.function.parameters.properties.fields, 'schema exposes source + fields');
        assert.ok(ds.function.parameters.properties.forEach, 'forEach param injected (data_extraction is forEach-capable)');
        assert.match(ds.function.description, /admin/i, 'the description says the admin picks the model');
        assert.match(ds.function.description, /outputSchema/, 'the description says no outputSchema is needed');
        assert.match(ds.function.description, /ai_step/, 'the description positions it against an ai_step');
    }

    // ── data_extraction: the sanitizer refuses what the validator would refuse ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const base = { source: { kind: 'ref', path: 'trigger.output.text' } };
        const noSource = await applyToolCall('builder_add_data_extraction', { fields: [{ name: 'a', type: 'string' }] }, dw);
        assert.ok(noSource.error && /source is required/i.test(noSource.error), 'missing source is rejected');
        const literal = await applyToolCall('builder_add_data_extraction', { source: { kind: 'literal', value: 'hello' }, fields: [{ name: 'a', type: 'string' }] }, dw);
        assert.ok(literal.error && /literal/i.test(literal.error), 'a literal source is rejected');
        const badRoot = await applyToolCall('builder_add_data_extraction', { source: { kind: 'ref', path: 'nonsense.text' }, fields: [{ name: 'a', type: 'string' }] }, dw);
        assert.ok(badRoot.error && /unknown root/i.test(badRoot.error), 'a bad ref root is rejected');
        const noFields = await applyToolCall('builder_add_data_extraction', { ...base }, dw);
        assert.ok(noFields.error && /fields is required/i.test(noFields.error), 'missing fields is rejected');
        const badName = await applyToolCall('builder_add_data_extraction', { ...base, fields: [{ name: 'Invoice Date', type: 'string' }] }, dw);
        assert.ok(badName.error && /not a valid field name/i.test(badName.error), 'an illegal name is rejected');
        const dup = await applyToolCall('builder_add_data_extraction', { ...base, fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }] }, dw);
        assert.ok(dup.error && /twice/i.test(dup.error), 'a duplicate name is rejected');
        const badType = await applyToolCall('builder_add_data_extraction', { ...base, fields: [{ name: 'a', type: 'integer' }] }, dw);
        assert.ok(badType.error && /unknown type/i.test(badType.error), 'an unknown type is rejected');
        const many = await applyToolCall('builder_add_data_extraction', { ...base, fields: Array.from({ length: 31 }, (_, i) => ({ name: `f${i}`, type: 'string' })) }, dw);
        assert.ok(many.error && /max 30/i.test(many.error), 'more than 30 fields is rejected');
        assert.ok(!dw.def.steps.some(s => s.type === 'data_extraction'), 'no step added by any rejected call');
        // A bare ref-looking string is upgraded to a ref rather than frozen as text.
        const bare = await applyToolCall('builder_add_data_extraction', { source: 'trigger.output.text', fields: [{ name: 'a', type: 'string' }] }, dw);
        assert.ok(!bare.error, `bare ref string must be upgraded: ${bare.error || ''}`);
        assert.deepStrictEqual(bare.added.source, { kind: 'ref', path: 'trigger.output.text' });
    }

    // ── data_extraction: the integration_action `inputs` wrapper is unwrapped ──
    // {inputs:{source, fields}} on the direct tool, and {inputs:{source}} on a
    // builder_update_step patch, both land as top-level fields with a note —
    // never "source is required" / "inputs not patchable".
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_data_extraction', {
            inputs: { source: { kind: 'ref', path: 'trigger.output.text' }, fields: [{ name: 'a', type: 'string' }], instructions: 'Euros.' },
        }, dw);
        assert.ok(!r.error, `inputs wrapper is unwrapped: ${r.error || ''}`);
        assert.deepStrictEqual(r.added.source, { kind: 'ref', path: 'trigger.output.text' });
        assert.strictEqual(r.added.fields[0].name, 'a');
        assert.strictEqual(r.added.instructions, 'Euros.');
        assert.ok(!('inputs' in r.added), 'inputs never reaches the step');
        assert.ok(r._warnings.some(w => /sent under inputs/.test(w)), JSON.stringify(r._warnings));
        // Top-level wins over the wrapped copy.
        const both = await applyToolCall('builder_add_data_extraction', {
            source: { kind: 'ref', path: 'trigger.output.text' },
            inputs: { source: { kind: 'ref', path: 'trigger.output.other' }, fields: [{ name: 'b', type: 'string' }] },
        }, dw);
        assert.ok(!both.error, both.error);
        assert.strictEqual(both.added.source.path, 'trigger.output.text');
        // `text` is read as source when no source is given at all.
        const alias = await applyToolCall('builder_add_data_extraction', { text: 'trigger.output.text', fields: [{ name: 'c', type: 'string' }] }, dw);
        assert.ok(!alias.error, alias.error);
        assert.deepStrictEqual(alias.added.source, { kind: 'ref', path: 'trigger.output.text' });
        // A patch in the same vocabulary is translated, not refused.
        const up = await applyToolCall('builder_update_step', { stepId: r.added.id, patch: { inputs: { source: { kind: 'ref', path: 'trigger.output.body' } }, prompt: 'Dates first.' } }, dw);
        assert.ok(!up.error, `patch with inputs wrapper: ${up.error || ''}`);
        assert.deepStrictEqual(up.updated.source, { kind: 'ref', path: 'trigger.output.body' });
        assert.strictEqual(up.updated.instructions, 'Dates first.');
        assert.ok(!('inputs' in up.updated) && !('prompt' in up.updated));
        assert.ok(Array.isArray(up._warnings) && up._warnings.length === 2, JSON.stringify(up._warnings));
    }

    // ── integration_action: a tool name that is not in `tool` is found, not refused ──
    // The 2026-09-12 trace: a nextcloud_read_file entry arrived without a
    // `tool` string, was refused with a message that named no candidate, and
    // the model dropped the read step altogether.
    {
        const mk = () => {
            const dw = freshWrap();
            dw._availableToolNames = new Set(['nextcloud_list_files', 'nextcloud_read_file', 'nextcloud_tables_create_row', 'gmail_search']);
            return dw;
        };
        const cases = [
            [{ toolName: 'nextcloud_read_file' }, 'toolName'],
            [{ name: 'nextcloud_read_file' }, 'name'],
            [{ action: 'nextcloud_read_file' }, 'action'],
            [{ tool: { name: 'nextcloud_read_file' } }, 'tool.name'],
            [{ inputs: { tool: 'nextcloud_read_file', path: { kind: 'literal', value: '/a.pdf' } } }, 'inputs.tool'],
            [{ app: 'nextcloud', action: 'read_file' }, 'read as'],
            [{ app: 'nextcloud', op: 'read file' }, 'read as'],
            [{ tool: 'read_file' }, 'read as'],
            [{ tool: 'Nextcloud: Read file' }, 'read as'],
            [{ tool: 'nextcloud.read_file' }, 'read as'],
        ];
        for (const [extra, from] of cases) {
            const dw = mk();
            await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
            const r = await applyToolCall('builder_add_action', { ...extra, inputs: { path: { kind: 'literal', value: '/a.pdf' }, ...(extra.inputs || {}) }, label: 'Lees PDF' }, dw);
            assert.ok(!r.error, `${JSON.stringify(extra)}: ${r.error || ''}`);
            assert.strictEqual(r.added.tool, 'nextcloud_read_file', JSON.stringify(extra));
            assert.ok(!('tool' in r.added.inputs), 'the name never lands in inputs');
            assert.ok(r._warnings && r._warnings.some(w => w.includes(from)), `${JSON.stringify(extra)} → note names the source: ${JSON.stringify(r._warnings)}`);
        }
        // Ambiguous token match is NOT guessed; nothing at all names the tool.
        const dw = mk();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        dw._availableToolNames.add('google_drive_read_file');
        const amb = await applyToolCall('builder_add_action', { tool: 'read_file', inputs: {} }, dw);
        assert.ok(amb.error && /no tool called "read_file"/.test(amb.error), amb.error);
        const none = await applyToolCall('builder_add_action', { inputs: { path: { kind: 'literal', value: '/a' } }, label: 'Lees PDF' }, dw);
        assert.ok(none.error && /needs a `tool` name/.test(none.error) && /"Lees PDF"/.test(none.error) && /Tools you can use here: .*nextcloud_read_file/.test(none.error), none.error);
        assert.match(none._fixHint, /^Reject reason: the step names no tool/);

        // Only the key the name was READ from leaves the inputs; a literal
        // `name` next to a top-level `toolName` is a value, not the tool.
        // Measured: name:"Q3" was deleted, the step was refused for the very
        // key it had removed, and the resend loop ended in _stop.
        const keep = mk();
        keep._inputSchemasByTool = { nextcloud_create_folder: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' } }, required: ['path', 'name'] } };
        keep._inspectedTools = new Set(['nextcloud_create_folder']);
        keep._availableToolNames.add('nextcloud_create_folder');
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, keep);
        const named = await applyToolCall('builder_add_action', { toolName: 'nextcloud_create_folder', inputs: { path: { kind: 'literal', value: '/Reports' }, name: 'Q3' } }, keep);
        assert.ok(!named.error, named.error);
        assert.strictEqual(named.added.tool, 'nextcloud_create_folder');
        assert.deepStrictEqual(named.added.inputs.name, { kind: 'literal', value: 'Q3' }, 'the literal name stays');
        assert.ok(named._warnings.some(w => /read from "toolName"/.test(w)), JSON.stringify(named._warnings));
        assert.ok(!named._warnings.some(w => /removed from the inputs/.test(w)), 'nothing was removed, so nothing says so');
        // …and when it DID come out of the inputs, the removal is said.
        const fromInputs = await applyToolCall('builder_add_action', { inputs: { tool: 'nextcloud_create_folder', path: { kind: 'literal', value: '/Reports' }, name: 'Q4' } }, keep);
        assert.ok(!fromInputs.error, fromInputs.error);
        assert.ok(!('tool' in fromInputs.added.inputs));
        assert.deepStrictEqual(fromInputs.added.inputs.name, { kind: 'literal', value: 'Q4' });
        assert.ok(fromInputs._warnings.some(w => w === 'inputs.tool was removed from the inputs — it carried the tool name, not a value for nextcloud_create_folder.'), JSON.stringify(fromInputs._warnings));

        // No catalog at all (the MCP surface): free text out of the inputs
        // map is never promoted to a tool name. Measured: {inputs:{name:
        // "Weekly report"}} minted an integration_action whose tool was
        // that literal string.
        const bare = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, bare);
        const mcp = await applyToolCall('builder_add_action', { inputs: { name: 'Weekly report', path: '/x' } }, bare);
        assert.ok(mcp.error && /needs a `tool` name/.test(mcp.error), mcp.error);
        assert.strictEqual(bare.def.steps.length, 0);
        const freeText = await applyToolCall('builder_add_action', { tool: 'Weekly report', inputs: { path: '/x' } }, bare);
        assert.ok(freeText.error && /"Weekly report" is not a tool name/.test(freeText.error), freeText.error);
        assert.match(freeText._fixHint, /^Reject reason: the tool name is free text/);
        // A real name out of `toolName` still passes without a catalog (the
        // permissive posture the header defends), MCP casing included.
        const okMcp = await applyToolCall('builder_add_action', { toolName: 'mcp_github_createIssue', inputs: { title: 'x' } }, bare);
        assert.ok(!okMcp.error, okMcp.error);
        assert.strictEqual(okMcp.added.tool, 'mcp_github_createIssue');
    }

    // ── loop.<var> must be bound by the step's own forEach ──
    // The finalised automation of 2026-09-12: create_row bound every column to
    // loop.e.output.<field> with no forEach, and both builder and validator
    // let it through.
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const noFe = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { q: { kind: 'ref', path: 'loop.e.output.subject' } } }, dw);
        assert.ok(noFe.error && /has no forEach/.test(noFe.error) && /itemVar:"e"/.test(noFe.error), noFe.error);
        const wrongVar = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { q: { kind: 'ref', path: 'loop.e.output.subject' } }, forEach: { overRef: 'trigger.output.items', itemVar: 'f' } }, dw);
        assert.ok(wrongVar.error && /iterates as loop\.f/.test(wrongVar.error), wrongVar.error);
        const ok = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { q: { kind: 'template', value: 'x {{loop.f.output.subject}}' } }, forEach: { overRef: 'trigger.output.items', itemVar: 'f' } }, dw);
        assert.ok(!ok.error, ok.error);
        const ai = await applyToolCall('builder_add_ai_step', { prompt: 'p', inputs: { t: { kind: 'ref', path: 'loop.x.output.body' } } }, dw);
        assert.ok(ai.error && /has no forEach/.test(ai.error), ai.error);
        const ex = await applyToolCall('builder_add_data_extraction', { source: { kind: 'ref', path: 'loop.r.output.content' }, fields: [{ name: 'a', type: 'string' }] }, dw);
        assert.ok(ex.error && /^source read "loop\.r\.output\.content"/.test(ex.error), ex.error);
        // `loop._index` is the runner's own key beside the item: bound by any
        // forEach. It was refused with the advice to rename itemVar to
        // "_index", which would have unbound the item.
        const { unboundLoopVarError } = require('./builderTools/bindings');
        assert.strictEqual(unboundLoopVarError({ x: { kind: 'ref', path: 'loop._index' } }, { overRef: 'steps.a.output.results', itemVar: 'e' }), null);
        const numbered = await applyToolCall('builder_add_notification', { title: 'Row', body: 'Row {{loop._index}}: {{loop.f.output.subject}}', forEach: { overRef: 'trigger.output.items', itemVar: 'f' } }, dw);
        assert.ok(!numbered.error, numbered.error);
        const bareIndex = unboundLoopVarError({ x: { kind: 'ref', path: 'loop._index' } }, null);
        assert.ok(bareIndex && /has no forEach/.test(bareIndex.error) && /itemVar:"item"/.test(bareIndex.error), bareIndex && bareIndex.error);
    }

    // ── data_extraction: a file's location is not its text ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_data_extraction', {
            source: { kind: 'ref', path: 'loop.f.path' }, fields: [{ name: 'a', type: 'string' }],
            forEach: { overRef: 'trigger.output.items', itemVar: 'f' },
        }, dw);
        assert.ok(r.error && /LOCATION, not its text/.test(r.error) && /loop\.f\.output\.content/.test(r.error), r.error);
        assert.match(r._fixHint, /file path instead of file text/);
        const ok = await applyToolCall('builder_add_data_extraction', {
            source: { kind: 'ref', path: 'loop.f.output.content' }, fields: [{ name: 'a', type: 'string' }],
            forEach: { overRef: 'trigger.output.items', itemVar: 'f' },
        }, dw);
        assert.ok(!ok.error, ok.error);
    }

    // ── data_extraction: ai_step vocabulary (prompt/outputSchema) is translated, not refused ──
    // The trace: the model switched an ai_step's type to data_extraction and
    // kept prompt + outputSchema; "fields is required" sent it round again.
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_data_extraction', {
            source: { kind: 'ref', path: 'trigger.output.text' },
            prompt: 'Extract the following from this invoice text:\n- Factuurdatum (YYYY-MM-DD)\n- Totaal  \n\nText: {{trigger.output.text}}',
            outputSchema: { date: { type: 'string', description: 'Invoice date' }, amount_total: { type: 'integer' }, vendor: { type: 'string' } },
        }, dw);
        assert.ok(!r.error, `outputSchema/prompt are translated: ${r.error || ''}`);
        assert.deepStrictEqual(r.added.fields, [
            { name: 'date', type: 'string', description: 'Invoice date', required: false },
            { name: 'amount_total', type: 'number', description: '', required: false },
            { name: 'vendor', type: 'string', description: '', required: false },
        ], 'schema properties become fields in order; integer → number');
        assert.strictEqual(r.added.instructions, 'Extract the following from this invoice text:\n- Factuurdatum (YYYY-MM-DD)\n- Totaal\n\nText:', 'prompt kept as the hint, {{…}} placeholders removed');
        assert.ok(!('prompt' in r.added) && !('outputSchema' in r.added), 'the ai_step keys never reach the step');
        assert.ok(Array.isArray(r._warnings) && r._warnings.length === 2, `two vocabulary notes: ${JSON.stringify(r._warnings)}`);
        assert.match(r._warnings[0], /outputSchema is ai_step vocabulary — converted to fields/);
        assert.match(r._warnings[1], /prompt is ai_step vocabulary/);
        // JSON-schema form with a required list; explicit fields/instructions win.
        const r2 = await applyToolCall('builder_add_data_extraction', {
            source: { kind: 'ref', path: 'trigger.output.text' },
            outputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'boolean' } }, required: ['b'] },
            instructions: 'Keep this.',
            prompt: 'Drop this.',
        }, dw);
        assert.ok(!r2.error, r2.error);
        assert.deepStrictEqual(r2.added.fields.map(f => [f.name, f.type, f.required]), [['a', 'number', false], ['b', 'boolean', true]]);
        assert.strictEqual(r2.added.instructions, 'Keep this.', 'an explicit instructions hint is never overwritten by prompt');
        const r3 = await applyToolCall('builder_add_data_extraction', {
            source: { kind: 'ref', path: 'trigger.output.text' },
            fields: [{ name: 'keep', type: 'string' }],
            outputSchema: { drop: { type: 'string' } },
        }, dw);
        assert.ok(!r3.error, r3.error);
        assert.deepStrictEqual(r3.added.fields.map(f => f.name), ['keep'], 'explicit fields win over outputSchema');
        assert.ok(!r3._warnings, 'nothing translated → no note');
        // The whole definition still validates.
        const v = validateDefinition(dw.def);
        assert.ok(v.ok, `translated steps validate: ${JSON.stringify(v.errors)}`);
    }

    // ── data_extraction: patchable in place, fields replaced wholesale, forEach honoured ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const read = await applyToolCall('builder_add_http_request', { url: 'https://example.com/list' }, dw);
        const ex = await applyToolCall('builder_add_data_extraction', {
            source: { kind: 'ref', path: 'loop.f.output.body' },
            fields: [{ name: 'a', type: 'string' }],
            forEach: { overRef: `steps.${read.added.id}.output.results`, itemVar: 'f' },
        }, dw);
        assert.ok(!ex.error, `forEach add must succeed: ${ex.error || ''}`);
        assert.deepStrictEqual(ex.added.forEach, { overRef: `steps.${read.added.id}.output.results`, itemVar: 'f' });
        const up = await applyToolCall('builder_update_step', {
            stepId: ex.added.id,
            patch: { fields: [{ name: 'b', type: 'number' }, { name: 'c', type: 'date', required: true }], instructions: 'In euros.', label: 'Read invoice' },
        }, dw);
        assert.ok(!up.error, `patch must succeed: ${up.error || ''}`);
        assert.deepStrictEqual(up.updated.fields.map(f => f.name), ['b', 'c'], 'fields are REPLACED, not merged');
        assert.strictEqual(up.updated.fields[1].required, true);
        assert.strictEqual(up.updated.instructions, 'In euros.');
        assert.strictEqual(up.updated.label, 'Read invoice');
        assert.strictEqual(up.updated.id, ex.added.id, 'same id — downstream refs survive');
        const badPatch = await applyToolCall('builder_update_step', { stepId: ex.added.id, patch: { fields: [{ name: 'Bad', type: 'string' }] } }, dw);
        assert.ok(badPatch.error && /not a valid field name/i.test(badPatch.error), 'a patch goes through the same sanitizer');
        const notPatchable = await applyToolCall('builder_update_step', { stepId: ex.added.id, patch: { modelTier: 'thinking' } }, dw);
        assert.ok(notPatchable.error && /not patchable/i.test(notPatchable.error), 'there is no tier to patch on this step');
        const srcPatch = await applyToolCall('builder_update_step', { stepId: ex.added.id, patch: { source: { kind: 'ref', path: 'loop.f.output.content' } } }, dw);
        assert.ok(!srcPatch.error, `source patch must succeed: ${srcPatch.error || ''}`);
        assert.deepStrictEqual(srcPatch.updated.source, { kind: 'ref', path: 'loop.f.output.content' });
        const cleared = await applyToolCall('builder_update_step', { stepId: ex.added.id, patch: { instructions: '' } }, dw);
        assert.ok(!cleared.error && !('instructions' in cleared.updated), 'blank instructions clear the field');
        // The definition still validates after the patches.
        const v = validateDefinition(dw.def);
        assert.ok(v.ok, `patched data_extraction must validate: ${JSON.stringify(v.errors)}`);
    }

    // ── data_extraction in a batch, and as a replace target ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const batch = await applyToolCall('builder_add_steps', {
            steps: [
                { tempId: 'read', type: 'http_request', spec: { url: 'https://example.com/a' } },
                { tempId: 'ex', type: 'data_extraction', spec: { source: { kind: 'ref', path: 'steps.$read.output.body' }, fields: [{ name: 'totaal', type: 'number' }] } },
            ],
        }, dw);
        assert.ok(!batch.error, `batch with data_extraction must succeed: ${batch.error || ''}`);
        const exStep = dw.def.steps.find(s => s.type === 'data_extraction');
        assert.ok(exStep, 'the batched step exists');
        assert.strictEqual(exStep.source.path, `steps.${batch.idMap.read}.output.body`, '$tempId inside source is rewritten');
        const ai = await applyToolCall('builder_add_ai_step', { prompt: 'Extract the total as JSON.', afterStepId: exStep.id }, dw);
        const rep = await applyToolCall('builder_replace_step', {
            stepId: ai.added.id, newType: 'data_extraction',
            spec: { source: { kind: 'ref', path: `steps.${exStep.id}.output.totaal` }, fields: [{ name: 'x', type: 'string' }] },
        }, dw);
        assert.ok(!rep.error, `replace into data_extraction must succeed: ${rep.error || ''}`);
        assert.strictEqual(rep.replaced.id, ai.added.id, 'id kept across the type swap');
        assert.strictEqual(rep.replaced.type, 'data_extraction');
    }

    // ── A3: an extraction that reads a LISTING entry's text is refused with the read step spelled out ──
    // Measured attempt 1 (2026-09-12), verbatim: no source, the prompt bound
    // {{loop.f.content}} six times, and the forEach ran over the listing —
    // whose entries have a path and never text.
    {
        const FIELDS = [
            { name: 'datum', type: 'string', description: 'Factuurdatum in YYYY-MM-DD formaat' },
            { name: 'leverancier', type: 'string', description: 'Naam van de leverancier' },
            { name: 'factuurnummer', type: 'string', description: 'Het factuurnummer' },
            { name: 'excl_btw', type: 'number', description: 'Bedrag exclusief btw (bijv. 1554.25)' },
            { name: 'btw', type: 'number', description: 'Het btw bedrag (bijv. 310.85)' },
            { name: 'totaal', type: 'number', description: 'Het totaalbedrag (bijv. 1865.10)' },
        ];
        const attempt1 = () => ({ steps: [
            { tempId: 'list_files', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices-Test' } }, label: 'Scan map /Invoices-Test' } },
            { tempId: 'extract_data', type: 'data_extraction', spec: {
                fields: FIELDS,
                forEach: { itemVar: 'f', overRef: 'steps.$list_files.output.items' },
                prompt: 'Extraheer de factuurgegevens uit dit document.\nDatum: {{loop.f.content}}\nLeverancier: {{loop.f.content}}\nFactuurnummer: {{loop.f.content}}\nBedrag Excl. BTW: {{loop.f.content}}\nBTW: {{loop.f.content}}\nTotaal: {{loop.f.content}}\n\nLet op: \n- Datum MOET in YYYY-MM-DD formaat zijn.',
            } },
        ] });
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', attempt1(), dw);
        // Prefix-apply: the list step (entry 0) stays built; only entry 1 is refused.
        assert.ok(r.error && r.failedIndex === 1, r.error);
        assert.strictEqual(r.added.length, 1, 'entry 0 stays built');
        assert.strictEqual(r.added[0].tool, 'nextcloud_list_files');
        assert.match(r.error, /source reads "loop\.f\.content", but the forEach item is an entry of steps\.a_[0-9a-f]+\.output\.items \(nextcloud_list_files\), which has no "content" — a listing carries name, path, type, size, contentType, modified, fileId, never a file's text\./);
        assert.match(r.error, /Read the file first: an integration_action with tool:"nextcloud_read_file", inputs:\{path:\{kind:"ref", path:"loop\.f\.path"\}\} and forEach:\{overRef:"steps\.a_[0-9a-f]+\.output\.items", itemVar:"f"\}/);
        assert.match(r.error, /source:\{kind:"ref", path:"loop\.r\.output\.content"\}/);
        assert.match(r._fixHint, /^Reject reason: the extraction reads a field the loop item does not have/);
        assert.strictEqual(dw.def.steps.length, 1, 'the built prefix stays; only the refused entry is absent');
        // Without Nextcloud reads available the read step is described, not named.
        const dw2 = freshWrap();
        dw2._availableToolNames = new Set(['nextcloud_list_files']);
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw2);
        const r2 = await applyToolCall('builder_add_steps', attempt1(), dw2);
        assert.ok(r2.error && /an action that reads the file's text/.test(r2.error) && !/nextcloud_read_file/.test(r2.error), r2.error);
    }

    // ── A3: the correct chain — source derived from the prompt, checked against the fan-out entry ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const r = await applyToolCall('builder_add_steps', { steps: [
            { tempId: 'list', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices' } } } },
            { tempId: 'read', type: 'integration_action', spec: { tool: 'nextcloud_read_file', inputs: { path: { kind: 'ref', path: 'loop.f.path' } }, forEach: { overRef: 'steps.$list.output.items', itemVar: 'f' } } },
            { tempId: 'ex', type: 'data_extraction', spec: { fields: [{ name: 'totaal', type: 'number' }], forEach: { overRef: 'steps.$read.output.results', itemVar: 'r' }, prompt: 'Extract these: {{loop.r.output.content}}' } },
        ] }, dw);
        assert.ok(!r.error, `no source, one placeholder → derived: ${r.error || ''}`);
        const ex = dw.def.steps.find(s => s.type === 'data_extraction');
        assert.deepStrictEqual(ex.source, { kind: 'ref', path: 'loop.r.output.content' });
        assert.strictEqual(ex.instructions, 'Extract these:');
        assert.ok(r._warnings.some(w => /^steps\[2\] \(\$ex\): source was not set — derived from the one placeholder \{\{loop\.r\.output\.content\}\} in the prompt \(the prompt is not where the text is bound\)\. Set source:\{kind:"ref", path:"loop\.r\.output\.content"\} explicitly next time\.$/.test(w)), JSON.stringify(r._warnings));
        const readRef = { overRef: `steps.${r.idMap.read}.output.results`, itemVar: 'r' };
        // Two different placeholders are a real ambiguity — refused with the choice.
        const two = await applyToolCall('builder_add_data_extraction', { fields: [{ name: 'a', type: 'string' }], forEach: readRef, prompt: 'Name: {{loop.r.item.name}}\nText: {{ loop.r.output.content }}\nAgain: {{$loop.r.output.content}}' }, dw);
        assert.match(two.error, /^source is required, and the prompt names 2 different values \(\{\{loop\.r\.item\.name\}\}, \{\{loop\.r\.output\.content\}\}\) — which one is the text to read\? Set source to ONE binding, e\.g\. source:\{kind:"ref", path:"loop\.r\.item\.name"\}, at the top level of the step \(a data_extraction has no inputs map\)\.$/);
        assert.match(two._fixHint, /^Reject reason: no source and several candidates/);
        // An explicit source without the fan-out envelope is repaired with a note…
        const rep = await applyToolCall('builder_add_data_extraction', { source: { kind: 'ref', path: 'loop.r.content' }, fields: [{ name: 'a', type: 'string' }], forEach: readRef }, dw);
        assert.ok(!rep.error, rep.error);
        assert.deepStrictEqual(rep.added.source, { kind: 'ref', path: 'loop.r.output.content' });
        assert.ok(rep._warnings.some(w => /^source "loop\.r\.content" read as "loop\.r\.output\.content" — an entry of steps\.a_[0-9a-f]+\.output\.results is \{index, item, output, status\}; the step's result sits under output\.$/.test(w)), JSON.stringify(rep._warnings));
        // …a field the entry has nowhere is refused naming where the text is.
        const foo = await applyToolCall('builder_add_data_extraction', { source: { kind: 'ref', path: 'loop.r.foo' }, fields: [{ name: 'a', type: 'string' }], forEach: readRef }, dw);
        assert.match(foo.error, /^source reads "loop\.r\.foo", but an entry of steps\.a_[0-9a-f]+\.output\.results \(nextcloud_read_file\) is \{index, item, output, status\} and output has: path, size, contentType, extractedVia, truncated, content, meta — the text is loop\.r\.output\.content\.$/);
        assert.match(foo._fixHint, /^Reject reason: the extraction reads a field the loop item does not have\./);
        // No prompt and no source: the plain refusal, with its own hint.
        const none = await applyToolCall('builder_add_data_extraction', { fields: [{ name: 'a', type: 'string' }] }, dw);
        assert.match(none.error, /^source is required/);
        assert.match(none._fixHint, /^Reject reason: no source\. Add source:\{kind:"ref", path:"…"\} at the top level of this step and resend it — the fields were fine\.$/);
        // An explicit source wins over the prompt's placeholder — no derive note.
        const explicit = await applyToolCall('builder_add_data_extraction', { source: { kind: 'ref', path: 'loop.r.output.content' }, fields: [{ name: 'a', type: 'string' }], forEach: readRef, prompt: 'Read {{loop.r.item.name}}' }, dw);
        assert.ok(!explicit.error, explicit.error);
        assert.strictEqual(explicit.added.source.path, 'loop.r.output.content');
        assert.ok(!explicit._warnings.some(w => /derived from/.test(w)), JSON.stringify(explicit._warnings));
        // A patch of `source` runs the same check.
        const up = await applyToolCall('builder_update_step', { stepId: rep.added.id, patch: { source: { kind: 'ref', path: 'loop.r.content' } } }, dw);
        assert.ok(!up.error, up.error);
        assert.deepStrictEqual(up.updated.source, { kind: 'ref', path: 'loop.r.output.content' });
        assert.ok(up._warnings.some(w => /^source "loop\.r\.content" read as "loop\.r\.output\.content"/.test(w)), JSON.stringify(up._warnings));
        const upBad = await applyToolCall('builder_update_step', { stepId: rep.added.id, patch: { source: { kind: 'ref', path: 'loop.r.foo' } } }, dw);
        assert.match(upBad.error, /the text is loop\.r\.output\.content\.$/);
        assert.match(upBad._fixHint, /^Reject reason: the extraction reads a field the loop item does not have/);
        // A patch that moves the forEach onto the listing in the same call is
        // checked against THAT item.
        const upList = await applyToolCall('builder_update_step', { stepId: rep.added.id, patch: { source: { kind: 'ref', path: 'loop.f.content' }, forEach: { overRef: `steps.${r.idMap.list}.output.items`, itemVar: 'f' } } }, dw);
        assert.match(upList.error, /which has no "content" — a listing carries name, path/);
        assert.deepStrictEqual(dw.def.steps.find(s => s.id === rep.added.id).source, { kind: 'ref', path: 'loop.r.output.content' }, 'a refused patch changes nothing');
        const v = validateDefinition(dw.def);
        assert.ok(v.ok, `the chain validates: ${JSON.stringify(v.errors)}`);
    }

    console.log('builderTools.test.js: all branch-wiring tests passed');
    // builderTools requires automationStore, which opens a DB pool that keeps
    // the event loop alive — exit explicitly once assertions pass.
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });


// ── §MAP — a map input whose MEMBERS are bindings ──
// `nextcloud_tables_create_row` takes `values: {"<column>": <binding>}`. That
// map used to be frozen whole as one literal, so the row reached Nextcloud
// with {"kind":"ref","path":"…"} in every cell, and a ref path inside it was
// never validated (2026-09-12).
{
    const { validateAndFixBindings } = require('./builderTools/bindings');
    const draft = { trigger: { kind: 'manual' }, steps: [] };

    // A map of bindings stays a bare object, each member canonical.
    const map = validateAndFixBindings({
        tableId: { kind: 'literal', value: 4 },
        values: {
            Datum: { kind: 'ref', path: 'loop.e.output.datum' },
            Leverancier: { path: 'loop.e.output.leverancier' },   // kind-less shape
            Bron: 'handmatig',                                     // bare literal
        },
    }, draft);
    assert.strictEqual(map.error, null, `map of bindings must validate: ${map.error}`);
    assert.strictEqual(map.inputs.values.kind, undefined, 'the map itself is NOT wrapped as a literal');
    assert.deepStrictEqual(map.inputs.values.Datum, { kind: 'ref', path: 'loop.e.output.datum' });
    assert.deepStrictEqual(map.inputs.values.Leverancier, { kind: 'ref', path: 'loop.e.output.leverancier' });
    assert.deepStrictEqual(map.inputs.values.Bron, { kind: 'literal', value: 'handmatig' });

    // A bad ref INSIDE the map is rejected, naming the member.
    const bad = validateAndFixBindings({ values: { Totaal: { kind: 'ref', path: 'nonsense.output.totaal' } } }, draft);
    assert.ok(bad.error, 'a nested bad root must fail the call');
    assert.match(bad.error, /values\.Totaal/, 'the message names the member, not just "inputs"');
    assert.match(bad.error, /unknown root/i);

    // A map of plain data is still one literal — unchanged behaviour.
    const plain = validateAndFixBindings({ headers: { Accept: 'application/json', Retries: 3 } }, draft);
    assert.strictEqual(plain.error, null);
    assert.strictEqual(plain.inputs.headers.kind, 'literal', 'no bindings inside → one literal');
    assert.deepStrictEqual(plain.inputs.headers.value, { Accept: 'application/json', Retries: 3 });

    // A LIST of bindings resolves per element too.
    const list = validateAndFixBindings({
        recipients: [{ kind: 'ref', path: 'trigger.output.from' }, 'tom@beeflow.nl'],
    }, draft);
    assert.ok(Array.isArray(list.inputs.recipients), 'the list stays a list');
    assert.deepStrictEqual(list.inputs.recipients[0], { kind: 'ref', path: 'trigger.output.from' });
    assert.deepStrictEqual(list.inputs.recipients[1], { kind: 'literal', value: 'tom@beeflow.nl' });
}
