import type { TranslateParams } from '../../../../../hooks/useTranslation';
import type { FormulaValue, FilterValue, FilterField } from './FilterRowsEditor.types';

const filterOps = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { value: 'eq', label: t('studio_apps_bi.filter.op_eq', 'is') },
    { value: 'neq', label: t('studio_apps_bi.filter.op_neq', 'is not') },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'contains', label: t('studio_apps_bi.filter.op_contains', 'contains') },
    { value: 'startsWith', label: t('studio_apps_bi.filter.op_starts_with', 'starts with') },
    { value: 'in', label: t('studio_apps_bi.filter.op_in', 'is one of') },
    { value: 'between', label: t('studio_apps_bi.filter.op_between', 'is between') },
    { value: 'isNull', label: t('studio_apps_bi.filter.op_is_null', 'is empty') },
    { value: 'isNotNull', label: t('studio_apps_bi.filter.op_is_not_null', 'is not empty') },
];

// Ops that match on text no matter what the column holds.
const TEXT_OPS = new Set(['contains', 'startsWith']);

/**
 * Which ops each column type can carry. A saved op outside its list is always
 * re-offered (see opsFor) so an existing filter round-trips untouched, but the
 * picker never SUGGESTS "contains" for a yes/no column — which used to leave
 * `contains` set after a field switch and silently render a free-text box for a
 * boolean.
 */
const OPS_BY_TYPE: Record<string, string[]> = {
    bool: ['eq', 'neq', 'isNull', 'isNotNull'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'isNull', 'isNotNull'],
    date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
    datetime: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
    select: ['eq', 'neq', 'in', 'contains', 'isNull', 'isNotNull'],
    multiselect: ['eq', 'neq', 'in', 'contains', 'isNull', 'isNotNull'],
};

const DEFAULT_OPS = ['eq', 'neq', 'contains', 'startsWith', 'in', 'isNull', 'isNotNull'];

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
    if (op === 'in') return 'list';
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

export function boolSegment(value: FilterValue) {
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
