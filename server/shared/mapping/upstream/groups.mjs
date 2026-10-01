/**
 * Upstream discovery: walk an automation definition backward from
 * `currentStepId` and describe every node that can feed it, as variable
 * groups the user can bind to. The one source shared by the builder's
 * pickers, its auto-mapper and the phone's flow editor, so all of them see
 * exactly the same candidate paths.
 *
 *   [
 *     { id: 'trg_abc', label: 'Trigger (manual)', kind: 'trigger',
 *       basePath: 'trigger.output', sample: {...}, fields: [SourceNode] },
 *     { id: 's_xxx',   label: 'Gmail search',     kind: 'integration_action',
 *       basePath: 'steps.s_xxx.output', sample: {...}, fields: [...] },
 *   ]
 *
 * Inputs:
 *   definition     the full draft (trigger + steps + edges)
 *   currentStepId  the step being edited (excluded; downstream would be a forward ref)
 *   catalog        { apps, triggerOutputs, triggerMeta, datatables,
 *                  knowledgeBases, skillOutputs } from the catalog endpoint
 *                  (skillOutputs: the client's loaded skills, by id)
 *   realOutputById optional Map<stepId, output> of real run/pinned outputs.
 *                  When given, each group's sample AND fields carry the real
 *                  data, and the accumulated sampleRoot resolves refs against
 *                  it.
 *   env            the client's hooks (env.mjs)
 */
import { collectUpstream } from './graphWalk.mjs';
import { describeNodeIn, describeLoopBody } from './describeNode.mjs';
import { overlayGroupWithReal } from './realOverlay.mjs';
import { triggerMetaSample, describeTriggerMeta } from './triggers.mjs';
import { describeForEachItem, loopItemGroup, inferLoopItemSample, wrapGroupForEach, runsPerItem } from './loops.mjs';
import { resolveEnv } from './env.mjs';
import { resolveElementSample } from './sampleFields.mjs';

// Lives beside the other iteration shapes (a loop body's steps need it too);
// re-exported here, where callers have always imported it from.
export { wrapGroupForEach };

export function computeUpstreamGroups(definition, currentStepId, catalog, realOutputById = null, env = undefined) {
    if (!definition || !currentStepId) return [];
    const upstream = collectUpstream(definition, currentStepId);
    if (upstream.length === 0) return [];
    const e = resolveEnv(env);
    const toolToOutput = buildToolOutputMap(catalog);
    const triggerOutputs = catalog?.triggerOutputs || {};
    // Accumulated sample root, built up in topological order so each describer
    // can resolve refs into what EARLIER nodes produce (a Filter's arrayRef
    // into the source step's element shape). With realOutputById the slots
    // hold real data. Beside `output`, a run's `trigger` slot carries which
    // trigger fired (core/automationRunner/triggerState.js).
    const sampleRoot = { trigger: { output: {}, ...triggerMetaSample(definition, e) }, steps: {} };
    const ctx = { definition, toolToOutput, triggerOutputs, sampleRoot, catalog, env: e };
    let triggerHasRealData = false;
    const groups = [];
    for (const node of upstream) {
        let g = describeNodeIn(node, ctx);
        // A step that "runs once per item" (step.forEach, or step.repeat)
        // returns the runner's envelope, not its flat tool output; re-shape
        // the group so downstream binding uses the runtime-correct paths.
        if (g && !node.__isTrigger && runsPerItem(node)) {
            g = wrapGroupForEach(g, node);
        }
        if (!g) continue;
        // Overlay what the node ACTUALLY produced (pinned > run), after the
        // forEach reshape, so a real envelope lands on the wrapped group.
        const real = realOutputById?.get?.(node.id);
        if (real !== undefined) g = overlayGroupWithReal(g, real);
        if (node.__isTrigger) {
            // All triggers share the one runtime trigger.output slot. A fired
            // trigger's real data must not be clobbered by the placeholder
            // sample of a sibling trigger later in the walk.
            if (!triggerHasRealData) sampleRoot.trigger.output = g.sample || {};
            if (g.hasRealData) triggerHasRealData = true;
        } else {
            recordSample(sampleRoot, node, g);
        }
        groups.push(g);
    }
    // One "Trigger info" group for the whole graph, after the trigger groups.
    if (upstream.some(n => n.__isTrigger)) {
        const meta = describeTriggerMeta(definition, catalog, e);
        if (meta) groups.push(meta);
    }
    // When the CURRENT step iterates (`step.forEach`), surface its per-item
    // loop variable (`loop.<itemVar>.*`), appended last so it reads as the
    // nearest context.
    const cur = (definition.steps || []).find(s => s.id === currentStepId);
    if (cur && cur.forEach && cur.forEach.overRef) {
        const itemGroup = describeForEachItem(cur, definition, toolToOutput, sampleRoot, e);
        if (itemGroup) groups.push(itemGroup);
    }
    return groups.filter(g => !isOwnContainer(g.id, currentStepId));
}

