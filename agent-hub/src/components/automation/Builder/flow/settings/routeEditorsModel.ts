/**
 * The pure half of the Condition editor's list handling (RouteFields):
 * the field menu of a rule row, what happens to the rules when the list
 * changes (R11), removing the rules the new item cannot read, and turning a
 * whole-run Condition that reads a list into one that works through it
 * (BFSF-485 F3). Rules are read and written with the row model
 * (utils/conditionModel.js), so a rule the rows cannot show is left as it is.
 */
import { appendKey, appendWildcard, parsePath } from '@shared/expr/path.mjs';
import { rebaseRefs } from '@shared/expr/routeFollow.mjs';
import { isFileRecord, ruleFieldOptions, singularKey } from '@shared/expr/rules.mjs';
import { sampleToFields } from '../../mapping/upstream';
import { deepenRows, parseExprToRows, serializeRows } from '../../utils/conditionModel';
import { humanizeFieldKey, humanizeFieldTail } from '../displayHelpers';

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;
type Tok = { type: string; key?: string | number };
type Row = { field?: { kind?: string; path?: unknown } };

export interface RouteRule {
    name: string;
    expr: string;
    value: unknown;
}

export interface FieldOption {
    path: string;
    label: string;
    sample: unknown;
    group: string;
    quantified?: true;
    kind?: 'records' | 'fileType';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The last named key of a path (`messages[*].attachments` → `attachments`); null when there is none. */
function lastKeyOf(path: string): string | null {
    const tokens = (parsePath(path) || []) as Tok[];
    for (let i = tokens.length - 1; i >= 0; i--) {
        const k = tokens[i].type === 'prop' ? tokens[i].key : null;
        if (typeof k === 'string' && k) return k;
    }
    return null;
}

/** One item of the list as the editor names it: "message" for `…messages`, "item" when unknown. */
export function itemNameOf(source: string | null | undefined): string {
    const key = typeof source === 'string' ? lastKeyOf(source) : null;
    if (!key || key === 'output' || key === 'items') return 'item';
    return (humanizeFieldKey(singularKey(key)) || 'item').toLowerCase();
}

/** What the sample rows of a list are called (P3): "messages" for `…messages`, "items" when unknown. */
export function listUnitOf(source: string | null | undefined): string {
    const key = typeof source === 'string' ? lastKeyOf(source) : null;
    if (!key || key === 'output' || key === 'items') return 'items';
    return (humanizeFieldKey(key) || 'items').toLowerCase();
}

/**
 * The rule row's field menu in list mode (R1): the item's fields, a list of
 * records once ("has at least one / has none"), then a group per list of
 * records with File type first and its columns (quantified).
 */
export function ruleFieldMenu(element: unknown, itemName: string, t: Translate): FieldOption[] {
    if (!isPlainObject(element)) return [];
    const group = (kind: string, vars: Record<string, unknown>) => {
        if (kind === 'inner') return t('condition_node.group.inner_list', '{list} of each {name}', vars);
        if (kind === 'parent') return t('condition_node.group.parent', 'The {name} it came from', vars);
        return t('condition_node.group.item', 'Fields of each {name}', vars);
    };
    return ruleFieldOptions(sampleToFields(element, 'item'), {
        element,
        name: humanizeFieldKey,
        group,
        itemName,
        fileTypeLabel: t('condition_node.file_type.label', 'File type'),
    }) as FieldOption[];
}

const rowPath = (row: Row): string => (row?.field?.kind === 'ref' ? String(row.field.path || '') : '');

/** The path inside `fileType(…)`, or the path itself. */
const innerPath = (path: string): string => (path.startsWith('fileType(') && path.endsWith(')') ? path.slice(9, -1) : path);

/** Can the item `element` give this field? `null` when the field does not read the item. */
function itemHasField(path: string, element: unknown): boolean | null {
    const tokens = parsePath(innerPath(path)) as Tok[] | null;
    if (!tokens || tokens[0]?.key !== 'item') return null;
    if (tokens.length === 1) return path.startsWith('fileType(') ? isFileRecord(element) : true;
    const key = tokens[1].type === 'prop' ? tokens[1].key : null;
    if (key == null || !isPlainObject(element)) return null;
    return Object.prototype.hasOwnProperty.call(element, String(key));
}

/** `next` is `prev` one level in (`L` → `L[*].k`): the `k`, else null. */
function deeperKey(prev: string, next: string): string | null {
    const a = parsePath(prev) as Tok[] | null;
    const b = parsePath(next) as Tok[] | null;
    if (!a || !b || b.length !== a.length + 2) return null;
    if (b[a.length].type !== 'wild' || b[a.length + 1].type !== 'prop') return null;
    const same = a.every((tok, i) => tok.type === b[i].type && tok.key === b[i].key);
    const k = b[a.length + 1].key;
    return same && typeof k === 'string' ? k : null;
}

/** Fields the rows read that `element` lacks (only when the element is known). */
function unfitPaths(rows: Row[], element: unknown): string[] {
    if (element == null) return [];
    const out: string[] = [];
    for (const row of rows) {
        const path = rowPath(row);
        if (path && itemHasField(path, element) === false && !out.includes(path)) out.push(path);
    }
    return out;
}

/**
 * The rules after the list changed from `prev` to `next` (R11). One level in:
 * rows quantified over that inner list become rows on its entry. Rows the new
 * item cannot read are kept and their fields returned in `unfit`, so the editor
 * can name them and offer their removal. Nothing is dropped here.
 */
export function rulesForSource(rules: RouteRule[], prev: string, next: string, element: unknown): { rules: RouteRule[]; unfit: string[] } {
    const key = deeperKey(prev, next);
    const unfit: string[] = [];
    const out = rules.map((r) => {
        const parsed = parseExprToRows(r.expr) as { rows: Row[]; join: string } | null;
        if (!parsed) return r;
        let rows = parsed.rows;
        let missing: string[];
        if (key) {
            const d = deepenRows(rows, key) as { rows: Row[]; unfit: string[] };
            rows = d.rows;
            missing = element == null ? d.unfit : unfitPaths(rows, element);
        } else {
            missing = unfitPaths(rows, element);
        }
        for (const p of missing) if (!unfit.includes(p)) unfit.push(p);
        return key ? { ...r, expr: serializeRows(rows, parsed.join) } : r;
    });
    return { rules: out, unfit };
}

/** The rules without the rows that read one of `paths` ("Remove those rules"). */
export function withoutRowsReading(rules: RouteRule[], paths: string[]): RouteRule[] {
    return rules.map((r) => {
        const parsed = parseExprToRows(r.expr) as { rows: Row[]; join: string } | null;
        if (!parsed) return r;
        const kept = parsed.rows.filter((row) => !paths.includes(rowPath(row)));
        return kept.length === parsed.rows.length ? r : { ...r, expr: serializeRows(kept, parsed.join) };
    });
}

/** A field path as a person reads it: `item.from` → "From", `fileType(item)` → "File type". */
export function fieldNameOf(path: string, t: Translate): string {
    if (path.startsWith('fileType(')) return t('condition_node.file_type.label', 'File type');
    const tail = path.startsWith('item.') ? path.slice(5) : path;
    return humanizeFieldTail(tail) || tail;
}

// A key no step output carries: `list` is first rebased onto `item.<this>`, so
// the row model's own one-level-in move (deepenRows) can re-root its rows.
const EACH_KEY = '__each_of_list__';

/**
 * One rule rebased from the whole-run `list` onto its item. Through the row
 * model first, so a quantified row ("any subject contains isv", "no file is
 * a PDF") becomes the plain row on `item` the rows can show, never a formula
 * the rows cannot read (`anyOf(item.subject, …)`). A rule the rows cannot
 * show, or a row that cannot move (a `none` whose operator has no negation),
 * falls back to rebasing the text.
 */
function ruleOnItem(expr: string, list: string): { expr: string; changed: boolean } {
    const viaText = rebaseRefs(expr, appendWildcard(list), 'item') as { value: string; changed: boolean };
    const holder = appendKey('item', EACH_KEY);
    const staged = rebaseRefs(expr, list, holder) as { value: string; changed: boolean };
    const parsed = staged.changed ? parseExprToRows(staged.value) as { rows: Row[]; join: string } | null : null;
    if (!parsed) return { expr: viaText.value, changed: viaText.changed };
    const moved = (deepenRows(parsed.rows, EACH_KEY) as { rows: Row[] }).rows;
    const out = rebaseRefs(serializeRows(moved, parsed.join), appendWildcard(holder), 'item').value as string;
    if (out.includes(EACH_KEY)) return { expr: viaText.value, changed: viaText.changed };
    return { expr: out, changed: true };
}

/**
 * "Check each item instead" (BFSF-485 F3): the whole-run route reading `list`
 * becomes a route that works through it, every rule moved from `list[*]`
 * onto `item` (ruleOnItem). One route patch, so one edit and one Undo.
 * Null when no rule reads an item of `list` (`contains(labels, "urgent")`
 * asks about the list as a whole): working through the list would give a
 * rule that never reads the item, so it keeps or drops every item alike.
 */
export function workThroughListPatch(rules: RouteRule[], list: string): { mode: 'items'; source: string; rules: RouteRule[] } | null {
    const next = rules.map((r) => ({ rule: r, ...ruleOnItem(r.expr || '', list) }));
    if (!next.some((n) => n.changed)) return null;
    return {
        mode: 'items',
        source: list,
        rules: next.map((n) => (n.changed ? { ...n.rule, expr: n.expr } : n.rule)),
    };
}

// The names readRoute gives the one rule of a filter / an If: internal, never shown.
const INTERNAL_FIRST_NAMES = new Set(['keep', 'rule1']);

/**
 * The rules about to gain a port label (a second output, or the keep-rest
 * case): an internal first name becomes `firstName` ("Output 1", O3);
 * a name the author chose stays.
 */
export function withNamedFirst(rules: RouteRule[], firstName: string): RouteRule[] {
    if (!rules.length) return [{ name: firstName, expr: '', value: '' }];
    const [first, ...rest] = rules;
    if (!INTERNAL_FIRST_NAMES.has(first?.name) || rest.some((r) => r?.name === firstName)) return rules;
    return [{ ...first, name: firstName }, ...rest];
}
