/**
 * "Suggest outputs", part one: picking the field a rule compares. What the
 * author NAMES wins over every heuristic; the heuristics never guess below a
 * minimum score, because a rule against the wrong field matches nothing at run
 * time and reports no error. From agent-hub
 * `Builder/flow/settings/routeIntents.js`; pinned by settings.lockstep.test.ts.
 */

import { fileTypeOf } from '@/shared/expr';

export interface IntentField {
    path?: string;
    label?: string;
    sample?: unknown;
    /** A list column of the rule menu (needs a quantifier). */
    quantified?: boolean;
    /** 'records' (a list of records) or 'fileType' (a File type entry). */
    kind?: string;
    [key: string]: unknown;
}

function lastSegment(path: unknown): string {
    const cleaned = String(path || '').replace(/\[(?:\*|\d+)\]/g, '');
    return cleaned.split('.').filter(Boolean).pop() || '';
}

export function fieldKey(field: IntentField | null | undefined): string {
    return lastSegment(field?.path).toLowerCase();
}

const FILE_NAME_KEYS = /^(file|files|filename|file_name|name|path|filepath|attachment|attachments|document)$/;
const TEXT_KEYS = /^(subject|title|name|body|text|message|content|description|summary|snippet)$/;
const NUMBER_KEYS = /(amount|total|price|count|quantity|qty|score|size|bytes|number|age|days)$/;
const DATE_KEYS = /(date|created|updated|modified|due|sent|received|timestamp|time|at)$/;

function bestField(fields: IntentField[], score: (f: IntentField) => number, minimum = 2): IntentField | null {
    let best: IntentField | null = null;
    let bestScore = 0;
    for (const f of fields || []) {
        if (!f?.path) continue;
        const s = score(f);
        if (s > bestScore) {
            best = f;
            bestScore = s;
        }
    }
    return bestScore >= minimum ? best : null;
}

const sampleString = (f: IntentField): string | null => (typeof f.sample === 'string' ? f.sample : null);

/** A file name or MIME type of a known kind ("report.pdf", "image/png"); an address ending in ".nl" is not one. */
function looksLikeFile(sample: string | null): boolean {
    const kind = sample === null ? null : fileTypeOf(sample);
    return kind != null && kind !== 'other';
}

/** A sample that names a known file type beats any name. */
export function pickFileField(fields: IntentField[]): IntentField | null {
    return bestField(fields, (f) => {
        if (Array.isArray(f.sample)) return 0;
        const sample = sampleString(f);
        const hasExt = looksLikeFile(sample);
        const key = fieldKey(f);
        const named = FILE_NAME_KEYS.test(key) ? 2 : key === 'title' ? 1 : 0;
        return (hasExt ? 3 : 0) + named;
    });
}

export function pickTextField(fields: IntentField[]): IntentField | null {
    return bestField(fields, (f) => (typeof f.sample === 'string' ? 1 : 0) + (TEXT_KEYS.test(fieldKey(f)) ? 2 : 0));
}

export function pickNumberField(fields: IntentField[]): IntentField | null {
    return bestField(fields, (f) => (typeof f.sample === 'number' ? 3 : 0) + (NUMBER_KEYS.test(fieldKey(f)) ? 2 : 0));
}

export function pickDateField(fields: IntentField[]): IntentField | null {
    return bestField(fields, (f) => {
        const sample = sampleString(f);
        const dated = sample !== null && /^\d{4}-\d{2}-\d{2}/.test(sample.trim());
        return (dated ? 3 : 0) + (DATE_KEYS.test(fieldKey(f)) ? 2 : 0);
    });
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A field the author NAMED in the description; longest match wins ("from email" over "from"). */
export function namedField(lower: string, fields: IntentField[]): IntentField | null {
    let best: IntentField | null = null;
    let bestLen = 0;
    for (const f of fields || []) {
        if (!f?.path) continue;
        const candidates = [f.label, fieldKey(f).replace(/_/g, ' '), fieldKey(f)].filter(Boolean).map((s) => String(s).toLowerCase());
        for (const c of candidates) {
            if (c.length < 3 || c.length <= bestLen) continue;
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an escapeRe-escaped literal between two single-character alternatives, with no quantifier, so each position costs at most the length of the field name
            if (new RegExp(`(?:^|[^a-z0-9])${escapeRe(c)}(?:[^a-z0-9]|$)`).test(lower)) {
                best = f;
                bestLen = c.length;
            }
        }
    }
    return best;
}
