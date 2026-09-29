/**
 * Heal steps that name a built-in step TYPE as if it were an integration tool.
 *
 * An AI builder that reaches for `builder_add_action({tool:'http_request'})`
 * produces `{type:'integration_action', tool:'http_request', inputs:{…}}`.
 * Nothing dispatches that: `http_request` is a step type, not a catalog tool
 * (see builtinStepTools.js). New ones can no longer be created — applyAddAction
 * refuses them — but definitions saved before that guard still carry them, and
 * telling their author to delete the step and rebuild it by hand is a repair we
 * can do ourselves: every value the real step needs is already there, one level
 * down in `inputs`.
 *
 * So this lifts the bindings back to the top level and rebuilds the step
 * through the SAME builder the add tool uses, which is the point — a repaired
 * step and a correctly-built one are the same object, and neither can drift
 * from the runtime's field names without the other following.
 *
 * DELIBERATELY NARROW. Only types listed in REPAIRABLE are touched, and only
 * when every binding has a faithful top-level form. Anything else is left
 * exactly as it is, so the runner's honest "this step was built incorrectly"
 * error still fires rather than a silent guess that runs and does the wrong
 * thing. Widening the map means verifying that type's config shape first.
 */

const { ALIASES, isBuiltinStepType } = require('./builtinStepTools');
const { AI_STEP_AGENT_PERMISSION_KEYS } = require('./validate/constants');

/**
 * type → the builder that creates it, and the `inputs` keys worth lifting.
 * Keys absent from a step's inputs are simply not passed, so the builder's own
 * defaults apply — the same ones a freshly added step would get.
 */
const REPAIRABLE = {
    http_request: {
        build: (draft, args) => require('./builderTools/stepBuilders').applyAddHttpRequest(draft, args),
        fields: [
            'url', 'method', 'headers', 'body', 'timeoutMs', 'blockPrivateTargets',
            'parseResponse', 'askOnce', 'cacheInto', 'authConnectionId',
        ],
    },
};

/** Generic step fields that belong to the step, not to its type. */
const CARRY_OVER = ['label', 'icon', 'note', 'disabled', 'retry', 'forEach'];

/**
 * A binding (automation/bind.js) as a plain top-level value.
 *
 * Literals keep their JS type, so an object of headers stays an object and a
 * timeout stays a number. Refs become the `{{path}}` template the runtime's
 * interpolateTemplate understands. An `expr` binding has NO template form —
 * interpolateTemplate resolves paths only — so it fails, and the whole step is
 * left alone rather than silently losing its expression.
 *
 * @returns {{ok: true, value: *} | {ok: false}}
 */
function liftBinding(binding) {
    // Bare values are already literals — bind.js tolerates them, so do we.
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding) || !binding.kind) {
        return { ok: true, value: binding };
    }
    switch (binding.kind) {
        case 'literal':
            return { ok: true, value: binding.value };
        case 'template':
            return { ok: true, value: String(binding.value ?? '') };
        case 'ref':
            return (typeof binding.path === 'string' && binding.path)
                ? { ok: true, value: `{{${binding.path}}}` }
                : { ok: false };
        default:
            return { ok: false };
    }
}

/**
 * @param {object} step
 * @returns {object|null} the repaired step, or null when it needs no repair or
 *   cannot be repaired faithfully.
 */
/**
 * Drop an `agentPermissions` block that names no agent and grants nothing.
 *
 * The builder used to write the block on EVERY ai_step, so every AI-built
 * routine carries `{startAutomations:false, useKnowledge:false, useTools:false}`
 * on steps that have no agent — and validate/stepRules flags each one as
 * `ai_step.agent_permissions_orphan` ("sets agent permissions but names no
 * agent, so nothing reads them"). The user cannot clear it: they never set it.
 *
 * Absence means all three false (validate/constants R2), so removing an
 * all-false block changes nothing about how the step runs — it only stops the
 * step claiming a configuration it does not have. A block with a permission
 * actually granted is LEFT ALONE even without an agent: that one is somebody's
 * intent, and quietly deleting intent is not a repair.
 *
 * @returns {object|null} the repaired step, or null when nothing to do.
 */
