/**
 * Field rules: the ONE place a record write meets `field.validation` and
 * `field.dynamicDefault` (vocabulary.js FIELD_VALIDATION / DYNAMIC_DEFAULTS).
 *
 * Every App Studio write path calls `applyFieldRules` on the values it is about
 * to compile (compileInsert / compileUpdate / the bulk compilers), and the model
 * validator calls `fieldRuleErrors` on save. Both are application-level: nothing
 * here reaches the DDL, so a rule never migrates a column.
 *
 * What it promises an existing app:
 *   - A table whose fields declare neither key gets its `values` object back
 *     untouched (the same object), so the compiled SQL is byte-identical.
 *   - Only the keys being WRITTEN are checked. An update never reads the row, so a
 *     row stored before a rule existed is never re-checked; it only has to pass
 *     the rule for a field when someone writes that field.
 *   - An empty value (missing, null, '' or an empty list) passes every rule:
 *     "must have a value" is `required`, which stays where it was.
 *
 * Dynamic defaults are filled on CREATE only, when the value is missing or empty
 * (a form submits null for a field nobody touched).
 *
 * A refusal is a FieldValidationError: status 422, code 'field_invalid', a
 * sentence per field in `fieldErrors` keyed by field key. The sentences name the
 * field by its label and the rule, never the value that was written.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Option = string | { value?: unknown; label?: unknown };
type Validation = {
    min?: unknown; max?: unknown; minLength?: unknown; maxLength?: unknown;
    pattern?: unknown; enforceOptions?: unknown; message?: unknown;
};
export type RuleField = {
    key?: string; name?: string; type?: string; options?: Option[];
    default?: unknown; validation?: Validation | null; dynamicDefault?: string | null;
};
type RuleTable = { fields?: RuleField[] };
type Compiled = { ok: boolean; message?: string };

const vocab = nodeRequire('./dataModel/vocabulary') as {
    FIELD_VALIDATION: { keys: readonly string[] };
    DYNAMIC_DEFAULTS: { types: Readonly<Record<string, readonly string[]>> };
    FIELD_RULE_LIMITS: { MAX_PATTERN_LEN: number; MAX_MESSAGE_LEN: number; MAX_LENGTH: number };
};
const userPattern = nodeRequire('../text/userPattern') as {
    compileUserPattern(p: unknown, o?: { caseInsensitive?: boolean }): Compiled;
    testUserPattern(c: Compiled, text: string): boolean | null;
};

/** At most this many sentences go into the error's message; `fieldErrors` has them all. */
const MAX_MESSAGE_PARTS = 3;

export class FieldValidationError extends Error {
    status = 422;
    code = 'field_invalid';
    fieldErrors: Record<string, string>;

    constructor(fieldErrors: Record<string, string>) {
        const parts = Object.values(fieldErrors);
        const shown = parts.slice(0, MAX_MESSAGE_PARTS).join(' ');
        const more = parts.length > MAX_MESSAGE_PARTS ? ` (${parts.length - MAX_MESSAGE_PARTS} more)` : '';
        super(`${shown}${more}`);
        this.name = 'FieldValidationError';
        this.fieldErrors = fieldErrors;
    }
}

const isPlainObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v: unknown): boolean => v !== undefined && v !== null;
const isEmpty = (v: unknown): boolean => !present(v) || v === '' || (Array.isArray(v) && v.length === 0);
const labelOf = (f: RuleField): string => (typeof f.name === 'string' && f.name.trim()) ? f.name : String(f.key);
const isCount = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= vocab.FIELD_RULE_LIMITS.MAX_LENGTH;

// ── Save-time shape ─────────────────────────────────────────────────

/** Which field types each validation key applies to ('message' applies to all). */
const RULE_TYPES: Record<string, readonly string[]> = {
    min: ['number'], max: ['number'],
    minLength: ['text'], maxLength: ['text'], pattern: ['text'],
    enforceOptions: ['select', 'multiselect'],
};

function ruleValueError(key: string, value: unknown): string | null {
    if (key === 'min' || key === 'max') return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    if (key === 'minLength' || key === 'maxLength') return isCount(value) ? null : `must be a whole number from 0 to ${vocab.FIELD_RULE_LIMITS.MAX_LENGTH}`;
    if (key === 'enforceOptions') return typeof value === 'boolean' ? null : 'must be true or false';
    if (key === 'message') {
        const ok = typeof value === 'string' && value.trim() && value.length <= vocab.FIELD_RULE_LIMITS.MAX_MESSAGE_LEN;
        return ok ? null : `must be a non-empty text of at most ${vocab.FIELD_RULE_LIMITS.MAX_MESSAGE_LEN} characters`;
    }
    return patternError(value);
}

