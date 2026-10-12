/**
 * Upstream-variable discovery: walk a definition backward from the step being
 * edited and describe every node that can feed it, as variable groups
 *
 *   { id, label, kind, basePath, sample, fields: [{ key, path, sample, children? }] }
 *
 * The single source of truth for the variable picker AND auto-map, so the two
 * see exactly the same candidate paths. With `realOutputById` the groups carry
 * real run/pinned data. Port of agent-hub `Builder/mapping/upstream/groups.js`;
 * pinned by upstream.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';
import { appendKey, getPath } from '@/shared/expr';

import { firstItemPreview } from '../deepFields';
import { isObj } from '../json';
import type { Catalog, FlowDefinition, FlowNode, ToolOutputMap, TriggerOutputEntry, VariableGroup } from '../types';
import { describeNode } from './describeNode';
import { forEachOutputPath, perIterationField, rebaseFields } from './forEachShape';
import { collectUpstream } from './graphWalk';
import { describeForEachItem, describeForEachParents, listItemFields } from './loops';
import { overlayGroupWithReal } from './realOverlay';
import { describeTriggerMeta, triggerMetaSample } from './triggers';

/** Tool name → its catalog output sample and schema. */
export function buildToolOutputMap(catalog: Catalog | null | undefined): ToolOutputMap {
    const out: ToolOutputMap = new Map();
    for (const app of catalog?.apps || []) {
        for (const action of app.actions || []) {
            if (!action?.name) continue;
            out.set(action.name, { sample: action.outputSample || null, schema: action.outputSchema || null });
        }
    }
    return out;
}

/**
 * A step that runs once per item returns the forEach envelope, so every field
 * MOVES under `…output.results[*].output`, children and quoting kept; a
 * single value's sample becomes `[value]`, marked `perIteration` (BFSF-369),
 * and the counters surface.
 */
function wrapGroupForEach(group: VariableGroup): VariableGroup {
    const base = group.basePath;
    const moved = rebaseFields((group.fields || []).filter((f) => f && f.path), base, forEachOutputPath(base)).map(perIterationField);
    return {
        ...group,
        forEach: true,
        sample: { iterations: 0, succeeded: 0, failed: 0, results: [{ index: 0, item: {}, output: group.sample || {}, status: 'success' }] },
        fields: [
            ...['iterations', 'succeeded', 'failed'].map((k) => ({ key: k, path: appendKey(base, k), sample: 0 })),
            ...moved,
        ],
    };
}

interface WalkRoot {
    trigger: Record<string, unknown> & { output: unknown };
    steps: Record<string, { output: unknown }>;
    loop?: Record<string, unknown>;
}

/** File a node's sample where its bindings read it (`loop.<var>` for an "Each item" pill). */
function recordSample(root: WalkRoot, node: FlowNode, group: VariableGroup): void {
    if (node.type === 'loop_item') {
        root.loop = { ...(root.loop || {}), [node.itemVar || 'item']: group.sample ?? {} };
        return;
    }
    root.steps[node.id] = { output: group.sample || {} };
}

/** A container the current step is INSIDE (`lp1/a` is inside `lp1`). */
function isOwnContainer(groupId: unknown, currentStepId: unknown): boolean {
    return typeof groupId === 'string' && typeof currentStepId === 'string' && currentStepId.startsWith(`${groupId}/`);
}

function describeWalked(node: FlowNode, ctx: WalkContext): VariableGroup | null {
    let g = describeNode(node, { ...ctx, sampleRoot: ctx.root });
    if (g && !node.__isTrigger && node.forEach?.overRef) g = wrapGroupForEach(g);
    if (!g) return null;
    const real = ctx.realOutputById?.get(node.id);
    // A pin is handed downstream as it is, so its own shape counts; a stale run's does not.
    return real !== undefined ? overlayGroupWithReal(g, real, { pinned: node.pinnedOutput != null }) : g;
}

interface WalkContext {
    definition: FlowDefinition;
    toolToOutput: ToolOutputMap;
    triggerOutputs: Record<string, TriggerOutputEntry>;
    root: WalkRoot;
    catalog: Catalog | null;
    realOutputById: Map<string, unknown> | null | undefined;
}