function repairAiStepPermissions(step) {
    if (!step || step.type !== 'ai_step') return null;
    const perms = step.agentPermissions;
    if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return null;
    if (typeof step.agentId === 'string' && step.agentId.trim()) return null;
    if (AI_STEP_AGENT_PERMISSION_KEYS.some(k => perms[k] === true)) return null;
    // Any other key present is the `agent_permissions_unknown` warning's
    // business, not ours — leave the block for that rule to report.
    if (Object.keys(perms).some(k => !AI_STEP_AGENT_PERMISSION_KEYS.includes(k))) return null;
    // Copy-and-delete rather than the rest-sibling idiom
    // (`const { agentPermissions: _dropped, ...rest } = step`): this repo's
    // eslint config waives no-unused-vars only for ARGUMENTS prefixed with `_`
    // (argsIgnorePattern, no varsIgnorePattern/ignoreRestSiblings), so the
    // discarded binding showed up as a lint warning on every run.
    const rest = { ...step };
    delete rest.agentPermissions;
    return rest;
}

function repairStep(step) {
    if (!step || typeof step !== 'object') return null;
    const aiFix = repairAiStepPermissions(step);
    if (aiFix) return aiFix;
    if (step.type !== 'integration_action') return null;
    if (!isBuiltinStepType(step.tool)) return null;

    const type = Object.prototype.hasOwnProperty.call(ALIASES, step.tool) ? ALIASES[step.tool] : step.tool;
    const spec = REPAIRABLE[type];
    if (!spec) return null;

    const inputs = (step.inputs && typeof step.inputs === 'object' && !Array.isArray(step.inputs)) ? step.inputs : {};
    const args = {};
    for (const field of spec.fields) {
        if (!Object.prototype.hasOwnProperty.call(inputs, field)) continue;
        const lifted = liftBinding(inputs[field]);
        if (!lifted.ok) return null;
        if (lifted.value !== undefined) args[field] = lifted.value;
    }

    // Build through the real builder on a throwaway draft — we keep only the
    // step it returns, never the graph. The draft needs a trigger stub because
    // appendAfter falls back to it for the anchor (draftGraph.lastStepId), and
    // the edge that produces is discarded with the draft. `forEach` is carried
    // over afterwards rather than passed in: its validator resolves step ids
    // against the draft, and this draft has none of them.
    const draft = { trigger: { id: '__repair_anchor__', type: 'manual' }, steps: [], edges: [] };
    let built;
    try {
        built = spec.build(draft, args);
    } catch {
        return null;
    }
    if (!built || built.error || !built.added) return null;

    const repaired = { ...built.added, id: step.id };
    for (const key of CARRY_OVER) {
        if (step[key] !== undefined) repaired[key] = step[key];
    }
    return repaired;
}

/**
 * Repair every mis-typed step in a definition, including inside flowlets.
 *
 * Returns the SAME object when nothing needed repair — callers on a hot read
 * path (rowToAutomation runs per row of every list query) depend on that, and
 * on the cheap `some()` scan that precedes any copying.
 *
 * @param {object} definition
 * @returns {object} the definition, repaired or untouched
 */
function repairBuiltinToolSteps(definition) {
    if (!definition || typeof definition !== 'object') return definition;

    const repairList = (steps) => {
        if (!Array.isArray(steps)) return steps;
        const worthScanning = steps.some(s => s
            && ((s.type === 'integration_action' && isBuiltinStepType(s.tool))
                || (s.type === 'ai_step' && s.agentPermissions)));
        if (!worthScanning) return steps;
        let changed = false;
        const next = steps.map((s) => {
            const fixed = repairStep(s);
            if (!fixed) return s;
            changed = true;
            return fixed;
        });
        return changed ? next : steps;
    };

    const steps = repairList(definition.steps);
    let layers = definition.layers;
    if (layers && typeof layers === 'object' && !Array.isArray(layers)) {
        let layersChanged = false;
        const nextLayers = {};
        for (const [key, layer] of Object.entries(layers)) {
            const nextSteps = repairList(layer?.steps);
            nextLayers[key] = nextSteps === layer?.steps ? layer : { ...layer, steps: nextSteps };
            if (nextLayers[key] !== layer) layersChanged = true;
        }
        if (layersChanged) layers = nextLayers;
    }

    if (steps === definition.steps && layers === definition.layers) return definition;
    return { ...definition, steps, ...(layers !== definition.layers ? { layers } : {}) };
}

module.exports = { repairBuiltinToolSteps, repairStep, repairAiStepPermissions, liftBinding, REPAIRABLE };
