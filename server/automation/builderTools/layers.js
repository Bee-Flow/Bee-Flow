/**
 * Builder tools — inline flowlets (layers): key slugging, the skeleton the
 * flowlet sub-agent shares, the contract tool and call_layer wiring with its
 * recursion guard. Required from within automation/builderTools/ and the
 * ../builderTools facade.
 */

const { collectCallLayerSteps } = require('../validate');
const { newId, lastStepId, appendAfter } = require('./draftGraph');
const { validateAndFixBindings } = require('./bindings');

// ── Inline-flowlet helpers ──────────────────────────────


/** slug a title into a valid flowlet key; uniquify against existing keys. */
function generateLayerKey(title, layers) {
    let slug = String(title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
        .replace(/^_+|_+$/g, '');
    if (!slug) slug = 'layer';
    else if (/^[0-9]/.test(slug)) slug = `layer_${slug}`;
    let key = slug;
    let n = 2;
    while (layers && Object.prototype.hasOwnProperty.call(layers, key)) key = `${slug}_${n++}`;
    return key;
}

function sanitizeLayerParams(params) {
    if (!Array.isArray(params)) return [];
    return params
        .filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
        .map(p => ({
            name: p.name.trim(),
            type: typeof p.type === 'string' && p.type ? p.type : 'string',
            ...(p.required ? { required: true } : {}),
        }));
}

/**
 * Every flowlet key transitively reachable from `startKey` via call_layer
 * steps (including startKey itself). Used to reject recursive wiring:
 * adding a call to T from inside flowlet S is illegal when closure(T) ∋ S.
 */
function layerClosureKeys(layers, startKey) {
    const seen = new Set();
    const stack = [startKey];
    while (stack.length) {
        const k = stack.pop();
        if (seen.has(k)) continue;
        seen.add(k);
        const g = layers?.[k];
        if (!g) continue;
        for (const { step } of collectCallLayerSteps(g)) {
            if (typeof step.layerKey === 'string' && !seen.has(step.layerKey)) stack.push(step.layerKey);
        }
    }
    return seen;
}

/**
 * The empty skeleton for a new inline flowlet: a layer_input trigger wired
 * straight to a layer_output "Return". Extracted so the flowlet sub-agent
 * (flowletAgent.js) seeds isolated drafts with the EXACT same shape this
 * tool produces — no drift between the two creation paths.
 */
function makeLayerSkeleton(title, params) {
    return {
        title: (typeof title === 'string' && title.trim()) ? title.trim() : 'New layer',
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: sanitizeLayerParams(params) },
        steps: [{ id: 'out', type: 'layer_output', fields: {}, label: 'Return' }],
        edges: [{ from: 'trg', to: 'out' }],
    };
}

function applyCreateLayer(draft, args) {
    const title = (typeof args.title === 'string' && args.title.trim()) ? args.title.trim() : 'New layer';
    if (!draft.layers || typeof draft.layers !== 'object' || Array.isArray(draft.layers)) draft.layers = {};
    const layerKey = generateLayerKey(title, draft.layers);
    draft.layers[layerKey] = makeLayerSkeleton(title, args.params);
    // Inline flowlets are the schemaVersion 2 marker.
    draft.schemaVersion = 2;
    return { layerKey, layer: draft.layers[layerKey] };
}

