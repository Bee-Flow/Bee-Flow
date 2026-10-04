/**
 * mismatch — "it doesn't fit one-to-one, so ask in plain words". When a picked
 * field is a LIST, a TABLE or a GROUP and the slot wants ONE value, the editor
 * writes a sensible default at once and offers the other readings under the
 * field. Every remedy is a bare ref or a call the shared engine really runs.
 * Port of agent-hub `Builder/mapping/mismatch.js`; pinned by
 * mapping.lockstep.test.ts.
 */

import { type FieldKind, isScalarKind, KIND_WORD, kindOfValue, translatorOr } from './fieldKinds';
import { joinKeyPath, keyPickable } from './keyPath';
import { bindingsForList, forEachPickFor, type ListShape, pathListShape, previewForEachPick } from './listShape';
import type { Binding, ForEach, Translate } from './types';
import { previewValue, walkPath } from './walkPath';
import { humanizeFieldTail } from '../model/displayHelpers';

export const NEWLINE = '\n';

export interface Remedy {
    id: string;
    binding: Binding;
    labelKey: string;
    labelEn: string;
    labelParams?: Record<string, string | number>;
    preview: string | null;
    forEach?: ForEach;
    itemVar?: string;
    disabled?: boolean;
}

export interface Remedies {
    shape: ListShape | null;
    count: number;
    primary: Remedy[];
    more: Remedy[];
    defaultId: string;
}

/** Is there a mismatch worth asking about? Only a list/table/group into one value. */
export function detectMismatch({ actualKind, expectedKind }: { actualKind?: unknown; expectedKind?: unknown }): { code: string; actual: string; expected: string } | null {
    if (!expectedKind || expectedKind === 'unknown' || !actualKind || actualKind === 'unknown') return null;
    if (!isScalarKind(expectedKind)) return null;
    const codes: Record<string, string> = { list: 'list_into_one', table: 'table_into_one', group: 'group_into_one' };
    const code = typeof actualKind === 'string' && Object.hasOwn(codes, actualKind) ? codes[actualKind] : undefined;
    return code ? { code, actual: actualKind as string, expected: expectedKind as string } : null;
}

const show = (v: unknown) => previewValue(v, 40);

function listAt(p: string, sampleRoot: unknown): unknown[] {
    const v = walkPath(p, sampleRoot);
    return Array.isArray(v) ? v : [];
}

function joinedPreview(list: unknown[], sep: string, ellipsis: boolean): string | null {
    if (!list.length) return null;
    const text = show(list.slice(0, 3).map((v) => (typeof v === 'object' ? '…' : String(v))).join(sep));
    return ellipsis && list.length > 3 ? `${text}…` : text;
}

interface ForEachOpts {
    allowForEach?: boolean;
    itemVar?: string;
}

interface Picked {
    p: string;
    sampleRoot: unknown;
    shape: ListShape | null;
}

function forEachRemedy({ p, sampleRoot, shape }: Picked, opts: ForEachOpts, word: { key: string; en: string }): Remedy {
    const pick = forEachPickFor(p, sampleRoot, { itemVar: opts.itemVar });
    const nested = !!shape?.rowScopedListTail;
    return {
        id: 'foreach', binding: pick.binding, forEach: pick.forEach, itemVar: pick.itemVar,
        disabled: nested, labelKey: word.key, labelEn: word.en,
        preview: nested ? null : show(previewForEachPick(p, sampleRoot)),
    };
}

function listRemedies(p: string, sampleRoot: unknown, opts: ForEachOpts): Remedies {
    const shape = pathListShape(p, sampleRoot);
    const list = listAt(p, sampleRoot);
    const b = bindingsForList(p, { separator: NEWLINE });
    const n = shape?.count ?? list.length;
    const primary: Remedy[] = [
        { id: 'join', binding: b.join, labelKey: 'automations.mismatch.choice_lines', labelEn: 'All of them, one per line', preview: joinedPreview(list, ' / ', true) },
        { id: 'first', binding: b.first, labelKey: 'automations.mismatch.choice_first', labelEn: 'Only the first', preview: list.length ? show(list[0]) : null },
        { id: 'count', binding: b.count, labelKey: 'automations.mismatch.choice_count', labelEn: 'Only the count ({n})', labelParams: { n }, preview: String(n) },
    ];
    if (opts.allowForEach) {
        primary.push(forEachRemedy({ p, sampleRoot, shape }, opts, { key: 'automations.mismatch.choice_foreach', en: 'A separate run for each item' }));
    }
    const more: Remedy[] = [
        { id: 'join_comma', binding: bindingsForList(p, { separator: ', ' }).join, labelKey: 'automations.mismatch.choice_comma', labelEn: 'All of them, comma separated', preview: joinedPreview(list, ', ', false) },
        { id: 'last', binding: b.last, labelKey: 'automations.mismatch.choice_last', labelEn: 'Only the last', preview: list.length ? show(list[list.length - 1]) : null },
        // The one correct answer when the slot really does take a list.
        { id: 'each', binding: b.each, labelKey: 'automations.mismatch.choice_each', labelEn: 'Keep the whole list', preview: null },
    ];
    return { shape, count: n, primary, more, defaultId: 'join' };
}

/** How many child buttons a group offers before the rest go behind "more". */
const GROUP_PRIMARY_FIELDS = 3;

/**
 * A GROUP into one value: its own fields as buttons (keys QUOTED, and keys
 * that cannot be expressed refused — see keyPath.ts), the readable summary as
 * the default.
 */
