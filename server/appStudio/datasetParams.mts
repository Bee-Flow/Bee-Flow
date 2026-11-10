/**
 * Saved datasets with parameters.
 *
 * A saved dataset is one fixed aggregation over one table. A dataset may DECLARE
 * parameters in its descriptor, and a filter clause may then take its value from
 * one of them:
 *
 *   descriptor: {
 *     params:  [{ name: 'region', type: 'text', default?: 'north', label?: 'Region' }],
 *     filters: [{ field: 'region', op: 'eq', value: { param: 'region' } }],
 *     groupBy, aggregates, ...
 *   }
 *
 * The binding that reads it sends the values: { kind: 'dataset', datasetId,
 * params: { region: 'south' } }, each value a literal or a formula the client
 * resolves first, as it does for filter values.
 *
 * Only the VALUE of a clause the author wrote can come from a parameter: the
 * field, the operator and the rest of the query stay the author's. A sent
 * value is read only for a declared name, coerced to the declared type, and
 * reaches the compiler as a bound value like any other filter value. The
 * access filter is compiled by the caller as before, so a parameter can narrow
 * what a viewer sees and never widen it past their row rules.
 *
 * A parameter without a value falls back to its default; without either, its
 * clause is dropped (the filter_bar rule: an empty field filters nothing),
 * unless the clause is `required`, in which case the read answers no rows.
 *
 * A descriptor that declares no parameters is returned AS IS: the same object,
 * the same cache key, every sent value ignored. That is what keeps every saved
 * dataset that exists today exactly as it is.
 */

import { forEachFilterClause, resolveFilterList } from '../shared/expr/filterGroups.mjs';

type Obj = Record<string, unknown>;

/** The value types a parameter may declare. Absent means text. */
export const DATASET_PARAM_TYPES = Object.freeze(['text', 'number', 'boolean', 'date']);
/** Validity limits of a declaration (definition limits, so constants). */
export const MAX_DATASET_PARAMS = 10;
export const MAX_PARAM_NAME = 40;
export const MAX_PARAM_LABEL = 80;
/** Limits of one sent value: a text value, a date string, a list (the compiler's per-`in` cap). */
export const MAX_PARAM_TEXT = 500;
const MAX_PARAM_DATE = 40;
export const MAX_PARAM_LIST = 200;

const DECLARATION_KEYS = new Set(['name', 'type', 'default', 'label']);
/** What coerceParamValue answers for a value that does not fit the type. */
export const INVALID_PARAM = Symbol('invalid-dataset-param');

/** Cache rows one parameterised dataset may hold (0 = unlimited). */
export const DEFAULT_PARAM_CACHE_MAX = 1000;

export interface DatasetParam {
    name: string;
    type?: string;
    default?: unknown;
    label?: string;
}

export type ResolvedDataset =
    | { status: 'ok'; descriptor: Obj; values: Obj | null }
    | { status: 'required' }
    | { status: 'invalid'; name: string };

function isPlainObject(v: unknown): v is Obj {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `{ param: '<name>' }` and nothing else: the one shape a parameter reference has. */
export function isParamRef(v: unknown): v is { param: string } {
    if (!isPlainObject(v)) return false;
    const keys = Object.keys(v);
    return keys.length === 1 && keys[0] === 'param' && typeof v.param === 'string';
}

function isIdentChar(code: number, first: boolean): boolean {
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    return first ? letter : letter || (code >= 48 && code <= 57);
}

/** A parameter name: a letter or `_`, then letters, digits or `_`, at most MAX_PARAM_NAME. */
export function isParamName(name: unknown): name is string {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_PARAM_NAME) return false;
    for (let i = 0; i < name.length; i += 1) {
        if (!isIdentChar(name.charCodeAt(i), i === 0)) return false;
    }
    return true;
}

/** The parameters a descriptor declares, the well-formed ones only. Empty when it declares none. */
export function declaredParams(descriptor: unknown): DatasetParam[] {
    const list = isPlainObject(descriptor) && Array.isArray(descriptor.params) ? descriptor.params : [];
    return list.filter((p): p is DatasetParam => isPlainObject(p) && isParamName(p.name));
}