/**
 * File a described node's sample under the path its own bindings use, so
 * later describers in the walk can resolve refs THROUGH it. The "Each item"
 * pill of an expanded loop is not a step: it IS `loop.<itemVar>`.
 */
function recordSample(sampleRoot, node, group) {
    if (node.type === 'loop_item') {
        sampleRoot.loop = { ...(sampleRoot.loop || {}), [node.itemVar || 'item']: group.sample ?? {} };
        return;
    }
    sampleRoot.steps[node.id] = { output: group.sample || {} };
}

/**
 * True when `groupId` is a container the current step is INSIDE. On an
 * expanded canvas a container's contents carry its id as a prefix
 * (`lp1/a`), and `steps.lp1.output.results` does not exist while its body is
 * still running.
 */
function isOwnContainer(groupId, currentStepId) {
    return typeof groupId === 'string'
        && typeof currentStepId === 'string'
        && currentStepId.startsWith(`${groupId}/`);
}

/** Map from tool name to its output sample (and schema), from the catalog. */
export function buildToolOutputMap(catalog) {
    const out = new Map();
    for (const app of (catalog?.apps || [])) {
        for (const action of (app.actions || [])) {
            if (!action?.name) continue;
            out.set(action.name, {
                sample: action.outputSample || null,
                schema: action.outputSchema || null,
            });
        }
    }
    return out;
}

/**
 * Upstream groups visible to ONE step inside a Loop's body (the inspector's
 * step-list editor). Body steps are not DAG nodes (execLoop runs them as a
 * per-iteration sub-DAG), so this is what is bound at run time for body step
 * `bodyIndex`:
 *   - everything visible OUTSIDE the loop (outerGroups, unchanged)
 *   - the current item (`loop.<itemVar>`; a slice when batchSize > 1)
 *   - every EARLIER body step, described against the same sample root a
 *     step on the expanded canvas gets: the preview sample, the loop item
 *     and the earlier body outputs, with the catalog.
 *
 * `previewSample` is the editor's merged sample root (it already resolves
 * the loop's overRef against real-run/pinned data when there is any).
 */
export function computeLoopBodyGroups(loopStep, bodyIndex, outerGroups, previewSample, catalog, definition, env = undefined) {
    const e = resolveEnv(env);
    const itemVar = loopStep.itemVar || 'item';
    const toolToOutput = buildToolOutputMap(catalog);
    const ctx = { definition, toolToOutput, triggerOutputs: catalog?.triggerOutputs || {}, sampleRoot: previewSample, catalog, env: e };
    const element = resolveElementSample(loopStep.overRef, previewSample)
        ?? inferLoopItemSample(loopStep.overRef, definition, toolToOutput, previewSample);
    const itemGroup = loopItemGroup('__loop_item', itemVar, loopStep.batchSize, element, e);
    const priorGroups = describeLoopBody(loopStep, ctx, bodyIndex);
    return [...(outerGroups || []), itemGroup, ...priorGroups];
}