function patternError(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return 'must be a non-empty pattern';
    if (value.length > vocab.FIELD_RULE_LIMITS.MAX_PATTERN_LEN) return `is longer than ${vocab.FIELD_RULE_LIMITS.MAX_PATTERN_LEN} characters`;
    const compiled = userPattern.compileUserPattern(value, { caseInsensitive: false });
    return compiled.ok ? null : `is refused: ${compiled.message}`;
}

function validationErrors(field: RuleField, v: Obj, at: string): string[] {
    const errors: string[] = [];
    const type = String(field.type);
    for (const [key, value] of Object.entries(v)) {
        if (!vocab.FIELD_VALIDATION.keys.includes(key)) { errors.push(`${at}.validation has an unknown key "${key}" (known: ${vocab.FIELD_VALIDATION.keys.join(', ')})`); continue; }
        if (!present(value)) continue;
        const types = RULE_TYPES[key];
        if (types && !types.includes(type)) { errors.push(`${at}.validation.${key} does not apply to a ${type} field (only ${types.join(', ')})`); continue; }
        const problem = ruleValueError(key, value);
        if (problem) errors.push(`${at}.validation.${key} ${problem}`);
    }
    if (typeof v.min === 'number' && typeof v.max === 'number' && v.min > v.max) errors.push(`${at}.validation.min is larger than max`);
    if (isCount(v.minLength) && isCount(v.maxLength) && (v.minLength as number) > (v.maxLength as number)) errors.push(`${at}.validation.minLength is larger than maxLength`);
    return errors;
}

function dynamicDefaultErrors(field: RuleField, at: string): string[] {
    const value = field.dynamicDefault;
    const types = typeof value === 'string' && Object.hasOwn(vocab.DYNAMIC_DEFAULTS.types, value) ? vocab.DYNAMIC_DEFAULTS.types[value] : null;
    if (!types) return [`${at}.dynamicDefault ${JSON.stringify(value)} is not one of: ${Object.keys(vocab.DYNAMIC_DEFAULTS.types).join(', ')}`];
    if (!types.includes(String(field.type))) return [`${at}.dynamicDefault "${value}" needs a ${types.join(' or ')} field, not ${field.type}`];
    if (present(field.default)) return [`${at} has both default and dynamicDefault; keep one`];
    return [];
}

/**
 * The model validator's check of one field's rules (both keys optional; null
 * counts as absent). Messages, empty when the field is fine.
 */
export function fieldRuleErrors(field: RuleField, at: string): string[] {
    const errors: string[] = [];
    if (present(field.validation)) {
        if (!isPlainObject(field.validation)) errors.push(`${at}.validation must be an object`);
        else errors.push(...validationErrors(field, field.validation, at));
    }
    if (present(field.dynamicDefault)) errors.push(...dynamicDefaultErrors(field, at));
    return errors;
}

// ── Write time ──────────────────────────────────────────────────────

const ruledCache = new WeakMap<object, RuleField[]>();

/** The fields of a table that declare a rule; cached per fields array. */
function ruledFields(table: unknown): RuleField[] {
    const raw = isPlainObject(table) ? (table as RuleTable).fields : null;
    const fields = Array.isArray(raw) ? raw : null;
    if (!fields) return [];
    const hit = ruledCache.get(fields);
    if (hit) return hit;
    const list = fields.filter((f) => isPlainObject(f) && typeof f.key === 'string'
        && (isPlainObject(f.validation) || (typeof f.dynamicDefault === 'string' && f.dynamicDefault)));
    ruledCache.set(fields, list);
    return list;
}

function dynamicValue(kind: string, viewerId: unknown, now: Date): unknown {
    if (kind === 'now') return now.toISOString();
    if (kind === 'today') return now.toISOString().slice(0, 10);
    if (kind === 'currentUser.id') return typeof viewerId === 'string' && viewerId ? viewerId : undefined;
    return undefined;
}

function optionValues(field: RuleField): Set<string> {
    const out = new Set<string>();
    for (const o of Array.isArray(field.options) ? field.options : []) {
        out.add(String(o !== null && typeof o === 'object' ? (o.value ?? o.label ?? '') : o));
    }
    return out;
}

