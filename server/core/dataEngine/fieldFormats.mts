/**
 * The schema-3 field shapes (vocabulary.js FIELD_TYPE_SINCE, TEXT_FORMATS, FIELD_DISPLAY):
 * what the model validator checks on save, and what a record write checks per value.
 *
 *   field.format   'email' | 'url' | 'phone' on a text field: every written value must be one.
 *   field.display  { currency, decimals, unit, dateStyle }: how a value is shown. Checked on
 *                  save only; nothing of it reaches the write path or the DDL.
 *   autonumber     server-assigned, always unique, no default, never required.
 *   json           a written string must BE JSON text; any other value is serialised.
 *
 * A field that uses none of these is never looked at, so an existing model and every write to it
 * behave exactly as before. The checks read the value character by character (no regular
 * expression over user input), and a sentence names the field label, never the value.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
export type ShapeField = {
    key?: string; name?: string; type?: string; format?: unknown; display?: unknown;
    unique?: unknown; required?: unknown; default?: unknown; computed?: unknown;
};

const vocab = nodeRequire('./dataModel/vocabulary') as {
    TEXT_FORMATS: { values: readonly string[] };
    FIELD_DISPLAY: { keys: readonly string[]; dateStyles: readonly string[]; MAX_DECIMALS: number; MAX_UNIT_LEN: number };
};

const isPlainObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v: unknown): boolean => v !== undefined && v !== null;

/** Which field types each display key applies to. */
const DISPLAY_TYPES: Readonly<Record<string, readonly string[]>> = {
    currency: ['number', 'computed'],
    decimals: ['number', 'computed'],
    unit: ['number', 'computed'],
    dateStyle: ['date', 'datetime'],
};

const MAX_EMAIL_LEN = 254;
const MAX_EMAIL_LOCAL_LEN = 64;
const MAX_URL_LEN = 2048;
const MIN_PHONE_DIGITS = 5;
const MAX_PHONE_DIGITS = 20;

// ── Save time ───────────────────────────────────────────────────────

function isCurrencyCode(v: unknown): boolean {
    if (typeof v !== 'string' || v.length !== 3) return false;
    for (const ch of v) if (ch < 'A' || ch > 'Z') return false;
    return true;
}

function displayValueError(key: string, value: unknown): string | null {
    const d = vocab.FIELD_DISPLAY;
    if (key === 'currency') return isCurrencyCode(value) ? null : 'must be a three-letter ISO 4217 code in capitals, like "EUR"';
    if (key === 'decimals') {
        const ok = Number.isInteger(value) && (value as number) >= 0 && (value as number) <= d.MAX_DECIMALS;
        return ok ? null : `must be a whole number from 0 to ${d.MAX_DECIMALS}`;
    }
    if (key === 'unit') {
        const ok = typeof value === 'string' && value.trim() !== '' && value.length <= d.MAX_UNIT_LEN;
        return ok ? null : `must be a non-empty text of at most ${d.MAX_UNIT_LEN} characters`;
    }
    return d.dateStyles.includes(value as string) ? null : `must be one of: ${d.dateStyles.join(', ')}`;
}

function displayErrors(field: ShapeField, display: Obj, at: string): string[] {
    const errors: string[] = [];
    const type = String(field.type);
    for (const [key, value] of Object.entries(display)) {
        if (!vocab.FIELD_DISPLAY.keys.includes(key)) { errors.push(`${at}.display has an unknown key "${key}" (known: ${vocab.FIELD_DISPLAY.keys.join(', ')})`); continue; }
        if (!present(value)) continue;
        const types = DISPLAY_TYPES[key];
        if (!types.includes(type)) { errors.push(`${at}.display.${key} does not apply to a ${type} field (only ${types.join(', ')})`); continue; }
        const problem = displayValueError(key, value);
        if (problem) errors.push(`${at}.display.${key} ${problem}`);
    }
    if (present(display.currency) && present(display.unit)) errors.push(`${at}.display has both currency and unit; keep one`);
    return errors;
}

function formatErrors(field: ShapeField, at: string): string[] {
    if (!vocab.TEXT_FORMATS.values.includes(field.format as string)) {
        return [`${at}.format ${JSON.stringify(field.format)} is not one of: ${vocab.TEXT_FORMATS.values.join(', ')}`];
    }
    return field.type === 'text' ? [] : [`${at}.format applies to a text field, not ${field.type}`];
}

