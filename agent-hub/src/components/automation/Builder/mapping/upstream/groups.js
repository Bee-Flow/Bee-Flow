/**
 * Pure upstream-variable discovery for the automation builder.
 *
 * Walk an automation definition backward from `currentStepId` and compile
 * a list of "upstream" data sources the user can bind to. This is the
 * single source of truth shared by:
 *   - useUpstreamVariables (the VariableTree / picker in the inspector)
 *   - autoMapInputs (automatic input mapping on connect)
 *
 * Keeping it framework-free means the auto-mapper sees EXACTLY the same
 * candidate paths the user sees in the tree.
 *
 * Output shape: an array of variable groups, one per upstream node.
 *   [
 *     { id: 'trg_abc', label: 'Trigger (manual)', kind: 'trigger',
 *       basePath: 'trigger.output', sample: {...}, fields: [{key, path, sample, children}] },
 *     { id: 's_xxx',   label: 'Gmail search',     kind: 'integration_action',
 *       basePath: 'steps.s_xxx.output', sample: {...}, fields: [...] },
 *     { id: 'loop_y',  label: 'Loop (item)',      kind: 'loop',
 *       basePath: 'loop.item', sample: {...}, fields: [...] },
 *   ]
 *
 * Inputs:
 *   definition    — the full draft (trigger + steps + edges)
 *   currentStepId — the step we're editing (excluded; downstream would be a forward-ref)
 *   catalog       — { apps: [...], triggerOutputs: {...} } from getCatalog()
 *   realOutputById — optional Map<stepId, output> of real run/pinned outputs
 *                    (mapping/realOutputs.js buildRealOutputMap). When given,
 *                    each group's sample AND fields carry the real data, and
 *                    the accumulated sampleRoot resolves refs against it — so
 *                    a Filter added below a step with 10 real records sees
 *                    those records, in auto-map and in every picker alike.
 *
 * Returns [] when definition / currentStepId is missing.
 */
import { collectUpstream } from './graphWalk';
import { describeNode } from './describeNode';
import { overlayGroupWithReal } from './realOverlay';
import { triggerMetaSample, describeTriggerMeta } from './triggers';
import { describeForEachItem, runsPerItem } from './loops';
import { resolveElementSample, sampleToFields } from './sampleFields';

export function computeUpstreamGroups(definition, currentStepId, catalog, realOutputById = null) {
    if (!definition || !currentStepId) return [];
    const upstream = collectUpstream(definition, currentStepId);
    if (upstream.length === 0) return [];
    const toolToOutput = buildToolOutputMap(catalog);
    const triggerOutputs = catalog?.triggerOutputs || {};
    // Accumulated sample root, built up in topological order so each describer
    // can resolve refs into what EARLIER nodes produce (e.g. a Filter's
    // arrayRef into the source step's element shape). With realOutputById the
    // slots hold real data, so those refs resolve to real elements.
    // Beside `output`, a run's `trigger` slot carries which trigger fired
    // (kind / source / id / provider / event / firedAt / schedule — see
    // core/automationRunner/triggerState.js). Seeded from the primary trigger
    // so a ref like `trigger.kind` resolves in auto-map and the pickers.
    const sampleRoot = { trigger: { output: {}, ...triggerMetaSample(definition) }, steps: {} };
    let triggerHasRealData = false;
    const groups = [];
    for (const node of upstream) {
        let g = describeNode(node, definition, toolToOutput, triggerOutputs, sampleRoot, catalog);
        // A step that "runs once per item" (step.forEach, or step.repeat)
        // doesn't return its flat tool output — the runner wraps it as
        //   { iterations, succeeded, failed, results: [{ index, item, output, status }] }
        // (see execRepeat.js). Re-shape the group so downstream binding,
        // the loop picker and auto-map use the runtime-correct
        // `…output.results[*].output.<field>` paths instead of the flat ones.
        if (g && !node.__isTrigger && runsPerItem(node)) {
            g = wrapGroupForEach(g, node);
        }
        if (!g) continue;
        // Overlay what the node ACTUALLY produced (pinned > run) — after the
        // forEach reshape, so a real forEach envelope lands on the wrapped
        // group rather than on the flat tool shape.
        const real = realOutputById?.get(node.id);
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
    // One "Trigger info" group for the whole graph: the meta keys are the same
    // whichever trigger fired, so they are listed once, after the trigger
    // groups, rather than once per trigger node.
    if (upstream.some(n => n.__isTrigger)) {
        const meta = describeTriggerMeta(definition, catalog);
        if (meta) groups.push(meta);
    }
    // When the CURRENT step iterates (`step.forEach`), surface its per-item
    // loop variable (`loop.<itemVar>.*`) so the inspector's variable picker
    // can bind element fields. Appended last so it reads as the nearest
    // context. (Auto-map runs before forEach is set, so this never skews the
    // scalar auto-map pass.)
    const cur = (definition.steps || []).find(s => s.id === currentStepId);
    if (cur && cur.forEach && cur.forEach.overRef) {
        const itemGroup = describeForEachItem(cur, definition, toolToOutput, sampleRoot);
        if (itemGroup) groups.push(itemGroup);
    }
    return groups.filter(g => !isOwnContainer(g.id, currentStepId));
}

/**
 * File a described node's sample under the path its own bindings use, so later
 * describers in the walk can resolve refs THROUGH it.
 *
 * Almost everything is `steps.<id>.output`. The exception is the "Each item"
 * pill of an expanded loop: it is not a step and has no output slot — it IS
 * `loop.<itemVar>`, and filing it there is what lets a body step resolve an
 * element shape out of `loop.item.<something>`.
 */
function recordSample(sampleRoot, node, group) {
    if (node.type === 'loop_item') {
        sampleRoot.loop = { ...(sampleRoot.loop || {}), [node.itemVar || 'item']: group.sample ?? {} };
        return;
    }
    sampleRoot.steps[node.id] = { output: group.sample || {} };
}

/**
 * True when `groupId` is a container the current step is INSIDE.
 *
 * On an expanded canvas a container's contents carry its id as a prefix
 * (`lp1/a` — flow/inlineFlowlets.js), and a loop's container node feeds its own
 * entry so body steps can see the flow before the loop. That edge also drags
 * the LOOP's own group into the walk — and `steps.lp1.output.results` does not
 * exist while its body is still running. Offering it would be a path that
 * always resolves to nothing, the exact trap describeLoop's own comment
 * describes from the other side.
 */
function isOwnContainer(groupId, currentStepId) {
    return typeof groupId === 'string'
        && typeof currentStepId === 'string'
        && currentStepId.startsWith(`${groupId}/`);
}

/**
 * Map from tool name to its output sample (and shape) using the catalog
 * the client already fetched. Avoids walking the catalog tree on every
 * tree render.
 */
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
 * Re-shape an upstream group whose node iterates (`step.forEach` or
 * `step.repeat`). The
 * runtime output is the aggregated `{ iterations, succeeded, failed, results }`
 * envelope, so:
 *   - EVERY per-iteration field becomes a flattened iterable at
 *     `…output.results[*].output.<key>` (the `[*]` flatten is resolved by
 *     server/automation/bind.js walkPath), and
 *   - the run counters (iterations/succeeded/failed) are surfaced.
 *
 * Scalars used to be dropped here, on the grounds that their sample is a
 * scalar while the path resolves to an array, so auto-mapping one into a
 * scalar tool param would be wrong. The reasoning was sound; the remedy was
 * too blunt. It left a field like `output.count` with NO path at all, and the
 * author looking at a picker that offered nothing of what the step itself had
 * returned — the complaint in BFSF-369.
 *
 * So they are surfaced, and the mismatch is fixed at its source instead: the
 * sample is wrapped to `[value]`, which is what the path ACTUALLY yields —
 * one entry per iteration. That truthful shape earns the existing
 * listShape.js "column" badge for free, and `perIteration` keeps auto-map and
 * the loop-source guess off them (see autoMapInputs.js), which is what the old
 * exclusion was really protecting. Hand-picking, which was never the risk,
 * now works.
 */
function wrapGroupForEach(group, node) {
    if (!group || !runsPerItem(node)) return group;
    const base = group.basePath; // steps.<id>.output
    const flat = group.sample || {};
    const flattened = (group.fields || [])
        .filter(f => f && f.key)
        .map(f => (Array.isArray(f.sample)
            ? { key: f.key, path: `${base}.results[*].output.${f.key}`, sample: f.sample }
            : { key: f.key, path: `${base}.results[*].output.${f.key}`, sample: [f.sample], perIteration: true }));
    const counters = [
        { key: 'iterations', path: `${base}.iterations`, sample: 0 },
        { key: 'succeeded', path: `${base}.succeeded`, sample: 0 },
        { key: 'failed', path: `${base}.failed`, sample: 0 },
    ];
    return {
        ...group,
        forEach: true,
        sample: { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: flat, status: 'success' }] },
        fields: [...counters, ...flattened],
    };
}