/** True when the descriptor declares at least one parameter. */
export function hasDeclaredParams(descriptor: unknown): boolean {
    return declaredParams(descriptor).length > 0;
}

/** The parameter names a saved dataset row declares, or null when it declares none. */
export function datasetParamNames(row: unknown): string[] | null {
    const names = declaredParams(isPlainObject(row) ? row.descriptor : null).map((p) => p.name);
    return names.length ? names : null;
}

/**
 * A saved dataset as the AI builder's data block lists it: `{ id, name }`, plus
 * `params` (the names) only for a dataset that declares parameters.
 */
export function datasetEntry(row: { id: string; name?: string; descriptor?: unknown }): { id: string; name?: string; params?: string[] } {
    const names = datasetParamNames(row);
    return { id: row.id, name: row.name, ...(names ? { params: names } : {}) };
}

function coerceText(v: unknown): unknown {
    if (typeof v === 'string') return v.length <= MAX_PARAM_TEXT ? v : INVALID_PARAM;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return String(v);
    return INVALID_PARAM;
}

function coerceNumber(v: unknown): unknown {
    if (typeof v === 'number') return Number.isFinite(v) ? v : INVALID_PARAM;
    if (typeof v === 'string' && v.trim() !== '' && v.length <= MAX_PARAM_DATE) {
        const n = Number(v.trim());
        return Number.isFinite(n) ? n : INVALID_PARAM;
    }
    return INVALID_PARAM;
}

function coerceBoolean(v: unknown): unknown {
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return INVALID_PARAM;
}

function coerceDate(v: unknown): unknown {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_PARAM_DATE) return INVALID_PARAM;
    return Number.isNaN(Date.parse(v)) ? INVALID_PARAM : v;
}

function coerceScalar(v: unknown, type: unknown): unknown {
    if (type === 'number') return coerceNumber(v);
    if (type === 'boolean') return coerceBoolean(v);
    if (type === 'date') return coerceDate(v);
    return coerceText(v);
}

/**
 * One value coerced to the declared type: the value, `undefined` when it is not
 * set (undefined, null, an empty list), or INVALID_PARAM. A list (for `in`,
 * `notIn`, `between`) is coerced element by element.
 */
export function coerceParamValue(v: unknown, type: unknown): unknown {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) {
        if (v.length === 0) return undefined;
        if (v.length > MAX_PARAM_LIST) return INVALID_PARAM;
        const out = v.map((x) => coerceScalar(x, type));
        return out.includes(INVALID_PARAM) ? INVALID_PARAM : out;
    }
    return coerceScalar(v, type);
}

function declarationErrors(p: unknown, at: string, seen: Set<string>): string[] {
    if (!isPlainObject(p)) return [`${at} must be an object { name, type?, default?, label? }.`];
    const errors: string[] = [];
    for (const k of Object.keys(p)) if (!DECLARATION_KEYS.has(k)) errors.push(`${at}.${k} is not a parameter setting.`);
    if (!isParamName(p.name)) {
        errors.push(`${at}.name must start with a letter or _ and hold only letters, digits and _ (at most ${MAX_PARAM_NAME}).`);
    } else if (seen.has(p.name)) {
        errors.push(`${at}.name "${p.name}" is declared twice.`);
    } else {
        seen.add(p.name);
    }
    if (p.type !== undefined && !DATASET_PARAM_TYPES.includes(p.type as string)) {
        errors.push(`${at}.type must be one of ${DATASET_PARAM_TYPES.join(', ')}.`);
    }
    if (p.label !== undefined && (typeof p.label !== 'string' || p.label.length > MAX_PARAM_LABEL)) {
        errors.push(`${at}.label must be text of at most ${MAX_PARAM_LABEL} characters.`);
    }
    if (p.default !== undefined && coerceParamValue(p.default, p.type) === INVALID_PARAM) {
        errors.push(`${at}.default does not fit type ${typeof p.type === 'string' ? p.type : 'text'}.`);
    }
    return errors;
}

