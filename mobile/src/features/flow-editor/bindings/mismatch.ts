/**
 * mismatch — "it doesn't fit one-to-one, so ask in plain words". When a picked
 * field is a LIST, a TABLE or a GROUP and the slot wants ONE value, the editor
 * writes a sensible default at once and offers the other readings under the
 * field. Every remedy is a bare ref or a call the shared engine really runs.
 * Port of agent-hub `Builder/mapping/mismatch.js`; pinned by
 * mapping.lockstep.test.ts.
 */

import { appendKey, appendWildcard, parsePath } from '@/shared/expr';
import { humanizeFieldKey } from '@/shared/lib/humanizeKey';

import { type FieldKind, isScalarKind, KIND_WORD, kindOfValue, translatorOr } from './fieldKinds';
import { bindingsForList, forEachPickFor, type ListShape, pathListShape, previewForEachPick } from './listShape';
import type { Binding, ForEach, Translate } from './types';
import { canonicalRefPath, previewValue, walkPath } from './walkPath';

const keyName = (key: string) => humanizeFieldKey(key) || key;

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
 * A GROUP into one value: its own fields as buttons (every key, written with
 * the shared canonical writer — `["content-type"]`, JSON-escaped — so the run
 * resolves each), the readable summary as the default.
 */
function groupRemedies(p: string, sampleRoot: unknown): Remedies {
    const value = walkPath(p, sampleRoot);
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const keys = Object.keys(obj);
    const fieldRemedy = (key: string): Remedy => ({
        id: `field:${key}`,
        binding: { kind: 'ref', path: appendKey(p, key) },
        labelKey: 'automations.mismatch.choice_field', labelEn: '{field}', labelParams: { field: keyName(key) },
        preview: show(obj[key]),
    });
    const first = keys[0];
    const summary: Remedy = {
        id: 'summary', binding: { kind: 'expr', value: `groupSummary(${p})` },
        labelKey: 'automations.mismatch.choice_summary', labelEn: 'The whole group, as a readable summary',
        preview: first !== undefined ? `${keyName(first)}: ${show(obj[first])}…` : null,
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
        { id: 'table', binding: { kind: 'expr', value: `asTable(${p})` }, labelKey: 'automations.mismatch.choice_as_table', labelEn: 'As a table', preview: cols.length ? cols.slice(0, 4).map(keyName).join(' | ') : null },
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
    // Canonical: every remedy is a formula over this path, and the engine
    // reads only the canonical spelling as the same path.
    const p = canonicalRefPath(String(path || '').trim());
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

/**
 * The path of ONE column of the table at `path`, as the run reads it: by
 * plain key when the table is reached through `[*]` and each element is a
 * record (`value[*].from.emailAddress`), through `[*]` otherwise.
 */
export function columnPath(path: unknown, key: string, sampleRoot: unknown): string {
    const p = canonicalRefPath(String(path || '').trim());
    if ((parsePath(p) || []).some((t) => t.type === 'wild')) {
        const direct = appendKey(p, key);
        const v = walkPath(direct, sampleRoot);
        if (Array.isArray(v) && v.length) return direct;
    }
    return appendKey(appendWildcard(p), key);
}

const norm = (x: unknown) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The slot a table or a record is dropped on: its name and the single-value kind it wants. */
interface SlotOpts {
    slot?: string | null;
    expectedKind?: string | null;
}

/**
 * A TABLE dropped on a slot that wants one value: which column did the author
 * mean? The slot's own name decides first, then a lone column of the wanted
 * kind (not for text). null when it is not clear.
 */
export function columnForSlot(path: unknown, sampleRoot: unknown, { slot = null, expectedKind = 'text' }: SlotOpts = {}): string | null {
    if (!path) return null;
    const rows = walkPath(String(path), sampleRoot);
    const first = Array.isArray(rows) ? (rows.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown> | undefined) : undefined;
    if (!first) return null;
    const cols = Object.keys(first);
    const want = norm(slot);
    const pickPath = (c: string) => columnPath(path, c, sampleRoot);
    if (want) {
        const exact = cols.find((c) => norm(c) === want);
        if (exact) return pickPath(exact);
        const tail = cols.filter((c) => norm(c) && want.endsWith(norm(c))).sort((a, b) => norm(b).length - norm(a).length)[0];
        if (tail) return pickPath(tail);
    }
    if (!expectedKind || expectedKind === 'text' || expectedKind === 'unknown') return null;
    const ofKind = cols.filter((c) => kindOfValue(first[c]) === expectedKind);
    return ofKind.length === 1 ? pickPath(ofKind[0] as string) : null;
}

const HEADLINE_KEYS = ['name', 'title', 'subject', 'displayName', 'label', 'filename', 'fileName'];

/** The record at `path`, or null. */
function recordAt(path: unknown, sampleRoot: unknown): Record<string, unknown> | null {
    const rec = path ? walkPath(String(path), sampleRoot) : undefined;
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? (rec as Record<string, unknown>) : null;
}

/** The field the slot's NAME points at: exact, the longest tail, or a headline for a title slot. */
function fieldByName(obj: Record<string, unknown>, keys: string[], want: string): string | undefined {
    const exact = keys.find((k) => norm(k) === want);
    if (exact) return exact;
    const tail = keys.filter((k) => norm(k).length > 1 && want.endsWith(norm(k))).sort((a, b) => norm(b).length - norm(a).length)[0];
    if (tail) return tail;
    if (!/(title|name|subject|label|heading)$/.test(want)) return undefined;
    return HEADLINE_KEYS.find((h) => keys.includes(h) && typeof obj[h] === 'string');
}

/**
 * A GROUP (one record) dropped on a slot that wants one value: which field of
 * it did the author mean? Slot name first, a headline for a title/name slot,
 * then a lone field of the wanted kind (not for text). null when unclear.
 */
export function fieldForSlot(path: unknown, sampleRoot: unknown, opts: SlotOpts = {}): string | null {
    const obj = recordAt(path, sampleRoot);
    if (!obj) return null;
    const keys = Object.keys(obj).filter((k) => obj[k] == null || typeof obj[k] !== 'object');
    if (!keys.length) return null;
    const pick = (k: string) => appendKey(canonicalRefPath(String(path)), k);
    const want = norm(opts.slot);
    const named = want ? fieldByName(obj, keys, want) : undefined;
    if (named) return pick(named);
    const expectedKind = opts.expectedKind === undefined ? 'text' : opts.expectedKind;
    if (!expectedKind || expectedKind === 'text' || expectedKind === 'unknown') return null;
    const ofKind = keys.filter((k) => kindOfValue(obj[k]) === expectedKind);
    return ofKind.length === 1 ? pick(ofKind[0] as string) : null;
}

/**
 * Which remedy to apply WITHOUT asking: a value from inside each row into a
 * step that can run per item → one run per row; a list into text or e-mail →
 * comma separated; into a number, date, yes/no or choice → the first; a
 * table or a group → their own defaults. Always one of `remedies`' own ids.
 */
export function quietDefaultId(
    remedies: Pick<Remedies, 'primary' | 'more' | 'defaultId'> | null | undefined,
    { path, actualKind, expectedKind }: { path?: unknown; actualKind?: unknown; expectedKind?: unknown },
): string | undefined {
    const has = (id: string) => [...(remedies?.primary || []), ...(remedies?.more || [])].some((r) => r.id === id && !r.disabled);
    const isColumn = String(path || '').includes('[*]');
    if (actualKind === 'list' || actualKind === 'table') {
        if (isColumn && has('foreach')) return 'foreach';
    }
    if (actualKind === 'list') {
        if ((expectedKind === 'text' || expectedKind === 'email') && has('join_comma')) return 'join_comma';
        if (has('first')) return 'first';
    }
    return remedies?.defaultId;
}

export interface PickDecision {
    /** The path that goes in (a table's column or a record's field when the slot says which). */
    path: string;
    actualKind: FieldKind | null;
    expectedKind: string | null;
    /** Written without asking when the pick does not fit; null = insert `path` as it is. */
    remedy: Remedy | null;
    remedies: Remedies | null;
}

export interface PickOpts {
    slot?: string | null;
    expectKind?: string | null;
    expectShape?: string | null;
    allowForEach?: boolean;
}

/** A table on a slot means a named column, a record a named field — when the slot says which. */
function narrowPick(path: string, sampleRoot: unknown, opts: PickOpts): { path: string; actualKind: FieldKind } {
    const slotOpts = { slot: opts.slot ?? null, expectedKind: opts.expectKind ?? null };
    const kind = kindAtPath(path, sampleRoot);
    const narrowed = kind === 'table' ? columnForSlot(path, sampleRoot, slotOpts)
        : kind === 'group' ? fieldForSlot(path, sampleRoot, slotOpts)
        : null;
    return narrowed ? { path: narrowed, actualKind: kindAtPath(narrowed, sampleRoot) } : { path, actualKind: kind };
}

/** The remedy written without asking: the quiet default, else the remedies' own default. */
function quietRemedy(remedies: Remedies, ctx: { path: string; actualKind: FieldKind; expectedKind: string }): Remedy | null {
    const all = [...remedies.primary, ...remedies.more];
    const quiet = quietDefaultId(remedies, ctx);
    return all.find((r) => r.id === quiet) || all.find((r) => r.id === remedies.defaultId) || remedies.primary[0] || null;
}

/**
 * The pick decision for a slot that wants ONE value — the web's
 * mapping/proposePick.ts proposePickBinding, so a pick on the phone stores the binding the
 * web's value builder stores: a list into text joined, into a number its
 * first, a table's named column, a record's named field or summary.
 */
export function proposePickBinding(path: unknown, sampleRoot: unknown, opts: PickOpts = {}): PickDecision {
    const clean = canonicalRefPath(String(path || '').trim());
    if (!clean || opts.expectShape !== 'scalar') return { path: clean, actualKind: null, expectedKind: null, remedy: null, remedies: null };
    const { path: picked, actualKind } = narrowPick(clean, sampleRoot, opts);
    const expectedKind = opts.expectKind && opts.expectKind !== 'unknown' ? opts.expectKind : 'text';
    const decided: PickDecision = { path: picked, actualKind, expectedKind, remedy: null, remedies: null };
    const mm = detectMismatch({ actualKind, expectedKind });
    if (!mm || (mm.code === 'list_into_one' && !pathListShape(picked, sampleRoot))) return decided;
    const remedies = remediesFor(picked, sampleRoot, { allowForEach: !!opts.allowForEach, actualKind });
    return { ...decided, remedy: quietRemedy(remedies, { path: picked, actualKind, expectedKind }), remedies };
}
