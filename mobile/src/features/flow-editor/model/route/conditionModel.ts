/**
 * The datatype-aware condition model behind the clickable rule builder — a
 * port of the web builder's utils/conditionModel.js, pinned by
 * route.lockstep.test.ts.
 *
 * A condition is `rows` joined by one boolean `join` ('&&' | '||'); each row
 * is `{ field, op, value }` — two bindings and an operator key — plus, for a
 * column of a list inside the item ("any attachment · Mime type"), the
 * `quantifier` that says which entries must pass. Rows serialise to the
 * restricted expression the server evaluates (@/shared/expr);
 * ./conditionParse.ts reads an expression back into rows.
 *
 * Text "is" / "is not" write `equals()`, which ignores upper/lower case and
 * surrounding spaces; a saved `==` on text keeps its meaning and reads "is
 * exactly (same upper/lower case)" on that row only.
 */

import { appendKey, fieldShape, quantifiedCall, TEST_OF_OP, UNARY_TESTS } from '@/shared/expr';

import { canonicalRefPath } from '../pathGrammar';
import type { Binding, Translate } from '../types';
import { renderBindingValue } from './bindingText';

export type ValueType = 'unknown' | 'array' | 'records' | 'number' | 'boolean' | 'object' | 'date' | 'string' | 'fileType';

export type Quantifier = 'any' | 'every' | 'none';

export interface ConditionRow {
    field: Binding | string | null;
    op: string;
    value: Binding | unknown;
    /** Which entries of a list column must pass: "any attachment · Mime type contains pdf". */
    quantifier?: Quantifier;
    /** A saved `x == ""` keeps round-tripping; a fresh row with no value is never saved. */
    keepBlank?: true;
}

export interface ConditionRows {
    rows: ConditionRow[];
    join: '&&' | '||';
}

/** ISO-8601-ish text: surfaced as 'date' so comparators read "is before/after". */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;

const isPlainObject = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

/** A coarse datatype from a sample value, to pick which operators to offer. */
export function inferType(value: unknown): ValueType {
    if (value == null) return 'unknown';
    if (Array.isArray(value)) {
        const first = value.find((v) => v != null);
        return isPlainObject(first) ? 'records' : 'array';
    }
    const t = typeof value;
    if (t === 'number' || t === 'boolean' || t === 'object') return t;
    if (t === 'string') return ISO_DATE_RE.test((value as string).trim()) ? 'date' : 'string';
    return 'unknown';
}

interface Operator {
    key: string;
    kind: 'cmp' | 'fn' | 'unary';
    symbol?: string;
    fn?: string;
    negate?: boolean;
    emit?: (left: string) => string;
}

const OPERATORS: readonly Operator[] = [
    { key: 'is', kind: 'fn', fn: 'equals' },
    { key: 'isNot', kind: 'fn', fn: 'equals', negate: true },
    { key: 'eq', kind: 'cmp', symbol: '==' },
    { key: 'neq', kind: 'cmp', symbol: '!=' },
    { key: 'gt', kind: 'cmp', symbol: '>' },
    { key: 'gte', kind: 'cmp', symbol: '>=' },
    { key: 'lt', kind: 'cmp', symbol: '<' },
    { key: 'lte', kind: 'cmp', symbol: '<=' },
    // Strict equality: never offered, kept so `===` round-trips.
    { key: 'seq', kind: 'cmp', symbol: '===' },
    { key: 'sneq', kind: 'cmp', symbol: '!==' },
    { key: 'contains', kind: 'fn', fn: 'contains' },
    { key: 'notContains', kind: 'fn', fn: 'contains', negate: true },
    { key: 'startsWith', kind: 'fn', fn: 'startsWith' },
    { key: 'endsWith', kind: 'fn', fn: 'endsWith' },
    { key: 'isEmpty', kind: 'unary', emit: (l) => `isEmpty(${l})` },
    { key: 'isNotEmpty', kind: 'unary', emit: (l) => `!isEmpty(${l})` },
    { key: 'isTrue', kind: 'unary', emit: (l) => `${l} == true` },
    { key: 'isFalse', kind: 'unary', emit: (l) => `${l} == false` },
    // "has a value": a bare field, emitted verbatim so a bare-path expr round-trips.
    { key: 'truthy', kind: 'unary', emit: (l) => l },
];

