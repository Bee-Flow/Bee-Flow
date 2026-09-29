/**
 * Step contract helpers.
 *
 * A "Step" (UI name) is a kind='block' automation row whose definition is a
 * root-level Flowlet: a `layer_input` trigger (params) + a `layer_output` step
 * (fields). These pure helpers read that contract and the set of integrations
 * the Step touches, so the catalog/palette can show inputs/outputs and hide a
 * Step when the caller lacks one of its integrations.
 *
 * A CUSTOM NODE is this same contract plus a code body and a declared
 * capability manifest — that lives next door in customNode.js, which reads
 * the two helpers below and is read back by requiredIntegrations().
 *
 * Intentionally dependency-light: only the tool→integration resolver and the
 * sibling customNode module are required lazily, so this is safe to require
 * from stores and routes.
 */

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Walk a graph's steps, descending into loop bodies and parallel branches —
// the same nesting validate.js/portability.js walk. Flat for everything else.
function walkSteps(steps, fn) {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
        if (!isObject(s)) continue;
        fn(s);
        if (s.type === 'loop') walkSteps(s.body, fn);
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            for (const branch of s.branches) walkSteps(branch, fn);
        }
    }
}

// Coarse fallback when the static tool→integration map can't resolve a tool.
function coarseIntegration(tool) {
    if (!tool) return null;
    if (tool.startsWith('nextcloud')) return 'nextcloud';
    if (tool.startsWith('gmail')) return 'gmail';
    if (tool.startsWith('drive')) return 'google-drive';
    if (tool.startsWith('gcal') || tool.startsWith('calendar')) return 'google-calendar';
    if (tool.startsWith('webpage')) return 'webpages';
    return String(tool).split('_')[0] || null;
}

/** The declared input params of a Step (root layer_input trigger). */
function stepParams(definition) {
    const params = definition?.trigger?.params;
    if (!Array.isArray(params)) return [];
    return params
        .filter(isObject)
        .map(p => ({ name: p.name, type: p.type || 'string', required: !!p.required, description: p.description || '' }))
        .filter(p => p.name);
}

/** The output field names a Step returns (its single layer_output step). */
function stepOutputFields(definition) {
    const out = (definition?.steps || []).find(s => s && s.type === 'layer_output');
    const fields = out && isObject(out.fields) ? out.fields : {};
    return Object.keys(fields);
}

/** Both halves of the contract in one call. */
function stepContract(definition) {
    return { params: stepParams(definition), outputFields: stepOutputFields(definition) };
}

/**
 * The set of integration ids a Step touches (every integration_action tool,
 * the tools a `code` body may reach, plus any app_event trigger provider —
 * Steps normally have none). Walks the root graph and any nested layers.
 * Returns a sorted unique array.
 *
 * This answer is an availability gate: the builder palette hides a Step whose
 * integrations the caller does not have, because a call_block that reaches
 * one they lack fails mid-run. So it has to cover every way a Step reaches
 * out, and a `code` step reaches out through `ctx.integrations.<tool>(...)` —
 * a tool name inside a string, which no walk of the graph can see. What it
 * MAY reach is a declared list either way (see below), and both are read
 * here: a Step that returns [] because nobody looked is offered to everyone,
 * and the first sign of trouble is `tool "gmail_send" not allowed for this
 * step` from inside an isolate, halfway through a live run.
 */
function requiredIntegrations(definition) {
    if (!isObject(definition)) return [];
    let resolveIntegration = null;
    try { ({ resolveIntegration } = require('../core/integrations/integrationToolMap')); } catch { /* optional */ }
    const ids = new Set();
    const addTool = (tool) => {
        if (typeof tool !== 'string' || !tool) return;
        const resolved = resolveIntegration ? resolveIntegration(tool) : null;
        const id = resolved?.integration || coarseIntegration(tool);
        // An unresolvable name still contributes its coarse id rather than
        // nothing: an id the caller cannot have hides the Step, and hiding a
        // Step nobody can run beats offering one nobody can.
        if (id) ids.add(id);
    };
    const provider = definition?.trigger?.appEvent?.provider;
    if (provider) ids.add(provider);
    const collect = (graph) => {
        walkSteps(graph?.steps, (s) => {
            if (s.type === 'integration_action' && s.tool) addTool(s.tool);
            // The list codeSandbox enforces for this body (bridges.allowedTools
            // is built from it). Read even when the node also declares a
            // capability manifest: a Step saved before the manifest existed
            // has only this, and the gate must not be looser than the sandbox.
            if (s.type === 'code' && Array.isArray(s.allowedTools)) {
                for (const t of s.allowedTools) addTool(t);
            }
        });
    };
    collect(definition);
    if (isObject(definition.layers)) {
        for (const layer of Object.values(definition.layers)) collect(layer);
    }
    // The custom-node capability manifest — the DECLARED half of the same
    // answer, and the half a reviewer and the palette can read without
    // parsing anyone's JavaScript. Required here rather than at the top
    // because customNode requires this module back; by the time anyone calls
    // this, both are loaded and the cycle costs nothing. customNode keeps its
    // own require of codeSandbox lazy, so this does not drag isolated-vm into
    // stores and routes.
    const { capabilityToolNames } = require('./customNode');
    for (const tool of capabilityToolNames(definition)) addTool(tool);
    return [...ids].sort();
}

module.exports = { walkSteps, stepParams, stepOutputFields, stepContract, requiredIntegrations };