function groupRemedies(p: string, sampleRoot: unknown): Remedies {
    const value = walkPath(p, sampleRoot);
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const keys = Object.keys(obj).filter(keyPickable);
    const fieldRemedy = (key: string): Remedy => ({
        id: `field:${key}`,
        binding: { kind: 'ref', path: joinKeyPath(p, key) },
        labelKey: 'automations.mismatch.choice_field', labelEn: '{field}', labelParams: { field: humanizeFieldTail(key) },
        preview: show(obj[key]),
    });
    const first = keys[0];
    const summary: Remedy = {
        id: 'summary', binding: { kind: 'expr', value: `groupSummary(${p})` },
        labelKey: 'automations.mismatch.choice_summary', labelEn: 'The whole group, as a readable summary',
        preview: first !== undefined ? `${humanizeFieldTail(first)}: ${show(obj[first])}…` : null,
    };
    const whole: Remedy = {
        id: 'each', binding: { kind: 'ref', path: p },
        labelKey: 'automations.mismatch.choice_whole_group', labelEn: 'Use the whole group as it is', preview: null,
    };
    return {
        shape: null,
        count: keys.length,
        primary: [...keys.slice(0, GROUP_PRIMARY_FIELDS).map(fieldRemedy), summary],
        more: [...keys.slice(GROUP_PRIMARY_FIELDS).map(fieldRemedy), whole],
        defaultId: 'summary',
    };
}

/** A TABLE into one value: "as a table" by default — joining rows gives "[object Object]". */
function tableRemedies(p: string, sampleRoot: unknown, opts: ForEachOpts): Remedies {
    const shape = pathListShape(p, sampleRoot);
    const rows = listAt(p, sampleRoot);
    const n = shape?.count ?? rows.length;
    const firstRow = rows.find((r) => r && typeof r === 'object' && !Array.isArray(r));
    const cols = firstRow ? Object.keys(firstRow) : [];
    const b = bindingsForList(p);
    const primary: Remedy[] = [
        { id: 'table', binding: { kind: 'expr', value: `asTable(${p})` }, labelKey: 'automations.mismatch.choice_as_table', labelEn: 'As a table', preview: cols.length ? cols.slice(0, 4).map(humanizeFieldTail).join(' | ') : null },
        { id: 'count', binding: b.count, labelKey: 'automations.mismatch.choice_rows', labelEn: 'Only how many rows ({n})', labelParams: { n }, preview: String(n) },
    ];
    if (opts.allowForEach) {
        primary.push(forEachRemedy({ p, sampleRoot, shape }, opts, { key: 'automations.mismatch.choice_foreach_row', en: 'A separate run for each row' }));
    }
    const more: Remedy[] = [
        { id: 'first', binding: b.first, labelKey: 'automations.mismatch.choice_first_row', labelEn: 'Only the first row', preview: rows.length ? show(rows[0]) : null },
        { id: 'summary', binding: { kind: 'expr', value: `groupSummary(${p})` }, labelKey: 'automations.mismatch.choice_summary_rows', labelEn: 'One readable block per row', preview: null },
        { id: 'each', binding: b.each, labelKey: 'automations.mismatch.choice_keep_table', labelEn: 'Keep the whole table', preview: null },
    ];
    return { shape, count: n, primary, more, defaultId: 'table' };
}

/** The remedies for a value that does not fit its slot, per its ACTUAL kind. */
export function remediesFor(
    path: unknown,
    sampleRoot: unknown,
    { allowForEach = false, itemVar = undefined, actualKind = undefined }: ForEachOpts & { actualKind?: string } = {},
): Remedies {
    const p = String(path || '').trim();
    const kind = actualKind || kindAtPath(p, sampleRoot);
    if (kind === 'group') return groupRemedies(p, sampleRoot);
    if (kind === 'table') return tableRemedies(p, sampleRoot, { allowForEach, itemVar });
    return listRemedies(p, sampleRoot, { allowForEach, itemVar });
}

function kindWord(kind: unknown, fallback: FieldKind, tr: Translate): string {
    const own = typeof kind === 'string' && Object.hasOwn(KIND_WORD, kind) ? KIND_WORD[kind as FieldKind] : null;
    const entry = own || KIND_WORD[fallback];
    return tr(entry.key, own ? entry.en : fallback === 'text' ? 'text' : entry.en);
}

/** "<field> is a list of 3, this needs one text. What do you want?" — words, never types. */
export function mismatchSentence(
    { actualKind, expectedKind, count }: { actualKind?: unknown; expectedKind?: unknown; count?: number | null },
    t: Translate | null = null,
): string {
    const tr = translatorOr(t);
    const params = { actual: kindWord(actualKind, 'unknown', tr), expected: kindWord(expectedKind, 'text', tr) };
    if (actualKind === 'group') {
        return tr('automations.mismatch.group_into_one', 'is a {actual}, this needs one {expected}. Pick a field inside it.', params);
    }
    if (actualKind === 'table') {
        return count != null
            ? tr('automations.mismatch.table_into_one_n', 'is a {actual} of {n} rows, this needs one {expected}. It can go in as a table.', { ...params, n: count })
            : tr('automations.mismatch.table_into_one', 'is a {actual}, this needs one {expected}. It can go in as a table.', params);
    }
    return count != null
        ? tr('automations.mismatch.list_into_one_n', 'is a {actual} of {n}, this needs one {expected}. What do you want?', { ...params, n: count })
        : tr('automations.mismatch.list_into_one', 'is a {actual}, this needs one {expected}. What do you want?', params);
}

/** The kind a picked path resolves to right now (for the gate). */
export function kindAtPath(path: unknown, sampleRoot: unknown): FieldKind {
    if (!path || !sampleRoot) return 'unknown';
    return kindOfValue(walkPath(String(path), sampleRoot));
}
