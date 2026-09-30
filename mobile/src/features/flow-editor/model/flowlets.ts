/**
 * Flowlets — `definition.layers`, a root-only map of full mini-definitions
 * (a layer_input trigger, steps, a layer_output "Return"), called from the
 * flow by `call_layer` steps. Port of agent-hub `Builder/flow/flowletScope.js`
 * (getScopedGraph, setScopedGraph, createLayerInDefinition, listLayers,
 * layerKeysThatReach, countLayerRefs, isLayerEmpty, deleteLayerFromDefinition,
 * deleteLayerAndCalls, renameLayer); pinned by flowlets.lockstep.test.ts, which runs the web
 * module beside this one. Pure and immutable.
 */

import { applyDeleteNodes } from './nodeOps';
import type { FlowDefinition, FlowStep } from './types';

export const LAYER_KEY_RE = /^[a-z][a-z0-9_]*$/;

export interface LayerSummary {
    key: string;
    title: string;
    description: string;
    params: unknown[];
    outputFields: string[];
    /** Steps of its own: the terminal layer_output is plumbing, not a step. */
    stepCount: number;
}

/** The graph for a scope: the root itself, a flowlet's mini-definition, or null when it is gone. */
export function getScopedGraph(def: FlowDefinition | null | undefined, scopeKey: string | null): FlowDefinition | null {
    if (!def) return null;
    if (!scopeKey) return def;
    return def.layers?.[scopeKey] || null;
}

/** An edited scoped graph written back into the whole document; always a new object. */
export function setScopedGraph(def: FlowDefinition | null | undefined, scopeKey: string | null, nextGraph: FlowDefinition): FlowDefinition {
    if (!scopeKey) return nextGraph;
    const base = def || ({} as FlowDefinition);
    return { ...base, layers: { ...(base.layers || {}), [scopeKey]: nextGraph } };
}

function* walkSteps(steps: readonly unknown[] | null | undefined): Generator<FlowStep> {
    for (const raw of steps || []) {
        const step = raw as FlowStep | null;
        if (!step) continue;
        yield step;
        if (Array.isArray(step.body)) yield* walkSteps(step.body);
        if (Array.isArray(step.branches)) {
            for (const branch of step.branches as unknown[]) {
                if (Array.isArray(branch)) yield* walkSteps(branch);
                else if (Array.isArray((branch as { steps?: unknown[] })?.steps)) yield* walkSteps((branch as { steps: unknown[] }).steps);
            }
        }
    }
}

// nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a short suffix on a flowlet's key in the definition, not a token; uniqueLayerKey draws again while the key is taken
const randomSuffix = () => Math.random().toString(36).slice(2, 6);

/** A key slugged from the title, with a short random suffix; unique within `existing`. */
function uniqueLayerKey(title: string, existing: Record<string, unknown>, suffix: () => string): string {
    let slug = String(title || 'layer')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_')
        .slice(0, 40);
    if (!LAYER_KEY_RE.test(slug)) slug = `layer${slug ? `_${slug}` : ''}`;
    if (!LAYER_KEY_RE.test(slug)) slug = 'layer';
    let key = `${slug}_${suffix()}`;
    while (existing[key]) key = `${slug}_${suffix()}`;
    return key;
}

/**
 * The names a new flowlet's two ends are STORED with. Data, not copy: the
 * web's createLayerInDefinition writes these exact words into the definition
 * (flowlets.lockstep.test.ts compares the two), and a card shows a stored
 * label as it is.
 */
const INPUT_LABEL = 'Flowlet input';
const OUTPUT_LABEL = 'Return';

/** A new empty flowlet: layer_input 'trg' → layer_output 'out' ("Return"); bumps schemaVersion to 2. */
export function createLayerInDefinition(
    def: FlowDefinition | null | undefined,
    title = 'New flowlet',
    suffix: () => string = randomSuffix,
): { definition: FlowDefinition; layerKey: string } {
    const base = def || ({ trigger: null, steps: [], edges: [] } as FlowDefinition);
    const layers = base.layers || {};
    const layerKey = uniqueLayerKey(title, layers, suffix);
    const skeleton: FlowDefinition = {
        title,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', label: INPUT_LABEL, params: [], output: {} },
        steps: [{ id: 'out', type: 'layer_output', fields: {}, label: OUTPUT_LABEL }],
        edges: [{ from: 'trg', to: 'out' }],
    };
    return { definition: { ...base, schemaVersion: 2, layers: { ...layers, [layerKey]: skeleton } }, layerKey };
}

function outputFieldsOf(layer: FlowDefinition | undefined): string[] {
    const out = (layer?.steps || []).find((s) => s?.type === 'layer_output');
    return out?.fields && typeof out.fields === 'object' ? Object.keys(out.fields) : [];
}