const OP_BY_KEY = new Map(OPERATORS.map((o) => [o.key, o]));

export function getOperator(key: string | null | undefined): Operator | null {
    return (key && OP_BY_KEY.get(key)) || null;
}

export function isUnaryOp(key: string | null | undefined): boolean {
    return getOperator(key)?.kind === 'unary';
}

const TYPE_OPS: Record<ValueType, string[]> = {
    string: ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty', 'truthy'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy'],
    boolean: ['isTrue', 'isFalse', 'eq', 'neq', 'truthy'],
    date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy'],
    array: ['contains', 'notContains', 'isEmpty', 'isNotEmpty', 'truthy'],
    records: ['isNotEmpty', 'isEmpty'],
    object: ['eq', 'neq', 'isEmpty', 'isNotEmpty', 'truthy'],
    fileType: ['is', 'isNot'],
    unknown: ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'gt', 'lt', 'isEmpty', 'isNotEmpty', 'truthy'],
};

/** The English of every label key (`condition_node.op.<key>`), the dictionary's words. */
const OP_LABELS: Record<string, string> = {
    is: 'is', isNot: 'is not', eq: 'equals', neq: 'does not equal',
    eq_text: 'is exactly (same upper/lower case)', neq_text: 'is not exactly (same upper/lower case)',
    gt: 'greater than', gte: 'greater than or equal', lt: 'less than', lte: 'less than or equal',
    eq_date: 'is on', gt_date: 'is after', gte_date: 'is on or after', lt_date: 'is before', lte_date: 'is on or before',
    contains: 'contains', notContains: 'does not contain', startsWith: 'starts with', endsWith: 'ends with',
    isEmpty: 'is empty', isNotEmpty: 'is not empty', isEmpty_records: 'has none', isNotEmpty_records: 'has at least one',
    isTrue: 'is true', isFalse: 'is false', truthy: 'has a value', seq: 'strictly equals', sneq: 'strictly does not equal',
};

const DATE_KEYS = new Set(['eq', 'gt', 'gte', 'lt', 'lte']);

/** The label key's suffix for an operator on a datatype: "is after" on a date, "has none" on a list of records. */
function labelVariant(key: string, type: string): string {
    if (type === 'date' && DATE_KEYS.has(key)) return '_date';
    if ((type === 'string' || type === 'unknown') && (key === 'eq' || key === 'neq')) return '_text';
    if (type === 'records' && (key === 'isEmpty' || key === 'isNotEmpty')) return '_records';
    return '';
}

/** An operator's label for a datatype, under `condition_node.op.<key>[_variant]`. */
export function labelFor(key: string, type: string, t: Translate | null = null): string {
    if (!OP_BY_KEY.has(key)) return key;
    const labelKey = `${key}${labelVariant(key, type)}`;
    const english = OP_LABELS[labelKey] ?? key;
    return t ? t(`condition_node.op.${labelKey}`, english) : english;
}

export interface OperatorOptions {
    /** A quantified row ("any attachment · …") offers only the tests a quantifier can run. */
    quantified?: boolean;
    t?: Translate | null;
}

/**
 * Operator options for a datatype. `currentKey` is always offered (even when
 * off-type) so a parsed operator stays selectable — on that row only.
 */
