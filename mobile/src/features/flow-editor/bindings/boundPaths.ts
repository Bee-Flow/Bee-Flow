/**
 * Which upstream paths a step already uses ("2 fields · 1 already in use"),
 * and how many of its declared slots are still empty. Deliberately syntactic:
 * it reads the text the server's binder reads. Port of agent-hub
 * `Builder/mapping/boundPaths.js`; pinned by mapping.lockstep.test.ts.
 */

import type { FlowNode, JsonSchema, VariableField } from './types';

const REF_RE = /(?:steps\.[A-Za-z0-9_-]+\.output|trigger\.output|loop\.[A-Za-z0-9_]+)(?:\.[A-Za-z0-9_]+|\[\*\]|\[\d+\]|\["[^"]*"\])*/g;

/** Every reference path written anywhere in `step` (not its id, position or label). */
export function usedPathsIn(step: unknown): Set<string> {
    const out = new Set<string>();
    if (!step || typeof step !== 'object') return out;
    const rest: Record<string, unknown> = { ...(step as Record<string, unknown>) };
    delete rest.id;
    delete rest.position;
    delete rest.label;
    let text = '';
    try {
        text = JSON.stringify(rest) || '';
    } catch {
        return out;
    }
    for (const m of text.matchAll(REF_RE)) out.add(m[0]);
    return out;
}

/** Is `path` (or one of its children) among the used paths? */
export function pathInUse(path: string | null | undefined, used: Set<string> | null | undefined): boolean {
    if (!used || !path) return false;
    if (used.has(path)) return true;
    for (const p of used) if (p.startsWith(`${path}.`) || p.startsWith(`${path}[`)) return true;
    return false;
}

/** How many of a group's top-level fields this step already uses. */
export function countInUse(fields: VariableField[] | null | undefined, used: Set<string> | null | undefined): number {
    if (!used || !used.size) return 0;
    let n = 0;
    for (const f of fields || []) if (f?.path && pathInUse(f.path, used)) n += 1;
    return n;
}

/** Nothing typed, nothing picked — the one answer every "still empty" surface reads. */
export function isEmptyValue(b: unknown): boolean {
    if (b == null) return true;
    if (typeof b !== 'object') return String(b).trim() === '';
    const v = b as { kind?: unknown; value?: unknown; path?: unknown };
    if (v.kind === 'literal') return v.value == null || String(v.value).trim() === '';
    if (v.kind === 'ref') return !String(v.path || '').trim();
    if (v.kind === 'template' || v.kind === 'expr') return !String(v.value || '').trim();
    return false;
}

const SLOT_MAPS = ['inputs', 'fields'];

export interface EmptySlots {
    declared: number;
    empty: number;
    keys: string[];
    unknown: boolean;
}

/**
 * Of the slots this step DECLARES (keys of `inputs`/`fields`, plus the tool
 * schema's REQUIRED params), how many hold nothing. `schemaKnown: false` means
 * the schema could not be read, and comes back as `unknown: true` — "I cannot
 * check" must never look like "nothing is wrong".
 */
export function emptySlotsIn(
    step: Partial<FlowNode> | null | undefined,
    { inputSchema = null, schemaKnown = true }: { inputSchema?: JsonSchema | null; schemaKnown?: boolean } = {},
): EmptySlots {
    const keys: string[] = [];
    let declared = 0;
    const seen = new Set<string>();
    const take = (id: string, key: string, empty: boolean) => {
        if (seen.has(id)) return;
        seen.add(id);
        declared += 1;
        if (empty) keys.push(key);
    };
    for (const map of SLOT_MAPS) {
        const slots = step?.[map];
        if (!slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
        for (const [k, v] of Object.entries(slots)) take(`${map}.${k}`, k, isEmptyValue(v));
    }
    const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
    for (const k of required) take(`inputs.${k}`, k, true);
    return { declared, empty: keys.length, keys, unknown: !schemaKnown };
}
