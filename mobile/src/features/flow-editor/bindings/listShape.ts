/**
 * listShape — the single vocabulary for "this value is a LIST" across the
 * data-picking surfaces. Two kinds: 'list' (the path points AT an array) and
 * 'column' (the path holds `[*]`: one value from EACH row, counted as the true
 * flattened total). Sentences come back as an i18n key + params plus English.
 *
 * The only bindings emitted are a bare ref (keep the whole list — never a
 * `{{…}}` template, which would stringify it) or the whitelisted engine calls
 * first/last/join/count. Port of agent-hub `Builder/mapping/listShape.js`;
 * pinned by mapping.lockstep.test.ts.
 */

import { summariseData } from './flowDeps/dataSummary';
import type { StepLabelMap } from './refTokens';
import type { Binding, ForEach, Translate, VariableField } from './types';
import { humanizeFieldTail } from '../model/displayHelpers';
import { suggestItemVar } from './upstream/loops';
import { describeDataPath, escapeExprString } from './valueParts';
import { walkPath, walkRelativePath } from './walkPath';

const WILDCARD = '[*]';

export interface ListShape {
    kind: 'list' | 'column';
    count: number | null;
    rows: number | null;
    of: 'records' | 'values';
    elementSample: unknown;
    rowScopedListTail: boolean;
    badgeKey: string;
    badgeParams: Record<string, string | number>;
    badgeEn: string;
    explainKey: string;
    explainParams: Record<string, string | number>;
    explainEn: string;
}

/** Split a column path on its FIRST `[*]`; the tail is kept verbatim. */
export function splitColumnPath(path: unknown): { arrayPath: string; tail: string } {
    const s = String(path || '');
    const i = s.indexOf(WILDCARD);
    if (i < 0) return { arrayPath: s, tail: '' };
    return { arrayPath: s.slice(0, i), tail: s.slice(i + WILDCARD.length) };
}

function rowTail(tail: string): string {
    return String(tail || '').replace(/^\./, '');
}

function ofKind(list: unknown[]): 'records' | 'values' {
    return summariseData(list)?.kind === 'records' ? 'records' : 'values';
}

function plainListShape(raw: string, list: unknown[]): ListShape {
    const count = list.length;
    const of = ofKind(list);
    const noun = of === 'records' ? 'records' : 'items';
    const field = humanizeFieldTail(raw) || raw;
    return {
        kind: 'list', count, rows: null, of, elementSample: list[0], rowScopedListTail: false,
        badgeKey: of === 'records' ? 'routines.builder.badge_list_records' : 'routines.builder.badge_list_items',
        badgeParams: { n: count },
        badgeEn: `A list — ${count} ${noun}`,
        explainKey: 'routines.builder.explain_list',
        explainParams: { field, n: count },
        explainEn: `“${field}” is a list of ${count} ${noun}.`,
    };
}

function columnShape(raw: string, list: unknown[], sampleRoot: unknown): ListShape {
    const count = list.length;
    const { arrayPath, tail } = splitColumnPath(raw);
    const baseRows = walkPath(arrayPath, sampleRoot);
    const rows = Array.isArray(baseRows) ? baseRows.length : null;
    // Does one ROW still hold a list here? The flatten is exactly what hides it.
    const firstRow = Array.isArray(baseRows) ? baseRows.find((r) => r != null) : undefined;
    const perRow = firstRow === undefined ? undefined : walkRelativePath(rowTail(tail), firstRow);
    const nested = Array.isArray(perRow);
    const shown = rows ?? count;
    return {
        kind: 'column', count, rows, of: ofKind(list), elementSample: list[0], rowScopedListTail: nested,
        badgeKey: 'routines.builder.badge_column',
        badgeParams: { rows: shown },
        badgeEn: 'One value per row',
        explainKey: nested ? 'routines.builder.explain_column_nested' : 'routines.builder.explain_column',
        explainParams: { field: humanizeFieldTail(raw), rows: shown, n: count },
        explainEn: nested
            ? `This list sits inside each row. Repeating over it merges every row’s items into one list — ${count} in total.`
            : `One value from each of the ${shown} rows — ${count} values in total.`,
    };
}

/** What the path resolves to, when that is a list; null otherwise. */
export function pathListShape(path: unknown, sampleRoot: unknown): ListShape | null {
    const raw = String(path || '').trim();
    if (!raw || sampleRoot == null) return null;
    const resolved = walkPath(raw, sampleRoot);
    if (!Array.isArray(resolved)) return null;
    return raw.includes(WILDCARD) ? columnShape(raw, resolved, sampleRoot) : plainListShape(raw, resolved);
}

