/**
 * The pure half of the template-fill card: where the filling stands before
 * the first save, what a field sends, and the fields as the form renders them.
 *
 * The form sends what the person typed, as text where the field is a number
 * ("12,5"): the server coerces and type-checks it exactly as it does for the
 * assistant (server/core/documents/templateValues.mts) and names what does not
 * fit, so the browser does not keep a second set of rules.
 */
import type { FillField } from '@/api/templateFillApi';
import type { TemplateFillField, TemplateFillFieldType } from './templateFillTypes';

const FIELD_TYPES = new Set(['text', 'number', 'date', 'boolean', 'choice', 'list']);

const isEmptyValue = (v: unknown): boolean => v === undefined || v === null || v === ''
    || (Array.isArray(v) && v.length === 0);

/** Where the filling stands from the values alone (the server's answer replaces it after a save). */
export function localProgress(fields: FillField[], values: Record<string, unknown>) {
    const missingRequired = fields.filter((f) => f.required && isEmptyValue(values[f.key])).map((f) => ({ key: f.key, label: f.label }));
    return {
        missingRequired,
        filled: fields.filter((f) => !isEmptyValue(values[f.key])).length,
        total: fields.length,
        complete: missingRequired.length === 0,
    };
}

/** A list row the person left empty (an added row nobody typed in). */
const isEmptyRow = (row: unknown): boolean => (row && typeof row === 'object' && !Array.isArray(row)
    ? Object.values(row).every((v) => isEmptyValue(v) || (typeof v === 'string' && v.trim() === ''))
    : isEmptyValue(row) || (typeof row === 'string' && row.trim() === ''));

/** What a field sends: an empty text, an unset value or a list without filled rows clears it (null). */
export function wireValue(value: unknown): unknown {
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
    if (Array.isArray(value)) {
        const rows = value.filter((row) => !isEmptyRow(row));
        return rows.length ? rows : null;
    }
    return value;
}

/** A contract field as the form renders it: a known type, an example as text. */
export function formField(f: FillField): TemplateFillField {
    const example = f.example === undefined || f.example === null ? undefined
        : typeof f.example === 'string' ? f.example : JSON.stringify(f.example);
    return {
        key: f.key,
        label: f.label,
        type: (FIELD_TYPES.has(f.type) ? f.type : 'text') as TemplateFillFieldType,
        required: f.required,
        ...(f.options ? { options: f.options } : {}),
        ...(f.help ? { help: f.help } : {}),
        ...(f.details ? { details: f.details } : {}),
        ...(example !== undefined ? { example } : {}),
        ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
        ...(f.fields ? { fields: f.fields.map(formField) } : {}),
    };
}