export function operatorsForType(type: string, currentKey: string | null = null, { quantified = false, t = null }: OperatorOptions = {}): { key: string; label: string }[] {
    let list = (TYPE_OPS[type as ValueType] || TYPE_OPS.unknown).slice();
    if (quantified) list = list.filter((k) => Object.prototype.hasOwnProperty.call(TEST_OF_OP, k));
    if (currentKey && !list.includes(currentKey)) list.push(currentKey);
    return list
        .map((k) => OP_BY_KEY.get(k))
        .filter((o): o is Operator => !!o)
        .map((o) => ({ key: o.key, label: labelFor(o.key, type, t) }));
}

function leftFragment(field: ConditionRow['field']): string {
    if (!field || typeof field !== 'object') return String(field || '').trim();
    if (field.kind === 'ref') return String(field.path || '').trim();
    if (field.kind === 'expr') return String(field.value || '').trim();
    if (field.kind === 'literal') return renderBindingValue(field);
    return '';
}

/** Nothing filled in yet: an explicit `null` is a value (`== null` asks about absence). */
export function isBlankValue(v: unknown): boolean {
    if (!v || typeof v !== 'object') return v === undefined || v === '';
    const b = v as { kind?: string; value?: unknown; path?: unknown };
    if (b.kind === 'literal') return b.value === undefined || b.value === '';
    if (b.kind === 'ref') return !String(b.path || '').trim();
    return !String(b.value ?? '').trim();
}

/** One row as an expression fragment, or '' while it is incomplete. */
export function serializeRow(row: ConditionRow | null | undefined): string {
    if (!row) return '';
    const op = getOperator(row.op) || (OP_BY_KEY.get('eq') as Operator);
    const left = leftFragment(row.field);
    if (!left) return '';
    if (row.quantifier) return serializeQuantified(row, op, left);
    if (op.kind === 'unary') return (op.emit as (l: string) => string)(left);
    // An unfinished row is never saved as `field == ""`; only a saved one keeps that shape.
    if (isBlankValue(row.value) && !row.keepBlank) return '';
    const rhs = renderBindingValue(row.value);
    if (op.kind === 'fn') return `${op.negate ? '!' : ''}${op.fn}(${left}, ${rhs})`;
    return `${left} ${op.symbol} ${rhs}`;
}

/** `anyOf(item.attachments[*].mimeType, "contains", "pdf")`: every entry of the list checked. */
function serializeQuantified(row: ConditionRow, op: Operator, left: string): string {
    const unary = (UNARY_TESTS as readonly string[]).includes((TEST_OF_OP as Record<string, string>)[op.key] as string);
    if (!unary && isBlankValue(row.value) && !row.keepBlank) return '';
    return quantifiedCall(row.quantifier as Quantifier, left, op.key, unary ? null : renderBindingValue(row.value));
}

/** Rows joined by `join`; incomplete rows are dropped. */
export function serializeRows(rows: readonly ConditionRow[] | null | undefined, join: string = '&&'): string {
    const j = join === '||' ? '||' : '&&';
    return (rows || []).map(serializeRow).filter(Boolean).join(` ${j} `);
}

/** A blank row for the "add condition" affordance. */
export function emptyRow(): ConditionRow {
    return { field: { kind: 'ref', path: '' }, op: 'is', value: { kind: 'literal', value: '' } };
}

const pathOf = (row: ConditionRow): string => {
    const f = row.field;
    return f && typeof f === 'object' && f.kind === 'ref' ? String(f.path || '') : '';
};

type Walk = (path: string, root: unknown) => unknown;

/**
 * The row's field datatype: a column reads the type of its first entry, a
 * File type is 'fileType', anything else the type of the sample it resolves to.
 */
export function rowType(row: ConditionRow, sampleRoot: unknown, walk: Walk): ValueType {
    const path = pathOf(row);
    const shape = path ? fieldShape(path) : null;
    if (shape?.kind === 'fileRecord' || shape?.kind === 'fileList') return 'fileType';
    if (!path || sampleRoot == null || typeof walk !== 'function') return 'unknown';
    const value = walk(path, sampleRoot);
    if (shape?.kind === 'column') return inferType(Array.isArray(value) ? value.find((v) => v != null) : value);
    return inferType(value);
}