/** pathListShape for a picker row, falling back to its design-time sample (uncounted). */
export function fieldListShape(field: Partial<VariableField> | null | undefined, sampleRoot: unknown): ListShape | null {
    if (!field?.path) return null;
    const live = pathListShape(field.path, sampleRoot);
    if (live) return live;
    if (!Array.isArray(field.sample)) return null;
    return {
        kind: field.path.includes(WILDCARD) ? 'column' : 'list',
        count: null, rows: null, of: ofKind(field.sample),
        elementSample: field.sample[0],
        rowScopedListTail: false,
        badgeKey: 'routines.builder.badge_list_plain',
        badgeParams: {},
        badgeEn: 'A list',
        explainKey: 'routines.builder.explain_list_no_sample',
        explainParams: { field: humanizeFieldTail(field.path) || field.key || '' },
        explainEn: 'This is a list. Run the step above to see how many it really holds.',
    };
}

/**
 * "Run this step once for each row" as its two writes: the step's forEach and
 * the field's per-row binding (`loop.<var>` + the tail verbatim).
 */
export function forEachPickFor(
    path: unknown,
    _sampleRoot?: unknown,
    { itemVar }: { itemVar?: string } = {},
): { forEach: ForEach; binding: Binding; itemVar: string } {
    const { arrayPath, tail } = splitColumnPath(String(path || '').trim());
    const lastSeg = arrayPath.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean).pop() || 'item';
    const v = (itemVar || suggestItemVar(lastSeg) || 'item').replace(/[^A-Za-z0-9_]/g, '') || 'item';
    return {
        forEach: { overRef: arrayPath, itemVar: v, maxIterations: 100 },
        binding: { kind: 'ref', path: `loop.${v}${tail}` },
        itemVar: v,
    };
}

/** The non-iterating choices, each a stored binding the server runs as written. */
export function bindingsForList(path: unknown, { separator = ', ' }: { separator?: string } = {}): Record<'each' | 'first' | 'last' | 'join' | 'count', Binding> {
    const p = String(path || '').trim();
    return {
        each: { kind: 'ref', path: p },
        first: { kind: 'expr', value: `first(${p})` },
        last: { kind: 'expr', value: `last(${p})` },
        join: { kind: 'expr', value: `join(${p}, "${escapeExprString(separator)}")` },
        count: { kind: 'expr', value: `count(${p})` },
    };
}

/** What the FIRST iteration of a forEach pick would see. */
export function previewForEachPick(path: unknown, sampleRoot: unknown): unknown {
    const { arrayPath, tail } = splitColumnPath(String(path || '').trim());
    const list = walkPath(arrayPath, sampleRoot);
    if (!Array.isArray(list) || !list.length) return undefined;
    const first = list.find((r) => r != null);
    if (first === undefined) return undefined;
    return tail ? walkRelativePath(rowTail(tail), first) : first;
}

/** "gmail search ▸ Subject (inside each row)" — never an internal step id. */
export function describeListPath(path: unknown, stepLabelById: StepLabelMap = null, t: Translate | null = null): string {
    const raw = String(path || '').trim();
    const { arrayPath, tail } = splitColumnPath(raw);
    const isColumn = raw.includes(WILDCARD);
    const base = describeDataPath(isColumn ? arrayPath : raw, stepLabelById);
    const field = isColumn ? humanizeFieldTail(tail) : base.suffix;
    const step = base.name;
    if (!isColumn) return field ? `${step} ▸ ${field}` : step;
    const en = `${step} ▸ ${field} (inside each row)`;
    return t ? t('routines.builder.column_path_label', '{step} ▸ {field} (inside each row)', { step, field }) : en;
}

/** What SHAPE a tool parameter wants: 'list', 'scalar', or 'unknown'. */
export function expectedShapeFor(schemaProp: { type?: string | string[] } | null | undefined): 'list' | 'scalar' | 'unknown' {
    if (!schemaProp || typeof schemaProp !== 'object') return 'unknown';
    let type = schemaProp.type;
    if (Array.isArray(type)) type = type.find((x) => x !== 'null') || type[0];
    if (type === 'array') return 'list';
    if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return 'scalar';
    return 'unknown';
}