function listOf(v: unknown): unknown[] {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim().startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(v);
            if (Array.isArray(parsed)) return parsed;
        } catch { /* not a JSON list: the whole string is one choice */ }
    }
    return [v];
}

function numberRule(v: Validation, value: unknown, label: string): string | null {
    if (!present(v.min) && !present(v.max)) return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) return `"${label}" must be a number.`;
    if (typeof v.min === 'number' && n < v.min) return `"${label}" must be at least ${v.min}.`;
    if (typeof v.max === 'number' && n > v.max) return `"${label}" must be at most ${v.max}.`;
    return null;
}

function textRule(v: Validation, value: unknown, label: string): string | null {
    const s = String(value);
    const length = [...s].length;
    if (isCount(v.minLength) && length < (v.minLength as number)) return `"${label}" must be at least ${v.minLength} characters.`;
    if (isCount(v.maxLength) && length > (v.maxLength as number)) return `"${label}" must be at most ${v.maxLength} characters.`;
    if (typeof v.pattern !== 'string' || !v.pattern) return null;
    const compiled = userPattern.compileUserPattern(v.pattern, { caseInsensitive: false });
    // A pattern that cannot be compiled or decided refuses: the rule exists, and passing a value it never looked at would be a lie.
    if (!compiled.ok) return `"${label}" could not be checked.`;
    const hit = userPattern.testUserPattern(compiled, s);
    if (hit === null) return `"${label}" could not be checked right now. Try again.`;
    return hit ? null : `"${label}" does not have the expected format.`;
}

function optionsRule(field: RuleField, value: unknown, label: string): string | null {
    if (field.validation?.enforceOptions !== true) return null;
    const allowed = optionValues(field);
    const ok = listOf(value).every((x) => allowed.has(String(x)));
    return ok ? null : `"${label}" must be one of the listed options.`;
}

/** The first rule a written value breaks, as a sentence; null when it passes. */
function breach(field: RuleField, value: unknown): string | null {
    const v = field.validation;
    if (!isPlainObject(v) || isEmpty(value)) return null;
    const label = labelOf(field);
    let problem: string | null = null;
    if (field.type === 'number') problem = numberRule(v, value, label);
    else if (field.type === 'text') problem = textRule(v, value, label);
    else if (field.type === 'select' || field.type === 'multiselect') problem = optionsRule(field, value, label);
    if (!problem) return null;
    return typeof v.message === 'string' && v.message.trim() ? v.message : problem;
}

export type FieldRuleOpts = { op: 'create' | 'update'; viewerId?: unknown; now?: Date };

/**
 * The values a write compiles, with dynamic defaults filled (create only) and
 * every written field that declares a rule checked. Throws FieldValidationError.
 * Returns the input object itself when the table declares no rule at all, and
 * never mutates it.
 */
export function applyFieldRules<T>(table: unknown, values: T, opts: FieldRuleOpts): T {
    const ruled = ruledFields(table);
    if (!ruled.length) return values;
    const source: Obj = isPlainObject(values) ? values : {};
    let out: Obj = source;
    if (opts.op === 'create') {
        const now = opts.now ?? new Date();
        for (const f of ruled) {
            if (typeof f.dynamicDefault !== 'string' || !isEmpty(out[f.key as string])) continue;
            const filled = dynamicValue(f.dynamicDefault, opts.viewerId, now);
            if (filled === undefined) continue;
            if (out === source) out = { ...source };
            out[f.key as string] = filled;
        }
    }
    const fieldErrors: Record<string, string> = {};
    for (const f of ruled) {
        const key = f.key as string;
        if (!Object.hasOwn(out, key)) continue;
        const problem = breach(f, out[key]);
        if (problem) fieldErrors[key] = problem;
    }
    if (Object.keys(fieldErrors).length) throw new FieldValidationError(fieldErrors);
    return (out === source ? values : out) as T;
}

/**
 * Many rows at once (a batch create): the first row that breaks a rule throws,
 * so an all-or-nothing batch writes nothing. The rows share one clock.
 */
export function applyFieldRulesToRows<T>(table: unknown, rows: T[], opts: FieldRuleOpts): T[] {
    if (!ruledFields(table).length || !Array.isArray(rows)) return rows;
    const shared = { ...opts, now: opts.now ?? new Date() };
    return rows.map((row) => applyFieldRules(table, row, shared));
}