function autonumberErrors(field: ShapeField, at: string): string[] {
    const errors: string[] = [];
    if (field.unique !== true) errors.push(`${at} (autonumber) is always unique: set unique to true`);
    if (field.required === true) errors.push(`${at} (autonumber) is filled by the server: required does not apply`);
    if (present(field.default)) errors.push(`${at} (autonumber) is filled by the server: it takes no default`);
    return errors;
}

function jsonDefaultErrors(field: ShapeField, at: string): string[] {
    if (!present(field.default)) return [];
    return typeof field.default === 'string' && parsesAsJson(field.default) ? [] : [`${at}.default of a json field must be JSON text`];
}

/**
 * The model validator's check of one field's schema-3 shape (each key optional; null counts as
 * absent). Messages, empty when the field is fine or uses none of it.
 */
export function fieldShapeErrors(field: ShapeField, at: string): string[] {
    const errors: string[] = [];
    if (present(field.format)) errors.push(...formatErrors(field, at));
    if (present(field.display)) {
        if (!isPlainObject(field.display)) errors.push(`${at}.display must be an object`);
        else errors.push(...displayErrors(field, field.display, at));
    }
    if (field.type === 'autonumber') errors.push(...autonumberErrors(field, at));
    if (field.type === 'json') errors.push(...jsonDefaultErrors(field, at));
    return errors;
}

// ── Write time ──────────────────────────────────────────────────────

function parsesAsJson(s: string): boolean {
    try { JSON.parse(s); return true; } catch { return false; }
}

/** A character a written address or link never holds: whitespace, control characters, quotes and angle brackets. */
function isForbiddenChar(ch: string): boolean {
    return ch <= ' ' || ch === '\u007f' || ch === '"' || ch === '<' || ch === '>' || ch === '\\';
}

function hasForbiddenChar(s: string): boolean {
    for (const ch of s) if (isForbiddenChar(ch)) return true;
    return false;
}

function isEmail(s: string): boolean {
    if (s.length > MAX_EMAIL_LEN || hasForbiddenChar(s)) return false;
    const at = s.lastIndexOf('@');
    if (at <= 0 || s.indexOf('@') !== at || at > MAX_EMAIL_LOCAL_LEN) return false;
    const domain = s.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    return dot > 0 && dot < domain.length - 2 && !domain.startsWith('-') && !domain.includes('..');
}

function isWebUrl(s: string): boolean {
    if (s.length > MAX_URL_LEN || hasForbiddenChar(s)) return false;
    const lower = s.toLowerCase();
    if (!lower.startsWith('https://') && !lower.startsWith('http://')) return false;
    try { return new URL(s).hostname !== ''; } catch { return false; }
}

const PHONE_PUNCTUATION = new Set([' ', '-', '(', ')', '.', '/']);

function isPhone(s: string): boolean {
    let digits = 0;
    for (const [i, ch] of [...s].entries()) {
        if (ch >= '0' && ch <= '9') digits += 1;
        else if (ch === '+' && i === 0) continue;
        else if (!PHONE_PUNCTUATION.has(ch)) return false;
    }
    return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS;
}

const FORMAT_CHECKS: Readonly<Record<string, { ok: (s: string) => boolean; noun: string }>> = {
    email: { ok: isEmail, noun: 'an e-mail address' },
    url: { ok: isWebUrl, noun: 'a web address starting with https:// or http://' },
    phone: { ok: isPhone, noun: 'a phone number' },
};

/** Does a field need a per-value check at write time? (a text format, or a json field) */
export function hasValueShape(field: ShapeField): boolean {
    if (field.type === 'json') return true;
    return field.type === 'text' && typeof field.format === 'string' && Object.hasOwn(FORMAT_CHECKS, field.format);
}

/**
 * The sentence for a written (non-empty) value that does not have the field's shape, or null when
 * it does. Only the shapes above; the validation rules stay in fieldRules.mts.
 */
export function valueShapeProblem(field: ShapeField, value: unknown, label: string): string | null {
    if (field.type === 'json') {
        if (typeof value !== 'string') return null;
        return parsesAsJson(value) ? null : `"${label}" must be valid JSON.`;
    }
    const check = typeof field.format === 'string' && Object.hasOwn(FORMAT_CHECKS, field.format) ? FORMAT_CHECKS[field.format] : null;
    if (!check) return null;
    return check.ok(String(value).trim()) ? null : `"${label}" must be ${check.noun}.`;
}
