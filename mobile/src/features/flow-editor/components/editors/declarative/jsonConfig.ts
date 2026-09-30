/**
 * A step's settings as JSON, and back — the web's "Advanced options are
 * available in the JSON view", for the step types the phone has no form for
 * yet. What is shown is the step's own configuration: never its identity
 * (`id`, `type`), its place on the canvas, its name (the header edits that)
 * or its pinned output (the Output tab owns that).
 */

import type { FlowNode } from '@/features/flow-editor/bindings';
import type { StepPatch } from '@/features/flow-editor/formState';

export const NOT_CONFIG: ReadonlySet<string> = new Set([
    'id', 'type', 'position', 'size', 'label', 'icon', 'labelManual', 'iconManual', 'pinnedOutput', 'pinnedAt', 'pinnedSource',
]);

export function configOf(step: FlowNode): Record<string, unknown> {
    return Object.fromEntries(Object.entries(step).filter(([k, v]) => !NOT_CONFIG.has(k) && v !== undefined));
}

export function configText(step: FlowNode): string {
    return JSON.stringify(configOf(step), null, 2);
}

export type ConfigParse = { ok: true; patch: StepPatch } | { ok: false; reason: 'invalid' | 'not_object' | 'reserved'; message?: string; key?: string };

/**
 * Typed JSON → the patch that makes the step's configuration exactly that: a
 * key left out is removed (`undefined`), a reserved key is refused.
 */
export function parseConfig(step: FlowNode, text: string): ConfigParse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { ok: false, reason: 'invalid', message: e instanceof Error ? e.message : String(e) };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not_object' };
    const next = parsed as Record<string, unknown>;
    const reserved = Object.keys(next).find((k) => NOT_CONFIG.has(k));
    if (reserved) return { ok: false, reason: 'reserved', key: reserved };
    const patch: StepPatch = { ...next };
    for (const k of Object.keys(configOf(step))) if (!(k in next)) patch[k] = undefined;
    return { ok: true, patch };
}