function applySetLayerContract(draft, args) {
    const layerKey = typeof args.layerKey === 'string' ? args.layerKey : null;
    const layer = layerKey ? draft.layers?.[layerKey] : null;
    if (!layer) {
        return { error: `Unknown layerKey "${layerKey || ''}". Existing flowlets: ${Object.keys(draft.layers || {}).join(', ') || '(none — create one with builder_create_layer)'}.` };
    }
    const contractNotes = [];
    if (args.params !== undefined) {
        if (!Array.isArray(args.params)) return { error: 'params must be an array of { name, type, required? }.' };
        layer.trigger = layer.trigger || { id: 'trg', type: 'trigger', kind: 'layer_input' };
        layer.trigger.params = sanitizeLayerParams(args.params);
    }
    if (args.outputFields !== undefined) {
        if (!Array.isArray(args.outputFields) || args.outputFields.some(f => typeof f !== 'string' || !f.trim())) {
            return { error: 'outputFields must be an array of non-empty field-name strings.' };
        }
        layer.steps = Array.isArray(layer.steps) ? layer.steps : [];
        layer.edges = Array.isArray(layer.edges) ? layer.edges : [];
        let outStep = layer.steps.find(s => s && s.type === 'layer_output');
        if (!outStep) {
            outStep = { id: 'out', type: 'layer_output', fields: {}, label: 'Return' };
            const prevLast = lastStepId(layer);
            layer.steps.push(outStep);
            layer.edges.push({ from: prevLast, to: outStep.id });
        }
        const old = (outStep.fields && typeof outStep.fields === 'object' && !Array.isArray(outStep.fields)) ? outStep.fields : {};
        outStep.fields = {};
        for (const f of args.outputFields) {
            const name = f.trim();
            // Keep an existing binding for retained keys; new keys start as
            // empty literals the user (or AI, with scope) binds afterwards.
            outStep.fields[name] = old[name] || { kind: 'literal', value: '' };
        }
    }
    // Bind the flowlet's return values directly (declare + bind in ONE call):
    // `outputs` maps fieldName → binding ({kind:'ref',path:'steps.<id>.output.<f>'}).
    // This is THE way a flowlet returns data — never via a separate `set` step.
    if (args.outputs !== undefined) {
        if (!args.outputs || typeof args.outputs !== 'object' || Array.isArray(args.outputs)) {
            return { error: 'outputs must be a map of fieldName → binding, e.g. { invoices: { kind:"ref", path:"steps.agg1.output.values" } }.' };
        }
        layer.steps = Array.isArray(layer.steps) ? layer.steps : [];
        layer.edges = Array.isArray(layer.edges) ? layer.edges : [];
        let outStep = layer.steps.find(s => s && s.type === 'layer_output');
        if (!outStep) {
            outStep = { id: 'out', type: 'layer_output', fields: {}, label: 'Return' };
            const prevLast = lastStepId(layer);
            layer.steps.push(outStep);
            layer.edges.push({ from: prevLast, to: outStep.id });
        }
        const { inputs: bound, error, notes } = validateAndFixBindings(args.outputs, layer);
        if (error) return { error };
        if (notes) contractNotes.push(...notes.map(n => n.replace(/^inputs\./, 'outputs.')));
        outStep.fields = {
            ...(outStep.fields && typeof outStep.fields === 'object' && !Array.isArray(outStep.fields) ? outStep.fields : {}),
            ...bound,
        };
    }
    const outStep = (layer.steps || []).find(s => s && s.type === 'layer_output');
    return {
        layerKey,
        params: layer.trigger?.params || [],
        outputFields: Object.keys(outStep?.fields || {}),
        ...(contractNotes.length ? { _warnings: contractNotes } : {}),
    };
}

/**
 * Append a call_layer step. `graph` is where the step lands (the root, or
 * the flowlet selected via scope); `draft` is always the root document
 * (flowlets live there); `scope` is the calling flowlet key (null at root) —
 * needed for the recursion check.
 */
function applyAddCallLayer(draft, args, { graph = draft, scope = null } = {}) {
    if (!args.layerKey || typeof args.layerKey !== 'string') {
        if (args.layerId) return { error: 'call_layer now takes a layerKey (inline flowlets) — layerId is no longer supported. Create the flowlet with builder_create_layer and pass its layerKey.' };
        return { error: 'call_layer requires a layerKey.' };
    }
    const layers = draft.layers || {};
    const target = layers[args.layerKey];
    if (!target) {
        return { error: `Unknown layerKey "${args.layerKey}". Existing flowlets: ${Object.keys(layers).join(', ') || '(none — create one with builder_create_layer)'}.` };
    }
    // Recursion guard: from inside flowlet `scope`, the target's transitive
    // call closure must not reach back to `scope` (and a flowlet can never
    // call itself). Root-scope calls can't recurse by construction.
    if (scope && layerClosureKeys(layers, args.layerKey).has(scope)) {
        return { error: `Recursive flowlet call rejected: flowlet "${args.layerKey}" (transitively) calls "${scope}", which is the flowlet you are adding this step to.` };
    }
    const { inputs, error, notes } = validateAndFixBindings(args.inputs || {}, graph);
    if (error) return { error };
    const step = {
        id: newId('cl'),
        type: 'call_layer',
        layerKey: args.layerKey,
        inputs,
        label: args.label || target.title || 'Call layer',
    };
    appendAfter(graph, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(notes ? { _warnings: notes } : {}) };
}

module.exports = {
    generateLayerKey,
    sanitizeLayerParams,
    makeLayerSkeleton,
    applyCreateLayer,
    applySetLayerContract,
    applyAddCallLayer,
};
