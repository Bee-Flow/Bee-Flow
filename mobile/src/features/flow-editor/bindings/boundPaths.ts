/**
 * Which upstream paths a step already uses ("2 fields · 1 already in use"),
 * and how many of its declared slots are still empty. It reads every string
 * with the runtime's grammar, the way the server's binder reads it. Port of agent-hub
 * `Builder/mapping/boundPaths.js`; pinned by mapping.lockstep.test.ts.
 */

import { scanTemplate } from '@/shared/expr';

import { classifyRef, scanExprPaths } from './refTokens';
import type { FlowNode, JsonSchema, VariableField } from './types';
import { canonicalRefPath, detectTemplate, isCleanPath } from './walkPath';

const USE_ROOTS = ['steps', 'trigger', 'loop'];

/** A reference to an upstream value (not the bare `trigger` root), canonical; null otherwise. */
function referenceOf(path: string): string | null {
    const ref = classifyRef(path);
    if (!ref || (ref.source === 'trigger' && !/^\s*trigger\s*(?:\.\s*output|\[)/.test(path))) return null;
    return canonicalRefPath(path);
}

/** Every reference one string holds: a template's placeholders, a whole path, or the paths in a formula. */
function referencesIn(text: string, out: Set<string>): void {
    const add = (p: string) => {
        const c = referenceOf(p);
        if (c) out.add(c);
    };
    if (detectTemplate(text)) {
        for (const part of scanTemplate(text)) if (part.type === 'ref') add(part.inner);
        return;
    }
    if (isCleanPath(text.trim())) {
        add(text);
        return;
    }
    for (const part of scanExprPaths(text, USE_ROOTS)) if ('path' in part) add(part.path);
}

/**
 * Every reference path written anywhere in `step` (not its id, position or
 * label), read with the runtime's grammar and kept CANONICAL, so a field
 * counts as in use whichever spelling the binding and the tree use.
 */
export function usedPathsIn(step: unknown): Set<string> {
    const out = new Set<string>();
    if (!step || typeof step !== 'object') return out;
    const rest: Record<string, unknown> = { ...(step as Record<string, unknown>) };
    delete rest.id;
    delete rest.position;
    delete rest.label;
    const seen = new WeakSet<object>();
    const walk = (v: unknown): void => {
        if (typeof v === 'string') {
            referencesIn(v, out);
            return;
        }
        if (!v || typeof v !== 'object' || seen.has(v)) return;
        seen.add(v);
        for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child);
    };
    walk(rest);
    return out;
}

/** Is `path` (or one of its children) among the used paths? Spelling-agnostic. */
export function pathInUse(path: string | null | undefined, used: Set<string> | null | undefined): boolean {
    if (!used || !path) return false;
    if (used.has(path)) return true;
    const c = canonicalRefPath(path);
    if (used.has(c)) return true;
    for (const p of used) if (p.startsWith(`${c}.`) || p.startsWith(`${c}[`)) return true;
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
