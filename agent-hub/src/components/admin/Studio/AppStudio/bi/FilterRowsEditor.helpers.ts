import type { TranslateParams } from '@/hooks/useTranslation';
import type { FormulaValue, FilterValue, FilterField } from './FilterRowsEditor.types';

const filterOps = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { value: 'eq', label: t('studio_apps_bi.filter.op_eq', 'is') },
    { value: 'neq', label: t('studio_apps_bi.filter.op_neq', 'is not') },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'contains', label: t('studio_apps_bi.filter.op_contains', 'contains') },
    { value: 'notContains', label: t('studio_apps_dataread.op_not_contains', 'does not contain') },
    { value: 'startsWith', label: t('studio_apps_bi.filter.op_starts_with', 'starts with') },
    { value: 'endsWith', label: t('studio_apps_dataread.op_ends_with', 'ends with') },
    { value: 'in', label: t('studio_apps_bi.filter.op_in', 'is one of') },
    { value: 'notIn', label: t('studio_apps_dataread.op_not_in', 'is not one of') },
    { value: 'between', label: t('studio_apps_bi.filter.op_between', 'is between') },
    { value: 'isNull', label: t('studio_apps_bi.filter.op_is_null', 'is empty') },
    { value: 'isNotNull', label: t('studio_apps_bi.filter.op_is_not_null', 'is not empty') },
];

// Ops that match on text no matter what the column holds.
const TEXT_OPS = new Set(['contains', 'notContains', 'startsWith', 'endsWith']);

/**
 * Which ops each column type can carry. A saved op outside its list is always
 * re-offered (see opsFor) so an existing filter round-trips untouched, but the
 * picker never SUGGESTS "contains" for a yes/no column — which used to leave
 * `contains` set after a field switch and silently render a free-text box for a
 * boolean.
 */
const OPS_BY_TYPE: Record<string, string[]> = {
    bool: ['eq', 'neq', 'isNull', 'isNotNull'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn', 'isNull', 'isNotNull'],
    date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
    datetime: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
    select: ['eq', 'neq', 'in', 'notIn', 'contains', 'isNull', 'isNotNull'],
    multiselect: ['eq', 'neq', 'in', 'notIn', 'contains', 'isNull', 'isNotNull'],
};

const DEFAULT_OPS = ['eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'notIn', 'isNull', 'isNotNull'];

/** Columns whose `eq` is a text comparison, where upper/lower case can be ignored (`ci`). */
const CASE_TYPES = new Set(['text', 'long_text', 'email', 'url', 'phone']);

function canIgnoreCase(field: FilterField | null) {
    return !field?.type || CASE_TYPES.has(field.type);
}

/** Is "ignore upper and lower case" offered for this row? Only for an `is` over a text column, where the caller allows it. */
export function offersIgnoreCase(allowed: boolean, op: string, field: FilterField | null) {
    return allowed && op === 'eq' && canIgnoreCase(field);
}

/** The row with another operator: the case switch only means something on `is`, so it goes with any other. */
export function withOperator<R extends { ci?: boolean }>(row: R, op: string): R {
    if (op === 'eq') return row;
    const { ci: _ci, ...rest } = row;
    return rest as R;
}

export function allowedOps(field: FilterField | null) {
    return OPS_BY_TYPE[field?.type ?? ''] || DEFAULT_OPS;
}

/** The op list to offer, with the current op appended so it always round-trips. */
export function opsFor(field: FilterField | null, current: string, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    const allowed = allowedOps(field);
    const keys = allowed.includes(current) || !current ? allowed : [...allowed, current];
    return filterOps(t).filter((o) => keys.includes(o.value));
}

export function isFormulaValue(v: FilterValue) {
    return !!v && typeof v === 'object' && (v as FormulaValue).kind === 'formula';
}

/** A select/multiselect field's choices, as { value, label } (server stores strings or {value,label}). */
export function choicesOf(field: FilterField | null) {
    return (Array.isArray(field?.options) ? field.options : []).map((o) => (
        o && typeof o === 'object'
            ? { value: String(o.value ?? o.key ?? ''), label: String(o.label ?? o.value ?? o.key ?? '') }
            : { value: String(o), label: String(o) }
    ));
}

/** Which value control a row deserves. */
export function valueControlFor(field: FilterField | null, op: string) {
    if (op === 'in' || op === 'notIn') return 'list';
    if (op === 'between') return 'range';
    if (TEXT_OPS.has(op)) return 'text';
    const type = field?.type;
    if (type === 'bool') return 'bool';
    if (type === 'date' || type === 'datetime') return type;
    if (type === 'number') return 'number';
    if ((type === 'select' || type === 'multiselect') && choicesOf(field).length) return 'choice';
    return 'text';
}

export function isNumeric(v: unknown) {
    return Number.isFinite(Number(String(v).replace(',', '.')));
}

export function boolSegment(value: FilterValue | undefined) {
    if (value === true || value === 'true') return 'true';
    if (value === false || value === 'false') return 'false';
    return '';
}

/** The empty value a control starts from, so a switch never leaves a stale shape. */
export function emptyValueFor(control: string) {
    if (control === 'list') return [];
    if (control === 'range') return ['', ''];
    return '';
}

/**
 * Move a per-row marker from the row object being replaced onto its
 * replacement, and forget rows that no longer exist. A row that was NOT marked
 * must stay unmarked — carrying the marker onto every edited row would send the
 * whole list to free text after one keystroke. Same set back when nothing
 * changed (no re-render).
 */
export function reKeySet<R>(prev: Set<R>, rows: readonly unknown[], from: R, to: R): Set<R> {
    if (!prev.has(from)) {
        const live = new Set(rows.filter((row): row is R => prev.has(row as R)));
        return live.size === prev.size ? prev : live;
    }
    const next = new Set<R>();
    for (const row of rows as R[]) {
        if (row === from) next.add(to);
        else if (prev.has(row)) next.add(row);
    }
    return next;
}

/** reKeySet for the remembered other-mode values (a map keyed by row object). */
export function reKeyMap<R, V>(prev: Map<R, V>, rows: readonly unknown[], from: R, to: R): Map<R, V> {
    if (prev.size === 0) return prev;
    const next = new Map<R, V>();
    for (const row of rows as R[]) {
        if (row === from) { if (prev.has(from)) next.set(to, prev.get(from) as V); }
        else if (prev.has(row)) next.set(row, prev.get(row) as V);
    }
    return next.size === prev.size && !prev.has(from) ? prev : next;
}
