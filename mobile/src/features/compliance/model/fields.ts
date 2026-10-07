/**
 * Form values ↔ records ↔ request bodies, for every register form.
 *
 * A form holds strings and booleans (what a TextField and a switch give);
 * the body is built from the field table, never from the form object — the
 * web's allow-list discipline (BFSF-441): a key the table does not declare
 * cannot travel. A create body leaves out what was left empty; an edit body
 * carries only the keys that changed, with an emptied field sent as `null`
 * (every patch schema on the server takes `.nullish()` for those).
 */

import type { TranslateFn } from '@/core/i18n';

import type { Choice, FieldContext, FieldSpec, FieldValue, Formatter, FormValues, Label, Rec, RecordType } from './types';

export function labelText(label: Label | string, t: TranslateFn): string {
    return typeof label === 'string' ? label : t(label.i18nKey, label.en);
}

export function choiceOf(options: readonly Choice[] | undefined, value: unknown): Choice | null {
    if (value === null || value === undefined) return null;
    return options?.find((o) => o.value === String(value)) ?? null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A date the form can edit: the `YYYY-MM-DD` part of an ISO stamp. */
function dateInput(value: unknown): string {
    return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : '';
}

/** A spec's starting value, a function called now. */
export function initialOf(spec: FieldSpec): FieldValue | undefined {
    return typeof spec.initial === 'function' ? spec.initial() : spec.initial;
}

function emptyValue(spec: FieldSpec): FieldValue {
    const initial = initialOf(spec);
    if (spec.kind === 'users') return Array.isArray(initial) ? initial : [];
    return typeof initial === 'string' ? initial : '';
}

/** The form's value for one field of a record (or its create default). */
export function fieldValue(spec: FieldSpec, value: unknown): FieldValue {
    if (spec.kind === 'bool') return typeof value === 'boolean' ? value : initialOf(spec) === true;
    if (value === null || value === undefined) return emptyValue(spec);
    if (spec.kind === 'date') return dateInput(value);
    if (spec.kind === 'users') return Array.isArray(value) ? value.map(String) : [String(value)];
    if (spec.kind === 'json') return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    if (spec.kind === 'lines') return Array.isArray(value) ? value.map(String).join('\n') : String(value);
    return String(value);
}

export function initialValues(fields: readonly FieldSpec[], rec?: Rec | null): FormValues {
    const out: FormValues = {};
    for (const f of fields) out[f.key] = fieldValue(f, rec ? rec[f.key] : undefined);
    return out;
}

/** The parsed object of a 'json' field; null when the text is not a JSON object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
    if (!text.trim()) return {};
    try {
        const v: unknown = JSON.parse(text);
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** One form value as it travels: trimmed, typed, empty → null. */
export function bodyValue(spec: FieldSpec, value: FieldValue | undefined): unknown {
    if (spec.kind === 'bool') return value === true;
    if (spec.kind === 'users') return Array.isArray(value) ? value.filter(Boolean) : [];
    if (spec.kind === 'json') return parseJsonObject(typeof value === 'string' ? value : '');
    const text = typeof value === 'string' ? value.trim() : '';
    if (spec.kind === 'lines') return text ? text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    if (text === '') return null;
    if (spec.kind === 'number' || spec.numeric) return Number(text);
    return text;
}

const keyOf = (spec: FieldSpec) => spec.body ?? spec.key;

/** A create body: every filled visible field, booleans always, nothing left empty. */
export function createBody(fields: readonly FieldSpec[], values: FormValues, rec: Rec | null = null): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const f of fields) {
        if (!isVisible(f, rec, values)) continue;
        const v = bodyValue(f, values[f.key]);
        if (v === null || (Array.isArray(v) && v.length === 0)) continue;
        body[keyOf(f)] = v;
    }
    return body;
}

function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
    return a === b;
}

/** An edit body: only what differs from the record, an emptied field as null. */
export function patchBody(fields: readonly FieldSpec[], rec: Rec, values: FormValues): Record<string, unknown> {
    const before = initialValues(fields, rec);
    const body: Record<string, unknown> = {};
    for (const f of fields) {
        if (!isVisible(f, rec, values) || sameValue(values[f.key], before[f.key])) continue;
        body[keyOf(f)] = bodyValue(f, values[f.key]);
    }
    return body;
}

