// @typecheck
/**
 * builder_replace_step — change a step's type in place, keeping its id and
 * wiring. Moved verbatim out of stepEditing.js.
 */

const { listStepIds, findStepAnywhere, reconcileOutgoingEdges } = require('../draftGraph');
const { PARSE_JSON_RETIRED_MSG } = require('../stepBuilders/dataSteps');
// ADD_FOR_TYPE (stepBuilders index) and inspectGateError (inspection) sit in
// the server's largest import cycle: read through cycleDeps at call time.
const cycleDeps = require('./cycleDeps');
const { followReplacedRoute } = require('../routeFollowDraft');
const { isBuiltinStepType } = require('../../builtinStepTools');
const { resolvedStepType } = require('./typeChange');
const { findDanglingRefs } = require('./removeStep');

/**
 * builder_replace_step — change a step's TYPE in place, keeping its id and
 * surrounding wiring. Builds the new step on a throwaway graph (so every apply*
 * validation runs without touching real edges), grafts the old id, then
 * reconciles outgoing branch edges.
 */
function applyReplaceStep(graph, args, /** @type {{draft?: any, scope?: any}} */ { draft, scope = null } = {}, draftWrap) {
    const stepId = typeof args.stepId === 'string' ? args.stepId : null;
    if (!stepId) return { error: 'stepId is required.' };
    const newType = typeof args.newType === 'string' ? args.newType : null;
    if (newType === 'parse_json') return { error: PARSE_JSON_RETIRED_MSG };
    const builder = newType && Object.hasOwn(cycleDeps.ADD_FOR_TYPE, newType) && cycleDeps.ADD_FOR_TYPE[newType];
    if (!builder) return { error: `Cannot replace into type "${newType}". Allowed: ${Object.keys(cycleDeps.ADD_FOR_TYPE).join(', ')}.` };
    const spec = (args.spec && typeof args.spec === 'object' && !Array.isArray(args.spec)) ? args.spec : null;
    if (!spec) return { error: 'spec must be an object with the new step\'s fields (same shape as builder_add_<newType>).' };

    const found = findStepAnywhere(graph, stepId);
    if (!found) return { error: `Unknown stepId "${stepId}". Existing step ids: ${listStepIds(graph)}.` };
    if (found.kind === 'loop') {
        return { error: 'Cannot replace a loop-body step\'s type in place — patch it with builder_update_step, or remove + add it inside the loop body.' };
    }
    const oldStep = found.step;

    if (newType === 'integration_action' && isBuiltinStepType(spec.tool)
        && !(draftWrap && draftWrap._inputSchemasByTool && draftWrap._inputSchemasByTool[spec.tool])
        && !(draftWrap && draftWrap._availableToolNames && draftWrap._availableToolNames.has(spec.tool))) {
        return {
            error: `"${spec.tool}" is a step type, not a tool.`,
            _fixHint: 'Use newType:"<resolved type>" with the fields of builder_add_<type>.'.replace('<resolved type>', resolvedStepType(spec.tool)),
        };
    }
    if (newType === 'integration_action') {
        const gate = cycleDeps.inspectGateError(spec.tool, spec.inputs, draftWrap);
        if (gate) return gate;
    }

    // Throwaway graph: shares the real trigger (for ref validation) but its own
    // empty steps/edges arrays so appendAfter wiring is discarded.
    const scratch = { trigger: graph.trigger, steps: [], edges: [], layers: draft && draft.layers };
    const buildArgs = { ...spec };
    delete buildArgs.afterStepId; delete buildArgs.branch; delete buildArgs.caseName; delete buildArgs.scope;
    const res = newType === 'call_layer'
        ? builder(draft, buildArgs, { graph: scratch, scope })
        : builder(scratch, buildArgs, draftWrap);
    if (res.error) return res;
    const built = res.added;
    built.id = oldStep.id;                       // keep id → every edge still targets it

    found.container[found.index] = built;
    // A filter that became a list switch (or back) takes its readers along
    // (W3) — before the edges are reconciled, so its kept connection is on
    // the first output already.
    const followed = followReplacedRoute(graph, oldStep, built.id);
    const rewired = reconcileOutgoingEdges(graph, oldStep, built);
    // The builder's tolerant reads (an op alias, a title-keyed column) are
    // said on the add path; a replace that swallowed them would leave the
    // model believing its spelling was stored as sent.
    const warnings = [...(res._warnings || []), ...followed];
    if (oldStep.type !== built.type && !followed.length) {
        // (A filter/switch swap already re-pointed its readers: followed.)
        // The new type has another output shape (a datatable add_row answers
        // row, id, created, updated); whoever read the old fields now reads
        // nothing. Said here because the next validation round is too late.
        const readers = findDanglingRefs(graph, built.id);
        if (readers.length) warnings.push(`Steps ${readers.join(', ')} read this step's output; its shape changed${built.type === 'datatable' ? ' (a datatable add_row returns row, id, created, updated)' : ''}. Check their bindings.`);
    }
    const replaced = findStepAnywhere(graph, built.id).step;
    return { replaced, ...(rewired ? { rewired } : {}), ...(warnings.length ? { _warnings: warnings } : {}) };
}

module.exports = { applyReplaceStep };
