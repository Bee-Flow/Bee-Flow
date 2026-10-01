/**
 * The Extract-data step: its declared fields ARE its output, so the rules here
 * mirror server/automation/validate/stepRules.js — an unknown type, a bad name
 * or a duplicate is an INTEGRITY error there and would 400 the autosave. From
 * agent-hub `Builder/flow/settings/formState.js`; pinned by
 * formState.lockstep.test.ts.
 */

import { applyForEachPatch } from './common';
import type { Extractor, Patcher } from './types';

export const EXTRACTION_FIELD_TYPES: readonly string[] = ['string', 'number', 'boolean', 'date'];
export const MAX_EXTRACTION_FIELDS = 30;
export const MAX_EXTRACTION_INSTRUCTIONS = 2000;
/** Lower snake: these become `steps.<id>.output.<name>` and every later binding spells them. */
export const EXTRACTION_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

export interface ExtractionField {
    name: string;
    type: string;
    description: string;
    required: boolean;
}

/** The row the panel opens on and "Add field" appends. */
export function emptyExtractionField(): ExtractionField {
    return { name: '', type: 'string', description: '', required: false };
}

/** What a person types → a legal field name, live: "Invoice Date" → "invoice_date". */
export function coerceExtractionName(raw: unknown): string {
    return String(raw || '')
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/^[^a-z]+/, '')
        .slice(0, 40);
}

/** Nothing bound yet: absent, null, or a binding with nothing in it. */
export function isEmptyExtractionSource(b: unknown): boolean {
    if (b == null || typeof b !== 'object') return true;
    const v = b as Record<string, unknown>;
    if (v.kind === 'ref') return !String(v.path || '').trim();
    if (v.kind === 'literal') return v.value == null || String(v.value).trim() === '';
    if (v.kind === 'template' || v.kind === 'expr') return !String(v.value || '').trim();
    return false;
}

function fieldType(t: unknown): string {
    return EXTRACTION_FIELD_TYPES.includes(t as string) ? (t as string) : 'string';
}

/** Every row in the four-key shape the editor binds to, plus one blank row when there are none. */
export function readExtractionFields(raw: unknown): ExtractionField[] {
    const rows = (Array.isArray(raw) ? raw : [])
        .filter((f) => f && typeof f === 'object')
        .map((f) => ({
            name: typeof f.name === 'string' ? f.name : '',
            type: fieldType(f.type),
            description: typeof f.description === 'string' ? f.description : '',
            required: f.required === true,
        }));
    return rows.length ? rows : [emptyExtractionField()];
}

/**
 * The rows for the wire: blank names and later duplicates drop (the panel marks
 * the duplicate), types outside the enum become string, optional keys are only
 * written when they say something, capped at 30.
 */
export function sanitizeExtractionFields(fields: unknown): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const f of Array.isArray(fields) ? fields : []) {
        if (!f || typeof f !== 'object') continue;
        const name = coerceExtractionName(f.name);
        if (!name || !EXTRACTION_NAME_RE.test(name) || seen.has(name)) continue;
        seen.add(name);
        const row: Record<string, unknown> = { name, type: fieldType(f.type) };
        if (typeof f.description === 'string' && f.description.trim()) row.description = f.description.trim();
        if (f.required === true) row.required = true;
        out.push(row);
        if (out.length >= MAX_EXTRACTION_FIELDS) break;
    }
    return out;
}

export const extractDataExtraction: Extractor = (step, base) => ({
    ...base,
    // An absent source opens as an EMPTY REF, so a dragged value lands as a bare ref.
    source: isEmptyExtractionSource(step.source) ? { kind: 'ref', path: '' } : step.source,
    fields: readExtractionFields(step.fields),
    instructions: typeof step.instructions === 'string' ? step.instructions : '',
    forEach: step.forEach || null,
    repeat: step.repeat || null,
});

/** `(v || '').slice(0, MAX) || undefined`, arrays and all, as the web writes it. */
function clipped(v: unknown): unknown {
    const src = v || '';
    const cut = Array.isArray(src) ? src.slice(0, MAX_EXTRACTION_INSTRUCTIONS) : String(src).slice(0, MAX_EXTRACTION_INSTRUCTIONS);
    return cut || undefined;
}

export const patchDataExtraction: Patcher = (patch, step, draft) => {
    // Absent, not null, when nothing is bound — `source_missing` then autosaves amber.
    patch.source = isEmptyExtractionSource(draft.source) ? undefined : draft.source;
    patch.fields = sanitizeExtractionFields(draft.fields);
    patch.instructions = clipped(draft.instructions);
    applyForEachPatch(patch, step, draft);
};

