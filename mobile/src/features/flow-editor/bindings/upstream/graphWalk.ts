/**
 * The backward walk over the definition's edges: which nodes can flow data
 * into `currentStepId`, in the order a reader of the canvas meets them —
 * triggers first, then steps in execution order, NEAREST LAST (auto-map prefers
 * the last). Port of agent-hub `Builder/mapping/upstream/graphWalk.js`.
 */

import type { FlowDefinition, FlowNode } from '../types';

function reverseAdjacency(definition: FlowDefinition): Map<string, string[]> {
    const incoming = new Map<string, string[]>();
    for (const e of definition.edges || []) {
        if (!e.from || !e.to) continue;
        const list = incoming.get(e.to) || [];
        list.push(e.from);
        incoming.set(e.to, list);
    }
    return incoming;
}

function walkBack(incoming: Map<string, string[]>, start: string, visited: Set<string>): string[] {
    const order: string[] = [];
    const stack = [start];
    while (stack.length) {
        const cur = stack.pop() as string;
        for (const src of incoming.get(cur) || []) {
            if (visited.has(src)) continue;
            visited.add(src);
            order.push(src);
            stack.push(src);
        }
    }
    return order;
}

/**
 * Every node upstream of `currentStepId`. Every trigger is always included —
 * all of them write the one runtime `trigger.output` slot, so each is its own
 * possible shape of that path, wired or not.
 */
export function collectUpstream(definition: FlowDefinition, currentStepId: string): FlowNode[] {
    const trigger = definition.trigger;
    const additional = Array.isArray(definition.triggers) ? definition.triggers : [];
    const byId = new Map<string, FlowNode>();
    if (trigger) byId.set(trigger.id, { ...trigger, __isTrigger: true });
    for (const tr of additional) byId.set(tr.id, { ...tr, __isTrigger: true });
    for (const s of definition.steps || []) byId.set(s.id, s);

    const visited = new Set<string>();
    const order = walkBack(reverseAdjacency(definition), currentStepId, visited);
    const triggerIds = [trigger?.id, ...additional.map((tr) => tr.id)].filter(Boolean) as string[];
    for (const id of triggerIds) {
        if (!visited.has(id)) {
            visited.add(id);
            order.push(id);
        }
    }

    const result: FlowNode[] = [];
    for (const id of triggerIds) {
        const n = byId.get(id);
        if (visited.has(id) && n) result.push(n);
    }
    // The walk pops nearest-first; reversed, it is execution order.
    for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i] as string;
        if (triggerIds.includes(id)) continue;
        const n = byId.get(id);
        if (n) result.push(n);
    }
    return result;
}
