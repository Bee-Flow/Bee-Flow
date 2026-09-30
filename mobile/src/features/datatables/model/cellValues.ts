/**
 * How ONE cell value reads, and how it travels into an editor.
 *
 * The web's row browser formats cells with App Studio's rowValues.js (it takes
 * the FIELD rather than a type string, so a select shows its label and a
 * multiselect its list) over the runtime's displayValue. This is the port of
 * both, pinned by cellValues.lockstep.test.ts. Rows arrive exactly as Postgres
 * answered: a yes/no may be a boolean or 0/1, a multiselect a JSON string or an
 * array, a NUMERIC a numeric string.
 *
 * The web says "Yes"/"No" in English; the phone passes translated words in.
 */

import type { Column } from './types';

export const EM_DASH = '—';

export interface YesNo {
    yes: string;
    no: string;
}

const ENGLISH: YesNo = { yes: 'Yes', no: 'No' };
const OBJECT_LABEL_KEYS = ['name', 'title', 'label', 'value'];

/** A choice as the model stores it — options are strings OR { value, label }. */
export function optionPair(option: unknown): { value: string; label: string } {
    if (option && typeof option === 'object') {
        const o = option as { value?: unknown; label?: unknown };
        const value = o.value ?? o.label ?? '';
        return { value: String(value), label: String(o.label ?? value) };
    }
    return { value: String(option ?? ''), label: String(option ?? '') };
}

/** The usable choices of a select/multiselect column (blank placeholders drop). */
export function optionPairs(field: Pick<Column, 'options'> | null | undefined): { value: string; label: string }[] {
    const raw: unknown[] = Array.isArray(field?.options) ? field.options : [];
    return raw.map(optionPair).filter((o) => o.value !== '');
}

/** Multiselect/file values arrive as a JSON string or an array; a single value as itself. */
export function listValue(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim().startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return value == null || value === '' ? [] : [value];
}

/** 0/1 and their text forms mean no/yes. */
export function boolValue(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const t = String(value ?? '').trim().toLowerCase();
    return t === '1' || t === 'true' || t === 'yes';
}

function summarize(value: object, words: YesNo): string {
    if (Array.isArray(value)) {
        if (value.length === 0) return EM_DASH;
        if (value.length > 1) return `${value.length.toLocaleString()} items`;
        const only: unknown = value[0];
        return only == null || typeof only !== 'object' ? displayValue(only, words) : '1 item';
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? EM_DASH : value.toLocaleDateString();
    const record = value as Record<string, unknown>;
    for (const key of OBJECT_LABEL_KEYS) {
        const inner = record[key];
        if (inner != null && inner !== '' && typeof inner !== 'object') return displayValue(inner, words);
    }
    const count = Object.keys(record).length;
    return count ? `${count.toLocaleString()} fields` : EM_DASH;
}

/** A leaf value for display; empty renders as an em-dash, never as a real value. */
export function displayValue(value: unknown, words: YesNo = ENGLISH): string {
    if (value == null || value === '') return EM_DASH;
    if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : EM_DASH;
    if (typeof value === 'boolean') return value ? words.yes : words.no;
    if (typeof value === 'object') return summarize(value, words);
    return String(value);
}

/**
 * The text a read-only cell shows. Dates keep their stored spelling: a bare
 * date has no time zone, so formatting it through Date would shift the day for
 * every viewer west of Greenwich.
 */
export function cellText(value: unknown, field: Pick<Column, 'type' | 'options'> | null | undefined, words: YesNo = ENGLISH): string {
    const type = field?.type || 'text';
    if (type === 'bool') return boolValue(value) ? words.yes : words.no;
    if (type === 'multiselect' || type === 'file') {
        const list = listValue(value);
        return list.length ? list.map((v) => optionPair(v).label).join(', ') : displayValue(null, words);
    }
    if (type === 'date' || type === 'datetime') {
        const text = String(value ?? '').replace('T', ' ');
        return text || displayValue(null, words);
    }
    if (type === 'select') {
        const match = optionPairs(field).find((o) => o.value === String(value ?? ''));
        return match ? match.label : displayValue(value, words);
    }
    return displayValue(value, words);
}

/** What a date field edits: 'YYYY-MM-DD', or 'YYYY-MM-DDTHH:mm' for a datetime. */
export function dateInputValue(value: unknown, type: string): string {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return type === 'datetime' ? text.replace(' ', 'T').slice(0, 16) : text.slice(0, 10);
}
