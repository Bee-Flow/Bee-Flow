/**
 * Real step output — the bridge between what a run or a pin actually produced
 * and the design-time sample world the editors reason in. Built once per render
 * and threaded into computeUpstreamGroups / autoMapStep / the node editor, so
 * every consumer of the groups sees the same real data. Never deep-clones.
 * Port of agent-hub `Builder/mapping/realOutputs.js`; pinned by
 * mapping.lockstep.test.ts.
 */

import type { FlowDefinition, FlowNode, Obj, VariableGroup } from './types';

/** The server's 256 KB truncation sentinel is not data. */
export function isTruncatedOutput(v: unknown): boolean {
    return !!v && typeof v === 'object' && (v as Obj).__truncated__ === true;
}

/**
 * Real output over a design-time sample, key by key: real wins, a real
 * scalar/array replaces the sample subtree, sample keys the run lacked survive.
 */
export function deepOverlay(base: unknown, real: unknown): unknown {
    if (real === null || typeof real !== 'object' || Array.isArray(real)) return real;
    if (base === null || typeof base !== 'object' || Array.isArray(base)) return real;
    const out: Obj = { ...(base as Obj) };
    for (const k of Object.keys(real)) out[k] = k in base ? deepOverlay((base as Obj)[k], (real as Obj)[k]) : (real as Obj)[k];
    return out;
}

export interface RunStepRow {
    stepId?: string;
    parentStepId?: string | null;
    output?: unknown;
    [key: string]: unknown;
}

function nodesOf(definition: FlowDefinition): FlowNode[] {
    const nodes: FlowNode[] = [];
    if (definition.trigger?.id) nodes.push(definition.trigger);
    for (const tr of definition.triggers || []) if (tr?.id) nodes.push(tr);
    for (const s of definition.steps || []) if (s?.id) nodes.push(s);
    return nodes;
}

function primaryRow(r: RunStepRow | null | undefined, knownIds: Set<string>): r is RunStepRow & { stepId: string } {
    return !!r && !r.parentStepId && knownIds.has(r.stepId as string);
}

/**
 * What of a stored output may count as the step's real data: a truncation
 * sentinel only by its shape-preserving `preview` (every level kept, long
 * lists cut), which keeps a big payload's deep fields pickable.
 */
function usableOutput(v: unknown): unknown {
    if (v == null) return undefined;
    if (!isTruncatedOutput(v)) return v;
    const preview = (v as Obj).preview;
    return preview != null ? preview : undefined;
}

/**
 * The freshest real output per node id: primary run rows first (first match
 * wins), then a pinned output OVERRIDES them. Only ids still in the definition.
 */
export function buildRealOutputMap(
    definition: FlowDefinition | null | undefined,
    runSteps: RunStepRow[] | null | undefined,
): Map<string, unknown> {
    const map = new Map<string, unknown>();
    if (!definition) return map;
    const nodes = nodesOf(definition);
    const knownIds = new Set(nodes.map((n) => n.id));
    for (const r of runSteps || []) {
        if (!primaryRow(r, knownIds) || map.has(r.stepId)) continue;
        const out = usableOutput(r.output);
        if (out !== undefined) map.set(r.stepId, out);
    }
    for (const node of nodes) {
        const out = usableOutput(node.pinnedOutput);
        if (out !== undefined) map.set(node.id, out);
    }
    return map;
}

export interface SampleRoot {
    trigger: { output: unknown };
    steps: Record<string, { output: unknown }>;
    loop: Record<string, unknown>;
}

/**
 * The preview root (`{trigger, steps, loop}`) the binding editors resolve paths
 * against, from groups computeUpstreamGroups already overlaid with real data.
 * A trigger group with real data locks the trigger slot; a group's BASE PATH
 * (not its kind) decides whether it is a loop scope or a step.
 */
export function buildSampleRoot(groups: VariableGroup[] | null | undefined): SampleRoot {
    const root: SampleRoot = { trigger: { output: {} }, steps: {}, loop: {} };
    let triggerLocked = false;
    for (const g of groups || []) {
        if (g.kind === 'trigger') {
            if (triggerLocked) continue;
            root.trigger.output = g.sample || {};
            if (g.hasRealData) triggerLocked = true;
        } else if (String(g.basePath || '').startsWith('loop.')) {
            const tail = String(g.basePath).split('.').slice(1).join('.');
            if (tail) root.loop[tail] = g.sample || {};
        } else {
            root.steps[g.id] = { output: g.sample || {} };
        }
    }
    return root;
}
