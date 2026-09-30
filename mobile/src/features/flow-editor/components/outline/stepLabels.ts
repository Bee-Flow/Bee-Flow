/**
 * Id → the name a reference to that step reads with, for the cards: the
 * author's label, else the name its own card shows ("Gmail Search", not
 * `act_4d4307a`) — for every step a reference can point at, the steps inside
 * a loop or a parallel branch included (the web's buildStepLabelMap knows the
 * top level only, so a reference to a step beside it in a loop read as its
 * id, or as "Previous step").
 */

import type { AnyNode, DefinitionInput, Translate } from '@/features/flow-editor/model';

import { unnamedStepName } from './stepSummary';

function walk(nodes: unknown, visit: (node: AnyNode) => void) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as AnyNode[]) {
        if (!node || typeof node !== 'object' || typeof node.id !== 'string') continue;
        visit(node);
        walk(node.body, visit);
        if (Array.isArray(node.branches)) for (const branch of node.branches) walk(branch, visit);
    }
}

export function cardLabelMap(def: DefinitionInput, t: Translate): Map<string, string> {
    const out = new Map<string, string>();
    if (!def) return out;
    walk([def.trigger, ...(def.triggers ?? []), ...(def.steps ?? [])], (node) => {
        if (out.has(node.id)) return;
        const label = typeof node.label === 'string' ? node.label.trim() : '';
        out.set(node.id, label || unnamedStepName(node, { t }));
    });
    return out;
}