/**
 * Upstream groups visible to ONE step inside a Loop's body (the inspector's
 * step-list editor — see LoopBodyEditor.jsx). Body steps aren't real DAG
 * nodes (execLoop runs them via a synthetic per-iteration sub-DAG, never
 * recorded individually), so this mirrors computeUpstreamGroups' topological
 * accumulation but scoped to what's ACTUALLY bound at runtime for body step
 * `bodyIndex`:
 *   - everything visible OUTSIDE the loop (outerGroups, unchanged)
 *   - a synthetic "current item" group for `loop.<itemVar>` — an
 *     array-of-elements sample when batchSize>1, exactly matching what
 *     execLoop binds (a slice, not a single element)
 *   - the real output shape of every EARLIER body step (0..bodyIndex-1),
 *     via the same describeNode() dispatch computeUpstreamGroups uses, so
 *     an integration_action/set/etc. body step offers typed field
 *     suggestions just like a normal upstream step would
 *
 * `previewSample` is the NDV's merged sample root (already resolves
 * loopStep.overRef against real-run/pinned data when available).
 */
export function computeLoopBodyGroups(loopStep, bodyIndex, outerGroups, previewSample, catalog, definition) {
    const itemVar = loopStep.itemVar || 'item';
    const batchSize = Math.max(1, Number(loopStep.batchSize) || 1);
    const elementSample = resolveElementSample(loopStep.overRef, previewSample) || {};
    const isPlainObject = elementSample && typeof elementSample === 'object' && !Array.isArray(elementSample);
    const itemGroup = {
        id: '__loop_item',
        label: batchSize > 1 ? `Current batch (loop.${itemVar})` : `Current item (loop.${itemVar})`,
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample: batchSize > 1 ? [elementSample] : elementSample,
        // A batch is an ARRAY of items — no single-item field list to offer
        // (mirrors the array-sample branch of sampleToFields elsewhere).
        fields: (batchSize > 1 || !isPlainObject) ? [] : sampleToFields(elementSample, `loop.${itemVar}`),
    };
    const toolToOutput = buildToolOutputMap(catalog);
    const priorGroups = (loopStep.body || [])
        .slice(0, bodyIndex)
        .map((s) => describeNode(s, definition, toolToOutput, {}))
        .filter(Boolean);
    return [...(outerGroups || []), itemGroup, ...priorGroups];
}