function walkGroups(upstream: FlowNode[], ctx: WalkContext): VariableGroup[] {
    let triggerHasRealData = false;
    const groups: VariableGroup[] = [];
    for (const node of upstream) {
        const g = describeWalked(node, ctx);
        if (!g) continue;
        if (!node.__isTrigger) recordSample(ctx.root, node, g);
        // All triggers share one runtime slot; real data is never clobbered.
        else if (!triggerHasRealData) ctx.root.trigger.output = g.sample || {};
        if (node.__isTrigger && g.hasRealData) triggerHasRealData = true;
        groups.push(g);
    }
    return groups;
}

/**
 * The variable groups visible to `currentStepId`, nearest last. [] when the
 * definition or the step is missing.
 */
export function computeUpstreamGroups(
    definition: FlowDefinition | null | undefined,
    currentStepId: string | null | undefined,
    catalog: Catalog | null | undefined,
    realOutputById: Map<string, unknown> | null = null,
): VariableGroup[] {
    if (!definition || !currentStepId) return [];
    const upstream = collectUpstream(definition, currentStepId);
    if (upstream.length === 0) return [];
    const ctx: WalkContext = {
        definition,
        toolToOutput: buildToolOutputMap(catalog),
        triggerOutputs: catalog?.triggerOutputs || {},
        root: { trigger: { output: {}, ...triggerMetaSample(definition) }, steps: {} },
        catalog: catalog || null,
        realOutputById,
    };
    const groups = walkGroups(upstream, ctx);
    if (upstream.some((n) => n.__isTrigger)) {
        const meta = describeTriggerMeta(definition, catalog);
        if (meta) groups.push(meta);
    }
    const cur = (definition.steps || []).find((s) => s.id === currentStepId);
    // A step running per INNER item keeps its outer items (`forEach.parents`), right before the current one.
    if (cur?.forEach?.overRef) {
        groups.push(...describeForEachParents(cur, definition, ctx.toolToOutput, ctx.root));
        groups.push(describeForEachItem(cur, definition, ctx.toolToOutput, ctx.root));
    }
    return groups.filter((g) => !isOwnContainer(g.id, currentStepId));
}

function loopItemGroup(loopStep: FlowNode, previewSample: unknown): VariableGroup {
    const itemVar = loopStep.itemVar || 'item';
    const batched = Math.max(1, Number(loopStep.batchSize) || 1) > 1;
    // The item the first iteration binds (its gaps filled from the other rows), not a blend of every row.
    const overRef = typeof loopStep.overRef === 'string' ? loopStep.overRef.trim() : '';
    const list = overRef && previewSample ? getPath(previewSample, overRef) : undefined;
    const elementSample = firstItemPreview(list) || {};
    const label = batched
        ? t('mobile.flow.group.current_batch', 'Current batch (loop.{name})', { name: itemVar })
        : t('mobile.flow.group.current_item', 'Current item (loop.{name})', { name: itemVar });
    return {
        id: '__loop_item',
        label,
        kind: 'loop',
        basePath: `loop.${itemVar}`,
        sample: batched ? [elementSample] : elementSample,
        fields: batched || !isObj(elementSample) ? [] : listItemFields(list, `loop.${itemVar}`),
    };
}

/** Where a loop body step sits: what is visible outside the loop, and the context. */
export interface LoopBodyScope {
    outerGroups?: VariableGroup[] | null;
    previewSample?: unknown;
    catalog?: Catalog | null;
    definition: FlowDefinition;
}

/**
 * The groups ONE step inside a Loop's body sees: everything outside the loop,
 * the current item (or batch), and every EARLIER body step. (The web takes the
 * scope positionally: outerGroups, previewSample, catalog, definition.)
 */
export function computeLoopBodyGroups(loopStep: FlowNode, bodyIndex: number, scope: LoopBodyScope): VariableGroup[] {
    const toolToOutput = buildToolOutputMap(scope.catalog);
    const body = Array.isArray(loopStep.body) ? (loopStep.body as FlowNode[]) : [];
    const priorGroups = body
        .slice(0, bodyIndex)
        .map((s) => describeNode(s, { definition: scope.definition, toolToOutput, triggerOutputs: {} }))
        .filter((g): g is VariableGroup => !!g);
    return [...(scope.outerGroups || []), loopItemGroup(loopStep, scope.previewSample), ...priorGroups];
}
