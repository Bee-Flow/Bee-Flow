// ── data_extraction ─────────────────────────────────────────────────────
// The field schema of the data_extraction step: what a row may say, how a
// typed name becomes a legal output key, and what the wire may carry.
//
// The four types the extraction step can ask for. `date` is an ISO YYYY-MM-DD
// string; `number` is coerced by the runner from European forms too. Mirrors
// server/automation/validate/stepRules.js — an unknown type there is an
// INTEGRITY error, so nothing here may let one through.

import type { FormRecord, JsonValue } from './types';

export const EXTRACTION_FIELD_TYPES = ['string', 'number', 'boolean', 'date'];
export const MAX_EXTRACTION_FIELDS = 30;
export const MAX_EXTRACTION_INSTRUCTIONS = 2000;
// `[a-z][a-z0-9_]{0,39}` — lowercase snake, because these become the output
// keys (`steps.<id>.output.<name>`) and every later binding spells them.
export const EXTRACTION_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The row the panel opens on and "Add field" appends. */
export function emptyExtractionField(): FormRecord {
    return { name: '', type: 'string', description: '', required: false };
}

/**
 * What a person types → a legal field name, live: "Invoice Date" → "invoice_date",
 * "€ totaal" → "totaal". Lower-cases, turns runs of space/dash into one
 * underscore, drops anything else, strips leading non-letters and caps at 40.
 * Coercing as they type (rather than rejecting on save) means what is on
 * screen is what gets saved, and the server never sees an invalid name.
 */
export function coerceExtractionName(raw: JsonValue): string {
    return String(raw || '')
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/^[^a-z]+/, '')
        .slice(0, 40);
}

/**
 * Nothing bound yet. Absent, null, or any binding kind with nothing in it —
 * the same idea as mapping/boundPaths.isEmptyValue, kept local because this
 * module is React-free and must not pull the mapping layer in.
 */
export function isEmptyExtractionSource(b: JsonValue): boolean {
    if (b == null || typeof b !== 'object') return true;
    if (b.kind === 'ref') return !String(b.path || '').trim();
    if (b.kind === 'literal') return b.value == null || String(b.value).trim() === '';
    if (b.kind === 'template' || b.kind === 'expr') return !String(b.value || '').trim();
    return false;
}

/**
 * The draft's rows: every persisted row normalised to the full four-key shape
 * the editor binds to, plus one blank row when there are none (see
 * extractFormState). Order is preserved — it is the order the prompt lists
 * the fields in and the order the output panel shows them.
 */
export function readExtractionFields(raw: JsonValue): FormRecord[] {
    const rows = (Array.isArray(raw) ? raw : [])
        .filter(f => f && typeof f === 'object')
        .map(f => ({
            name: typeof f.name === 'string' ? f.name : '',
            type: EXTRACTION_FIELD_TYPES.includes(f.type) ? f.type : 'string',
            description: typeof f.description === 'string' ? f.description : '',
            required: f.required === true,
        }));
    return rows.length ? rows : [emptyExtractionField()];
}

/**
 * Sanitize the extraction fields ARRAY for the wire. Blank-name rows are
 * dropped (they are the panel's pending rows, see sanitizeParseJsonFields for
 * the philosophy); a later row that repeats an earlier name is dropped too,
 * because `fields_duplicate` is an INTEGRITY code and would 400 the autosave
 * — the panel marks the duplicate amber so the author sees why it is not
 * saved. Types outside the enum fall back to string; `description` and
 * `required` are only written when they say something, so a step saved from
 * the form is the same object the AI builder produces. Capped at 30.
 */
export function sanitizeExtractionFields(fields: JsonValue): FormRecord[] {
    const out: FormRecord[] = [];
    const seen = new Set<string>();
    for (const f of (Array.isArray(fields) ? fields : [])) {
        if (!f || typeof f !== 'object') continue;
        const name = coerceExtractionName(f.name);
        if (!name || !EXTRACTION_NAME_RE.test(name) || seen.has(name)) continue;
        seen.add(name);
        const row: FormRecord = { name, type: EXTRACTION_FIELD_TYPES.includes(f.type) ? f.type : 'string' };
        if (typeof f.description === 'string' && f.description.trim()) row.description = f.description.trim();
        if (f.required === true) row.required = true;
        out.push(row);
        if (out.length >= MAX_EXTRACTION_FIELDS) break;
    }
    return out;
}
