/**
 * Id helpers and small shared plumbing for the definition ops.
 *
 * Port of the "Id helpers" and "Internal helpers" blocks of
 * agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js,
 * which mirrors server/appStudio/componentSpecs.js (authoritative).
 * ops.lockstep.test.ts runs both on the same fixtures.
 */

import type { AppNode, AppSection } from '../types';

export type IdKind = 'screen' | 'section' | 'component' | 'action';

export const ID_PREFIXES: Readonly<Record<IdKind, string>> = {
    screen: 'scr',
    section: 'sec',
    component: 'cmp',
    action: 'act',
};
export const ID_RE = /^(scr|sec|cmp|act)_[a-z0-9]{4,12}$/;

/** A fresh `<prefix>_xxxxxx` id. Random, so callers that need uniqueness use uniqueId. */
export function newId(kind: IdKind | string): string {
    const prefix = ID_PREFIXES[kind as IdKind] || 'cmp';
    let s = '';
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a node id inside an app definition, not a security token; uniqueId draws again on a collision
    while (s.length < 6) s += Math.random().toString(36).slice(2);
    return `${prefix}_${s.slice(0, 6)}`;
}

/** Mirrors SECTION_STYLE_DEFAULTS in componentSpecs.js. */
export const SECTION_STYLE_DEFAULTS = Object.freeze({ padding: 4, gap: 3, background: 'none' });

/** newId that is guaranteed not to collide with `taken`; claims the id. */
export function uniqueId(kind: IdKind, taken: Set<string>): string {
    let id = newId(kind);
    while (taken.has(id)) id = newId(kind);
    taken.add(id);
    return id;
}

export function emptySection(taken: Set<string>): AppSection {
    return { id: uniqueId('section', taken), style: { ...SECTION_STYLE_DEFAULTS }, children: [] };
}

/** Clamp an insertion index into [0, len]; nullish/non-integer means append. */
export function clampIndex(index: unknown, len: number): number {
    if (!Number.isInteger(index)) return len;
    return Math.max(0, Math.min(index as number, len));
}

export function insertAt<T>(arr: readonly T[], index: unknown, item: T): T[] {
    const next = arr.slice();
    next.splice(clampIndex(index, next.length), 0, item);
    return next;
}

/** True when a shallow patch would change nothing on `target` (Object.is). */
export function isNoopPatch(target: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): boolean {
    return Object.keys(patch).every((k) => Object.is(target?.[k], patch[k]));
}

/** JSON-shaped deep clone (definitions are plain data by contract). */
export function deepClone<T>(value: T): T {
    if (Array.isArray(value)) return value.map(deepClone) as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
        return out as T;
    }
    return value;
}

/** Every id in a node's subtree (root included). */
export function subtreeIds(node: AppNode): Set<string> {
    const ids = new Set<string>([node.id]);
    const walk = (children: AppNode[] | undefined) => {
        for (const child of children || []) {
            ids.add(child.id);
            walk(child.children);
        }
    };
    walk(node.children);
    return ids;
}

/** A plain-object test that TypeScript can narrow on. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
