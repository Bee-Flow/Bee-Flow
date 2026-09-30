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

import type { Choice, FieldSpec, FieldValue, Formatter, FormValues, Label, Rec, RecordType } from './types';

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

/** The form's value for one field of a record (or its create default). */
export function fieldValue(spec: FieldSpec, value: unknown): FieldValue {
    if (spec.kind === 'bool') return typeof value === 'boolean' ? value : spec.initial === true;
    if (value === null || value === undefined) return typeof spec.initial === 'string' ? spec.initial : '';
    if (spec.kind === 'date') return dateInput(value);
    if (spec.kind === 'lines') return Array.isArray(value) ? value.map(String).join('\n') : String(value);
    return String(value);
}

export function initialValues(fields: readonly FieldSpec[], rec?: Rec | null): FormValues {
    const out: FormValues = {};
    for (const f of fields) out[f.key] = fieldValue(f, rec ? rec[f.key] : undefined);
    return out;
}

/** One form value as it travels: trimmed, typed, empty → null. */
export function bodyValue(spec: FieldSpec, value: FieldValue | undefined): unknown {
    if (spec.kind === 'bool') return value === true;
    const text = typeof value === 'string' ? value.trim() : '';
    if (spec.kind === 'lines') return text ? text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    if (text === '') return null;
    if (spec.kind === 'number' || spec.numeric) return Number(text);
    return text;
}

const keyOf = (spec: FieldSpec) => spec.body ?? spec.key;

/** A create body: every filled field, booleans always, nothing left empty. */
export function createBody(fields: readonly FieldSpec[], values: FormValues): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const f of fields) {
        const v = bodyValue(f, values[f.key]);
        if (v === null || (Array.isArray(v) && v.length === 0)) continue;
        body[keyOf(f)] = v;
    }
    return body;
}

/** An edit body: only what differs from the record, an emptied field as null. */
export function patchBody(fields: readonly FieldSpec[], rec: Rec, values: FormValues): Record<string, unknown> {
    const before = initialValues(fields, rec);
    const body: Record<string, unknown> = {};
    for (const f of fields) {
        if (values[f.key] === before[f.key]) continue;
        body[keyOf(f)] = bodyValue(f, values[f.key]);
    }
    return body;
}

/** The first message for each field that will not do; empty when the form is fine. */
export function validateFields(fields: readonly FieldSpec[], values: FormValues, t: TranslateFn): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const f of fields) {
        const v = values[f.key];
        const text = typeof v === 'string' ? v.trim() : '';
        if (f.required && f.kind !== 'bool' && !text) {
            errors[f.key] = t('mobile.compliance.field_required', '{field} is required.', { field: labelText(f.label, t) });
        } else if (text && f.kind === 'date' && (!DATE_ONLY.test(text) || Number.isNaN(Date.parse(text)))) {
            errors[f.key] = t('mobile.compliance.field_date', 'Write the date as YYYY-MM-DD.');
        } else if (text && f.kind === 'number' && !Number.isFinite(Number(text))) {
            errors[f.key] = t('mobile.compliance.field_number', 'Enter a number.');
        }
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
        case 'user':
            return fmt.user(value);
        case 'lines':
            return Array.isArray(value) ? (value.length ? value.map(String).join(', ') : null) : String(value);
        default:
            return typeof value === 'object' ? null : String(value);
    }
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
    return [...type.facts, ...(type.edit?.fields ?? []), ...(type.create?.fields ?? [])].some((f) => f.kind === 'user');
}

/** Does a row match a search needle (already trimmed and lower-cased)? */
export function matchesSearch(type: RecordType, rec: Rec, needle: string, fmt: Formatter): boolean {
    if (type.titleOf(rec, fmt).toLowerCase().includes(needle)) return true;
    return (type.search ?? []).some((key) => {
        const v = rec[key];
        return typeof v === 'string' && v.toLowerCase().includes(needle);
    });
}