/**
 * What is wrong with a descriptor's parameters: the declarations, and every
 * filter value that refers to a parameter. Empty when all is well, and always
 * empty for a descriptor without `params` and without parameter references.
 */
export function validateDatasetParams(descriptor: unknown): string[] {
    if (!isPlainObject(descriptor)) return [];
    const errors: string[] = [];
    const raw = descriptor.params;
    if (raw !== undefined) {
        if (!Array.isArray(raw)) errors.push('params must be a list of { name, type?, default?, label? }.');
        else if (raw.length > MAX_DATASET_PARAMS) errors.push(`At most ${MAX_DATASET_PARAMS} params.`);
        else {
            const seen = new Set<string>();
            raw.forEach((p, i) => { errors.push(...declarationErrors(p, `params[${i}]`, seen)); });
        }
    }
    const names = new Set(declaredParams(descriptor).map((p) => p.name));
    forEachFilterClause(descriptor.filters, (clause, at) => {
        const value = isPlainObject(clause) ? clause.value : undefined;
        if (!isPlainObject(value) || !('param' in value)) return;
        if (!isParamRef(value)) errors.push(`filters${at}.value: a parameter reference is { param: "<name>" }.`);
        else if (!names.has(value.param)) errors.push(`filters${at}.value names parameter "${value.param}", which params does not declare.`);
    });
    return errors;
}

/** The value of every declared parameter: sent, else its default, else absent. */
function paramValues(decl: DatasetParam[], sent: unknown): { values: Obj } | { invalid: string } {
    const src = isPlainObject(sent) ? sent : {};
    const values: Obj = {};
    for (const p of decl) {
        const raw = Object.prototype.hasOwnProperty.call(src, p.name) ? src[p.name] : undefined;
        let v = coerceParamValue(raw, p.type);
        if (v === INVALID_PARAM) return { invalid: p.name };
        if (v === undefined && p.default !== undefined) {
            const d = coerceParamValue(p.default, p.type);
            v = d === INVALID_PARAM ? undefined : d;
        }
        if (v !== undefined) values[p.name] = v;
    }
    return { values };
}

/**
 * The descriptor to compile for these sent values. A descriptor that declares
 * no parameters comes back as the same object with `values: null`; sent values
 * are then ignored. Otherwise every `{ param }` value is replaced by its value
 * (or its clause dropped / the read stopped, see the header); literal clauses
 * are left exactly as written.
 */
export function resolveDatasetParams(descriptor: unknown, sent: unknown): ResolvedDataset {
    const d = isPlainObject(descriptor) ? descriptor : {};
    const decl = declaredParams(d);
    if (decl.length === 0) return { status: 'ok', descriptor: d, values: null };
    const bound = paramValues(decl, sent);
    if ('invalid' in bound) return { status: 'invalid', name: bound.invalid };
    const { values } = bound;
    if (!Array.isArray(d.filters)) return { status: 'ok', descriptor: d, values };
    const res = resolveFilterList(d.filters, (value) => (isParamRef(value) ? values[value.param] : value), {
        // Only a parameter that has no value is missing: a literal stays as written.
        isUnset: (value, clause) => isParamRef(clause.value) && (value === undefined || value === null),
    });
    if (res.status !== 'ok') return { status: 'required' };
    return { status: 'ok', descriptor: { ...d, filters: res.filters }, values };
}

/**
 * The cache rows one parameterised dataset may keep, from
 * STUDIO_APP_DATASET_PARAM_CACHE_MAX (0 = unlimited). Each distinct set of
 * values is its own row, so without a cap the values a viewer sends would
 * decide how much the cache table grows.
 */
export function paramCacheMaxEntries(env: Record<string, string | undefined> = process.env): number {
    const raw = env.STUDIO_APP_DATASET_PARAM_CACHE_MAX;
    if (raw === undefined || raw.trim() === '') return DEFAULT_PARAM_CACHE_MAX;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PARAM_CACHE_MAX;
}