/** The flowlets a definition declares, for the Flowlets sheet and the picker. */
export function listLayers(def: FlowDefinition | null | undefined): LayerSummary[] {
    return Object.entries(def?.layers || {}).map(([key, layer]) => {
        const steps = Array.isArray(layer?.steps) ? layer.steps : [];
        return {
            key,
            title: (layer?.title as string) || key,
            description: typeof layer?.description === 'string' ? layer.description : '',
            params: Array.isArray(layer?.trigger?.params) ? layer.trigger.params : [],
            outputFields: outputFieldsOf(layer),
            stepCount: steps.filter((s) => s?.type !== 'layer_output').length,
        };
    });
}

/** The keys whose call closure reaches `targetKey`, itself included: calling one from inside it is a cycle. */
export function layerKeysThatReach(def: FlowDefinition | null | undefined, targetKey: string): Set<string> {
    const callers = new Map<string, Set<string>>();
    for (const [key, layer] of Object.entries(def?.layers || {})) {
        for (const step of walkSteps(layer?.steps)) {
            const called = step.type === 'call_layer' ? (step.layerKey as string | undefined) : undefined;
            if (!called) continue;
            if (!callers.has(called)) callers.set(called, new Set());
            callers.get(called)?.add(key);
        }
    }
    const reach = new Set([targetKey]);
    const queue = [targetKey];
    while (queue.length) {
        const cur = queue.pop() as string;
        for (const caller of callers.get(cur) || []) {
            if (reach.has(caller)) continue;
            reach.add(caller);
            queue.push(caller);
        }
    }
    return reach;
}

const callsTo = (key: string) => (step: FlowStep) => step.type === 'call_layer' && step.layerKey === key;

/** How many call_layer steps name `key`, across the root graph and every flowlet. */
export function countLayerRefs(def: FlowDefinition | null | undefined, key: string): number {
    if (!def || !key) return 0;
    let count = 0;
    for (const g of [def, ...Object.values(def.layers || {})]) {
        for (const step of walkSteps(g?.steps)) if (callsTo(key)(step)) count += 1;
    }
    return count;
}

/** Remove a flowlet; the caller checks nothing calls it first (countLayerRefs). */
export function deleteLayerFromDefinition(def: FlowDefinition, key: string): FlowDefinition {
    const rest = { ...(def?.layers || {}) };
    delete rest[key];
    return { ...def, layers: rest };
}

/** Nothing built in it yet (the layer_output is the skeleton, not a step). */
export function isLayerEmpty(def: FlowDefinition | null | undefined, key: string): boolean {
    const layer = def?.layers?.[key];
    if (!layer) return false;
    return !(layer.steps || []).some((s) => s && s.type !== 'layer_output');
}

function stripNested(step: FlowStep, isCall: (s: FlowStep) => boolean): FlowStep {
    if (!step || typeof step !== 'object') return step;
    let next = step;
    if (Array.isArray(step.body)) next = { ...next, body: (step.body as FlowStep[]).filter((s) => !isCall(s)).map((s) => stripNested(s, isCall)) };
    if (Array.isArray(step.branches)) {
        next = {
            ...next,
            branches: (step.branches as unknown[]).map((branch) => {
                if (Array.isArray(branch)) return (branch as FlowStep[]).filter((s) => !isCall(s)).map((s) => stripNested(s, isCall));
                const inner = (branch as { steps?: FlowStep[] })?.steps;
                return Array.isArray(inner) ? { ...(branch as object), steps: inner.filter((s) => !isCall(s)).map((s) => stripNested(s, isCall)) } : branch;
            }) as FlowStep['branches'],
        };
    }
    return next;
}

/** Remove a flowlet AND every call to it, healing each graph around the removed calls. */
export function deleteLayerAndCalls(def: FlowDefinition, key: string): FlowDefinition {
    if (!def || !key) return def;
    const isCall = callsTo(key);
    const strip = (graph: FlowDefinition): FlowDefinition => {
        if (!graph) return graph;
        const topIds = (graph.steps || []).filter(isCall).map((s) => s.id);
        const healed = (topIds.length ? applyDeleteNodes(graph, topIds) : graph) as FlowDefinition;
        return { ...healed, steps: (healed.steps || []).map((s) => stripNested(s, isCall)) };
    };
    const root = strip(def);
    const layers = Object.fromEntries(
        Object.entries(root.layers || {})
            .filter(([k]) => k !== key)
            .map(([k, layer]) => [k, strip(layer)]),
    );
    return { ...root, layers };
}

/** A flowlet's display title (its key never changes: calls address it by key). */
export function renameLayer(def: FlowDefinition, key: string, title: string): FlowDefinition {
    const layer = def?.layers?.[key];
    if (!layer) return def;
    return { ...def, layers: { ...def.layers, [key]: { ...layer, title } } };
}
