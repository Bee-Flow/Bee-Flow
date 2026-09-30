/**
 * Fresh step ids, in the web builder's format: `<prefix>_<8 random chars>`.
 *
 * The prefixes are the web's (applyAddNode.js `newStepId`, nodeOps.js
 * `duplicateStepId`) so a step added on the phone reads like one added in the
 * browser, in a run log or a validation path. The random tail comes from
 * `crypto.randomUUID` where the runtime has it and Math.random otherwise —
 * Hermes ships no WebCrypto, and an id only has to be unique within one graph.
 */

import type { FlowDefinition } from './types';

/** Step type (or palette kind) → id prefix. Anything else is `step`. */
const PREFIX: Record<string, string> = {
    integration_action: 'act',
    ai_step: 'ai',
    data_extraction: 'ex',
    condition: 'cond',
    loop: 'loop',
    notification: 'notif',
    code: 'code',
    trigger: 'trig',
};

export function idPrefix(kind: string | null | undefined, { forDuplicate = false } = {}): string {
    // The web's duplicate helper never learned the `ex` prefix; keep it that way.
    if (forDuplicate && kind === 'data_extraction') return 'step';
    return (kind && PREFIX[kind]) || 'step';
}

function randomTail(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID().split('-')[0] as string;
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- the fallback tail of a step id where the runtime lacks crypto.randomUUID, not a security token; uniqueStepId draws again on a collision
    return Math.random().toString(36).slice(2, 10);
}

/** A new id for a step of this kind (collisions are the caller's concern). */
export function newStepId(kind: string | null | undefined): string {
    return `${idPrefix(kind)}_${randomTail()}`;
}

/** A new id guaranteed not to be in `taken`. */
export function uniqueStepId(kind: string | null | undefined, taken: ReadonlySet<string>): string {
    const prefix = idPrefix(kind, { forDuplicate: true });
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const id = `${prefix}_${randomTail()}`;
        if (!taken.has(id)) return id;
    }
    // Astronomically unlikely; deterministic rather than looping forever.
    return `${prefix}_${taken.size}_${Date.now().toString(36)}`;
}

/** Every id already in use anywhere in the graph. */
export function collectIds(def: Partial<FlowDefinition>): Set<string> {
    const ids = new Set<string>();
    if (def.trigger?.id) ids.add(def.trigger.id);
    for (const t of def.triggers || []) if (t?.id) ids.add(t.id);
    for (const s of def.steps || []) if (s?.id) ids.add(s.id);
    return ids;
}
