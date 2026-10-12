/**
 * Edit data (set), the pure half: the six whole-table operations with their
 * titles and defaults (agent-hub `Builder/flow/setOperations.js` SET_OP_DEFS),
 * the columns each operation card can offer (the source row's keys, the
 * computed fields, then every EARLIER operation folded on top — the bindings
 * layer's columnsAfterOps), the collision warning, the key-list edit, and the
 * "Pick fields from JSON text" helpers of the web's JsonExtractSection
 * (setEditors.jsx) and ParseJsonFields.jsx. Pinned by set.lockstep.test.ts.
 */

import { columnsAfterOps, suggestKeyFromPath, type VariableGroup } from '@/features/flow-editor/bindings';
import { jsonPickBinding } from '@/features/flow-editor/bindings/valueParts';
import { humanizeFieldKey } from '@/features/flow-editor/model';
import { appendKey } from '@/shared/expr';

import { msg, type Msg } from '../declarative/spec';

export type SetOp = Record<string, unknown> & { op: string };

export interface SetOpDef {
    op: string;
    title: Msg;
    hint: Msg;
    makeDefault: () => SetOp;
}

export const SET_OP_DEFS: readonly SetOpDef[] = [
    {
        op: 'rowId',
        title: msg('mobile.flow.set.op_row_id', 'Number the rows'),
        hint: msg('mobile.flow.set.op_row_id_hint', 'Every row gets a number: 1, 2, 3, …'),
        makeDefault: () => ({ op: 'rowId', target: 'id' }),
    },
    {
        op: 'groupId',
        title: msg('mobile.flow.set.op_group_id', 'Give matching rows a shared ID'),
        hint: msg('mobile.flow.set.op_group_id_hint', 'Rows with the same value(s) get the same number, in order of first appearance.'),
        makeDefault: () => ({ op: 'groupId', target: 'groupId', keys: [] }),
    },
    {
        op: 'rename',
        title: msg('mobile.flow.set.op_rename', 'Rename a field'),
        hint: msg('mobile.flow.set.op_rename_hint', 'Give a column a new name.'),
        makeDefault: () => ({ op: 'rename', from: '', to: '' }),
    },
    {
        op: 'keep',
        title: msg('mobile.flow.set.op_keep', 'Keep only some fields'),
        hint: msg('mobile.flow.set.op_keep_hint', 'Everything not listed is dropped from every row.'),
        makeDefault: () => ({ op: 'keep', keys: [] }),
    },
    {
        op: 'remove',
        title: msg('mobile.flow.set.op_remove', 'Remove fields'),
        hint: msg('mobile.flow.set.op_remove_hint', 'Drop the listed columns from every row.'),
        makeDefault: () => ({ op: 'remove', keys: [] }),
    },
    {
        op: 'sort',
        title: msg('mobile.flow.set.op_sort', 'Sort the rows'),
        hint: msg('mobile.flow.set.op_sort_hint', 'Numbers sort as numbers, text A→Z (case doesn’t matter); missing values go last.'),
        makeDefault: () => ({ op: 'sort', key: '', direction: 'asc' }),
    },
];

export const opDef = (op: string): SetOpDef | null => SET_OP_DEFS.find((d) => d.op === op) ?? null;

const isRow = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Columns BEFORE any operation: the row's own keys (a scalar list reads as `value`), then the computed fields. */
export function baseColumnsOf(elementSample: unknown, fields: unknown): string[] {
    const cols: string[] = [];
    if (isRow(elementSample)) cols.push(...Object.keys(elementSample));
    else if (elementSample != null) cols.push('value');
    cols.push(...Object.keys(isRow(fields) ? fields : {}));
    return [...new Set(cols)];
}

/** `{column: example}` for the pickers. */
export function columnSamplesOf(elementSample: unknown): Record<string, unknown> {
    if (isRow(elementSample)) return elementSample;
    return elementSample != null ? { value: elementSample } : {};
}

/** The columns card `i` can offer: the base ones with every earlier card folded on top. */
export const columnsAt = (base: readonly string[], ops: readonly SetOp[], i: number): string[] => columnsAfterOps(base, ops, i);