/** Is this field a list column or the File type of a list — a row that needs a quantifier? */
export function isQuantifiedField(path: string): boolean {
    const kind = fieldShape(path)?.kind;
    return kind === 'column' || kind === 'fileList';
}

/**
 * The row after its field is picked: the operator stays when the new field
 * offers it, else the first one offered; a column starts at "any", a plain
 * field has no quantifier.
 */
export function rowForField(row: ConditionRow, field: Binding, type: ValueType): ConditionRow {
    const path = field.kind === 'ref' ? String(field.path || '') : '';
    const quantified = isQuantifiedField(path);
    const offered = operatorsForType(type, null, { quantified }).map((o) => o.key);
    const { quantifier: _q, keepBlank: _k, ...rest } = row || emptyRow();
    const op = offered.includes(rest.op) ? rest.op : (offered[0] as string);
    // R2: a value typed for another field never becomes a File type ("pdf" from
    // a Mime type row would pick PDF unasked), nor a File type key a text value.
    if (isFileTypePath(field) !== isFileTypePath(rest.field)) rest.value = { kind: 'literal', value: '' };
    return quantified ? { ...rest, field, op, quantifier: 'any' } : { ...rest, field, op };
}

const isFileTypePath = (binding: unknown): boolean => {
    const b = binding as { kind?: unknown; path?: unknown } | null | undefined;
    return b?.kind === 'ref' && String(b.path || '').startsWith('fileType(');
};

// "No attachment is a PDF" on each attachment is "it is not a PDF".
const NEGATED: Record<string, string> = {
    is: 'isNot', isNot: 'is', eq: 'neq', neq: 'eq', contains: 'notContains', notContains: 'contains',
    isEmpty: 'isNotEmpty', isNotEmpty: 'isEmpty', gt: 'lte', lte: 'gt', gte: 'lt', lt: 'gte',
};

/** A quantified row over the list at `list`, re-rooted on the list's own entry; null when it cannot be. */
function rowOnEntry(row: ConditionRow, list: string): ConditionRow | null {
    const path = pathOf(row);
    const shape = row.quantifier && path ? fieldShape(path) : null;
    if (!shape || (shape.kind !== 'column' && shape.kind !== 'fileList') || canonicalRefPath(shape.list) !== list) return null;
    const head = `${list}[*]`;
    if (shape.kind === 'column' && !shape.path.startsWith(head)) return null;
    const field: Binding = { kind: 'ref', path: shape.kind === 'fileList' ? 'fileType(item)' : `item${shape.path.slice(head.length)}` };
    const { quantifier, ...rest } = row;
    if (quantifier !== 'none') return { ...rest, field };
    const negated = NEGATED[rest.op];
    return negated ? { ...rest, field, op: negated } : null;
}

/** Does this field read a key of the (old) item? `fileType(item)` reads the item itself. */
const readsItemKey = (path: string): boolean => ['item.', 'item[', 'fileType(item.', 'fileType(item['].some((head) => path.startsWith(head));

/**
 * The rows after the list moved one level in (L → L[*].<listKey>): a row that
 * checked the inner list ("any attachment · File type is PDF") checks the
 * item itself ("File type is PDF"); a row the new item cannot read is kept,
 * and its field listed in `unfit` — nothing goes without the author's click.
 */
export function deepenRows(rows: readonly ConditionRow[], listKey: string): { rows: ConditionRow[]; unfit: string[] } {
    const list = appendKey('item', listKey);
    const unfit: string[] = [];
    const out = (rows || []).map((row) => {
        const moved = rowOnEntry(row, list);
        if (moved) return moved;
        const path = pathOf(row);
        if (path && readsItemKey(path) && !unfit.includes(path)) unfit.push(path);
        return row;
    });
    return { rows: out, unfit };
}
