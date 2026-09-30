/**
 * The Tables row editor's map half: read the stored `values` into something
 * drawable, put each key on the column it reaches at run time, and pick the
 * upstream fields Auto-map may draw from. From agent-hub
 * `Builder/flow/settings/tablesRowValues.js`; pinned by settings.lockstep.test.ts.
 */

import { resolveKeyToColumn, type TableColumn } from './columnMatch';
import type { Binding, FlowNode, VariableGroup } from '../bindings/types';

const BINDING_KINDS = new Set(['literal', 'ref', 'template', 'expr']);

export interface ValuesMap {
    map: Record<string, unknown>;
    whole: Binding | null;
}

function fromJsonString(text: string): ValuesMap | null {
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { map: parsed as Record<string, unknown>, whole: null };
    } catch {
        /* not JSON — the caller decides */
    }
    return null;
}

function fromLiteral(value: Binding): ValuesMap {
    const v = value.value;
    if (v == null || v === '') return { map: {}, whole: null };
    if (typeof v === 'object' && !Array.isArray(v)) return { map: v as Record<string, unknown>, whole: null };
    if (typeof v === 'string') return fromJsonString(v) || { map: {}, whole: value };
    return { map: {}, whole: value };
}

/**
 * The stored `values` in the two shapes the editor draws: `map` — the plain
 * `{ title: binding }` object (a literal wrapper or a JSON string unwrapped) —
 * or `whole` — the ENTIRE map bound from a step, shown as one slot.
 */
export function readValuesMap(value: unknown): ValuesMap {
    if (value == null || value === '') return { map: {}, whole: null };
    if (typeof value === 'string') return fromJsonString(value) || { map: {}, whole: { kind: 'literal', value } };
    if (typeof value !== 'object' || Array.isArray(value)) return { map: {}, whole: { kind: 'literal', value } };
    const v = value as Binding;
    if (typeof v.kind === 'string' && BINDING_KINDS.has(v.kind)) return v.kind === 'literal' ? fromLiteral(v) : { map: {}, whole: v };
    return { map: value as Record<string, unknown>, whole: null };
}

/**
 * Each stored key on the column it reaches at run time — exact titles first so
 * an alias never steals a column; a key that reaches nothing, or a second key
 * onto a taken column, is a stray (shown, never dropped).
 */
export function placeKeys(map: Record<string, unknown> | null | undefined, columns: TableColumn[]): { keyForColumn: Record<string, string>; stray: string[] } {
    const keyForColumn: Record<string, string> = {};
    const stray: string[] = [];
    const keys = Object.keys(map || {});
    const exact = new Set(columns.map((c) => c.title.toLowerCase()));
    const ordered = [...keys.filter((k) => exact.has(k.toLowerCase())), ...keys.filter((k) => !exact.has(k.toLowerCase()))];
    for (const key of ordered) {
        const col = resolveKeyToColumn(key, columns);
        if (!col || keyForColumn[col.title] !== undefined) stray.push(key);
        else keyForColumn[col.title] = key;
    }
    return { keyForColumn, stray };
}

/** A group's fields plus one level of children, minus the ones that resolve to MANY values. */
export function candidateFields(group: VariableGroup | null | undefined): { key: string; path: string }[] {
    const out: { key: string; path: string }[] = [];
    for (const f of group?.fields || []) {
        if (f.perIteration) continue;
        out.push({ key: f.key, path: f.path });
        for (const c of f.children || []) {
            if (!/\[\*\]/.test(c.path)) out.push({ key: c.key, path: c.path });
        }
    }
    return out.filter((c) => c.key && c.path);
}

/** Groups Auto-map can be pointed at: real data sources, not the trigger's metadata. */
export function mappableGroups(groups: VariableGroup[] | null | undefined): VariableGroup[] {
    return (groups || []).filter((g) => g && g.kind !== 'trigger_meta' && (g.fields || []).length);
}

/** The step's own forEach item when it iterates, otherwise the nearest upstream step. */
export function feedingGroup(groups: VariableGroup[] | null | undefined, step: Partial<FlowNode> | null | undefined): VariableGroup | null {
    const usable = mappableGroups(groups);
    const itemVar = step?.forEach?.overRef ? step.forEach.itemVar || 'item' : null;
    const own = itemVar ? usable.find((g) => g.basePath === `loop.${itemVar}`) : undefined;
    return own || usable[usable.length - 1] || null;
}

/** Comma-, semicolon- or newline-separated titles: trimmed, de-duplicated, in order. */
export function parseTitleList(text: unknown): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of String(text || '').split(/[\n,;]+/)) {
        const title = raw.trim();
        if (!title || seen.has(title.toLowerCase())) continue;
        seen.add(title.toLowerCase());
        out.push(title);
    }
    return out;
}
