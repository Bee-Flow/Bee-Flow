/**
 * The datatype-aware condition model behind the clickable rule builder — a
 * port of the web builder's utils/conditionModel.js, pinned by
 * route.lockstep.test.ts.
 *
 * A condition is `rows` joined by one boolean `join` ('&&' | '||'); each row
 * is `{ field, op, value }` — two bindings and an operator key. Rows
 * serialise to the restricted expression the server evaluates
 * (@/shared/expr); ./conditionParse.ts reads an expression back into rows.
 */

import type { Binding, Translate } from '../types';
import { renderBindingValue } from './bindingText';

export type ValueType = 'unknown' | 'array' | 'number' | 'boolean' | 'object' | 'date' | 'string';

export interface ConditionRow {
    field: Binding | string | null;
    op: string;
    value: Binding | unknown;
}

export interface ConditionRows {
    rows: ConditionRow[];
    join: '&&' | '||';
}

/** ISO-8601-ish text: surfaced as 'date' so comparators read "is before/after". */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;

/** A coarse datatype from a sample value, to pick which operators to offer. */
export function inferType(value: unknown): ValueType {
    if (value == null) return 'unknown';
    if (Array.isArray(value)) return 'array';
    const t = typeof value;
    if (t === 'number' || t === 'boolean' || t === 'object') return t;
    if (t === 'string') return ISO_DATE_RE.test((value as string).trim()) ? 'date' : 'string';
    return 'unknown';
}

interface Operator {
    key: string;
    kind: 'cmp' | 'fn' | 'unary';
    /** The English label, translated under `mobile.flow.op.<key>` (see `labelFor`). */
    en: string;
    symbol?: string;
    fn?: string;
    negate?: boolean;
    hidden?: boolean;
    emit?: (left: string) => string;
}

const OPERATORS: readonly Operator[] = [
    { key: 'eq', kind: 'cmp', symbol: '==', en: 'equals' },
    { key: 'neq', kind: 'cmp', symbol: '!=', en: 'does not equal' },
    { key: 'gt', kind: 'cmp', symbol: '>', en: 'greater than' },
    { key: 'gte', kind: 'cmp', symbol: '>=', en: 'greater than or equal' },
    { key: 'lt', kind: 'cmp', symbol: '<', en: 'less than' },
    { key: 'lte', kind: 'cmp', symbol: '<=', en: 'less than or equal' },
    // Strict equality: hidden from the menu, kept so `===` round-trips.
    { key: 'seq', kind: 'cmp', symbol: '===', en: 'strictly equals', hidden: true },
    { key: 'sneq', kind: 'cmp', symbol: '!==', en: 'strictly does not equal', hidden: true },
    { key: 'contains', kind: 'fn', fn: 'contains', en: 'contains' },
    { key: 'notContains', kind: 'fn', fn: 'contains', en: 'does not contain', negate: true },
    { key: 'startsWith', kind: 'fn', fn: 'startsWith', en: 'starts with' },
    { key: 'endsWith', kind: 'fn', fn: 'endsWith', en: 'ends with' },
    { key: 'isEmpty', kind: 'unary', en: 'is empty', emit: (l) => `isEmpty(${l})` },
    { key: 'isNotEmpty', kind: 'unary', en: 'is not empty', emit: (l) => `!isEmpty(${l})` },
    { key: 'isTrue', kind: 'unary', en: 'is true', emit: (l) => `${l} == true` },
    { key: 'isFalse', kind: 'unary', en: 'is false', emit: (l) => `${l} == false` },
    // "has a value": a bare field, emitted verbatim so a bare-path expr round-trips.
    { key: 'truthy', kind: 'unary', en: 'has a value', emit: (l) => l },
];

const OP_BY_KEY = new Map(OPERATORS.map((o) => [o.key, o]));

export function getOperator(key: string | null | undefined): Operator | null {
    return (key && OP_BY_KEY.get(key)) || null;
}

export function isUnaryOp(key: string | null | undefined): boolean {
    return getOperator(key)?.kind === 'unary';
}

const TYPE_OPS: Record<ValueType, string[]> = {
    string: ['eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty', 'truthy'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy'],
    boolean: ['isTrue', 'isFalse', 'eq', 'neq', 'truthy'],
    date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy'],
    array: ['contains', 'notContains', 'isEmpty', 'isNotEmpty', 'truthy'],
    object: ['eq', 'neq', 'isEmpty', 'isNotEmpty', 'truthy'],
    unknown: ['eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'gt', 'lt', 'isEmpty', 'isNotEmpty', 'truthy'],
};

const DATE_LABELS: Record<string, string> = {
    gt: 'is after', gte: 'is on or after', lt: 'is before', lte: 'is on or before', eq: 'is on',
};

/** An operator's label for a datatype ("greater than" reads "is after" on a date). */
export function labelFor(key: string, type: string, t: Translate | null = null): string {
    const o = OP_BY_KEY.get(key);
    if (!o) return key;
    const dated = type === 'date' && DATE_LABELS[key];
    const english = dated ? (DATE_LABELS[key] as string) : o.en;
    return t ? t(`mobile.flow.op.${key}${dated ? '_date' : ''}`, english) : english;
}

/**
 * Operator options for a datatype. `currentKey` is always offered (even when
 * hidden or off-type) so a parsed operator stays selectable.
 */
export function operatorsForType(type: string, currentKey: string | null = null, t: Translate | null = null): { key: string; label: string }[] {
    const keys = TYPE_OPS[type as ValueType] || TYPE_OPS.unknown;
    const list = keys.slice();
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

/** One row as an expression fragment, or '' while it is incomplete. */
export function serializeRow(row: ConditionRow | null | undefined): string {
    if (!row) return '';
    const op = getOperator(row.op) || (OP_BY_KEY.get('eq') as Operator);
    const left = leftFragment(row.field);
    if (!left) return '';
    if (op.kind === 'unary') return (op.emit as (l: string) => string)(left);
    const rhs = renderBindingValue(row.value);
    if (op.kind === 'fn') return `${op.negate ? '!' : ''}${op.fn}(${left}, ${rhs})`;
    return `${left} ${op.symbol} ${rhs}`;
}

/** Rows joined by `join`; incomplete rows are dropped. */
export function serializeRows(rows: readonly ConditionRow[] | null | undefined, join: string = '&&'): string {
    const j = join === '||' ? '||' : '&&';
    return (rows || []).map(serializeRow).filter(Boolean).join(` ${j} `);
}

/** A blank row for the "add condition" affordance. */
export function emptyRow(): ConditionRow {
    return { field: { kind: 'ref', path: '' }, op: 'eq', value: { kind: 'literal', value: '' } };
}