/** The first built-in message for one value; null when it will do. */
function builtInError(f: FieldSpec, v: FieldValue | undefined, t: TranslateFn, now: number): string | null {
    const text = typeof v === 'string' ? v.trim() : '';
    const empty = Array.isArray(v) ? v.length === 0 : !text;
    if (f.required && f.kind !== 'bool' && empty) return t('mobile.compliance.field_required', '{field} is required.', { field: labelText(f.label, t) });
    if (!text) return null;
    if (f.kind === 'date' && (!DATE_ONLY.test(text) || Number.isNaN(Date.parse(text)))) return t('mobile.compliance.field_date', 'Write the date as YYYY-MM-DD.');
    if (f.kind === 'number' && !Number.isFinite(Number(text))) return t('mobile.compliance.field_number', 'Enter a number.');
    if (f.kind === 'json' && parseJsonObject(text) === null) return t('mobile.compliance.field_json', 'Not valid JSON — nothing was saved.');
    return f.kind === 'moment' ? momentError(text, t, now) : null;
}

function momentError(text: string, t: TranslateFn, now: number): string | null {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) return t('mobile.compliance.field_moment', 'Pick a day and time.');
    if (ms > now + FUTURE_SLACK_MS) return t('mobile.compliance.field_future', 'This moment lies in the future.');
    return null;
}

/** A 'moment' may lie at most this far ahead (the server's own slack). */
export const FUTURE_SLACK_MS = 5 * 60_000;

/** Is the field shown (and so validated and sent)? */
export function isVisible(f: FieldSpec, rec: Rec | null, values: FormValues): boolean {
    return !f.visible || f.visible(rec, values);
}

/** The first message for each visible field that will not do; empty when the form is fine. */
export function validateFields(
    fields: readonly FieldSpec[],
    values: FormValues,
    t: TranslateFn,
    ctx: Partial<Omit<FieldContext, 't'>> = {},
): Record<string, string> {
    const full: FieldContext = { t, rec: ctx.rec ?? null, now: ctx.now ?? Date.now() };
    const errors: Record<string, string> = {};
    for (const f of fields) {
        if (!isVisible(f, full.rec, values)) continue;
        const message = builtInError(f, values[f.key], t, full.now) ?? f.validate?.(values[f.key], values, full) ?? null;
        if (message) errors[f.key] = message;
    }
    return errors;
}

/** A value as a person reads it; null when there is nothing to show. */
export function formatValue(spec: FieldSpec, value: unknown, fmt: Formatter): string | null {
    if (value === null || value === undefined || value === '') return null;
    switch (spec.kind) {
        case 'bool':
            return value === true ? fmt.t('common.yes', 'Yes') : fmt.t('common.no', 'No');
        case 'choice': {
            const c = choiceOf(spec.options, value);
            return c ? labelText(c.label, fmt.t) : String(value);
        }
        case 'date':
            return fmt.date(value);
        case 'moment':
        case 'users':
        case 'json':
            return formatNewKind(spec.kind, value, fmt);
        case 'user':
            return fmt.user(value);
        case 'lines':
            return Array.isArray(value) ? (value.length ? value.map(String).join(', ') : null) : String(value);
        default:
            return typeof value === 'object' ? null : String(value);
    }
}

function formatNewKind(kind: 'moment' | 'users' | 'json', value: unknown, fmt: Formatter): string | null {
    if (kind === 'moment') return fmt.dayTime(value);
    if (kind === 'users') return namesOf(value, fmt);
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function namesOf(value: unknown, fmt: Formatter): string | null {
    const ids = Array.isArray(value) ? value : [value];
    const names = ids.map((id) => fmt.user(id)).filter((n): n is string => Boolean(n));
    return names.length ? names.join(', ') : null;
}

/** The line under a row's title: its meta fields, formatted and joined. */
export function summaryOf(type: RecordType, rec: Rec, fmt: Formatter): string | null {
    const parts: string[] = [];
    for (const key of type.meta ?? []) {
        const spec = type.facts.find((f) => f.key === key);
        const text = spec ? formatValue(spec, rec[key], fmt) : null;
        if (text) parts.push(text);
    }
    return parts.length ? parts.join(' · ') : null;
}

/** A row's status chip: the choice for its status value, or null. */
export function statusOf(type: RecordType, rec: Rec): Choice | null {
    return type.status ? choiceOf(type.status.options, rec[type.status.key]) : null;
}

/** Does the register show owners (so its screens read the member directory)? */
export function usesMembers(type: RecordType): boolean {
    return [...type.facts, ...(type.edit?.fields ?? []), ...(type.create?.fields ?? [])].some((f) => f.kind === 'user' || f.kind === 'users');
}

/** Does a row match a search needle (already trimmed and lower-cased)? */
export function matchesSearch(type: RecordType, rec: Rec, needle: string, fmt: Formatter): boolean {
    if (type.titleOf(rec, fmt).toLowerCase().includes(needle)) return true;
    if (type.searchText?.(rec, fmt).toLowerCase().includes(needle)) return true;
    const hit = (v: unknown) => typeof v === 'string' && v.toLowerCase().includes(needle);
    return (type.search ?? []).some((key) => {
        const v = rec[key];
        return Array.isArray(v) ? v.some(hit) : hit(v);
    });
}