/** Writing into a column that already exists replaces its values — legal, never silent. */
export function collisionOf(name: unknown, existing: readonly string[]): Msg | null {
    return typeof name === 'string' && name && existing.includes(name)
        ? msg('mobile.flow.set.replaces_column', 'Replaces the existing “{name}” values on every row.', { name: humanizeFieldKey(name) })
        : null;
}

/** A key list shows one empty row when it has none; editing keeps the row being edited, drops other blanks. */
export const keyRows = (keys: unknown): string[] => (Array.isArray(keys) && keys.length ? (keys as string[]) : ['']);

export function setKeyAt(keys: unknown, i: number, value: string): string[] {
    const next = keyRows(keys).slice();
    next[i] = value;
    return next.filter((k, j) => k || j === i);
}

// ── Pick fields from JSON text ─────────────────────────────────────────

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A unique, identifier-safe field name from a picked path. */
export function suggestFieldName(path: string, existingNames: readonly string[] = []): string {
    let base = suggestKeyFromPath(path);
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    if (!FIELD_NAME_RE.test(base)) base = 'field';
    const taken = new Set(existingNames.filter(Boolean));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
}

/** A resolved source for preview: strings are JSON-parsed (BOM and space tolerated); objects pass through. */
export function parseSampleSource(sourceValue: unknown): unknown {
    if (typeof sourceValue === 'string') {
        try {
            return JSON.parse(sourceValue.replace(/^﻿/, '').trim());
        } catch {
            return undefined;
        }
    }
    if (sourceValue !== null && typeof sourceValue === 'object') return sourceValue;
    return undefined;
}

const jsonish = (v: unknown): boolean => {
    if (typeof v !== 'string') return false;
    const parsed = parseSampleSource(v);
    return parsed !== undefined && parsed !== null && typeof parsed === 'object';
};

const PREFERRED = /body|content|text|json|payload|raw/i;

export interface JsonCandidate {
    path: string;
    label: string;
    preferred: boolean;
}

/**
 * The values that hold JSON text: in list mode the current row's fields, else
 * every upstream field (nearest step first); names like body/content/json first.
 */
function rowCandidates(elementSample: unknown, eachRow: string): JsonCandidate[] {
    if (!isRow(elementSample)) return [];
    return Object.entries(elementSample)
        .filter(([, v]) => jsonish(v))
        // The row's key written canonically (`item["raw-json"]`), never `item.raw-json`.
        .map(([k]) => ({ path: appendKey('item', k), label: `${eachRow} · ${humanizeFieldKey(k)}`, preferred: PREFERRED.test(k) }));
}

function upstreamCandidates(groups: readonly VariableGroup[]): JsonCandidate[] {
    const found: JsonCandidate[] = [];
    const add = (g: VariableGroup, f: { key: string; path: string; sample?: unknown }) => {
        if (jsonish(f.sample)) found.push({ path: f.path, label: `${g.label} · ${humanizeFieldKey(f.key)}`, preferred: PREFERRED.test(f.key) });
    };
    // Nearest upstream step first (groups are in execution order).
    for (const g of [...groups].reverse()) {
        for (const f of g.fields || []) {
            add(g, f);
            for (const c of f.children || []) add(g, c);
        }
    }
    return found;
}

/**
 * The values that hold JSON text: in list mode the current row's fields, else
 * every upstream field (nearest step first); names like body/content/json first.
 */
export function jsonCandidates({ listMode, elementSample, groups, eachRow }: { listMode: boolean; elementSample: unknown; groups: readonly VariableGroup[]; eachRow: string }): JsonCandidate[] {
    const found = listMode ? rowCandidates(elementSample, eachRow) : upstreamCandidates(groups);
    return found.sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
}

/**
 * A pick becomes a field that reads it (bindings/valueParts jsonPickBinding):
 * a plain path into JSON text — the run reads JSON text as the value it
 * encodes, so any key works — or, for JSON inside prose,
 * `parseJson(<source>, "<path>")` with the path as an escaped literal.
 * `sourceValue` is the source's sample, which says which of the two it is.
 */
export function addJsonField(fields: unknown, sourcePath: string, relPath: string, sourceValue?: unknown): Record<string, unknown> {
    const current = isRow(fields) ? fields : {};
    const name = suggestFieldName(relPath, Object.keys(current));
    return { ...current, [name]: jsonPickBinding(sourcePath, relPath, sourceValue) };
}
