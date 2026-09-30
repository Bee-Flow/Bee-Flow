/**
 * A spreadsheet file → rows the bulk import accepts.
 *
 * Port of App Studio's spreadsheetPaste.js, which the web's datatable import
 * panel shares on purpose: sniffing tab vs semicolon vs comma (a .csv saved on
 * a Dutch machine is semicolon-separated), the quoting rules Excel writes,
 * ja/nee → yes/no, and "1.234,56" and "1,234.56" as the same amount. Pinned by
 * csvImport.lockstep.test.ts, which runs the web module on the same text.
 *
 * One difference, deliberately: a cell that will not convert answers a CODE
 * (and the text it choked on) instead of an English sentence, so the phone can
 * word it through the catalogue. Nothing here talks to the network.
 */

import { optionPairs } from './cellValues';
import type { Column } from './types';

const DELIMITERS = ['\t', ';', ','] as const;
const SNIFF_BYTES = 4096;
const YES = new Set(['yes', 'y', 'true', '1', 'x', 'ja', 'waar', 'on']);
const NO = new Set(['no', 'n', 'false', '0', '', 'nee', 'onwaar', 'off']);
const LIST_SPLIT = /[,;|]/;

export interface Parsed {
    header: string[];
    rows: string[][];
    delimiter: string;
}

function parseRows(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quoted) {
            if (ch !== '"') field += ch;
            else if (text[i + 1] === '"') { field += '"'; i += 1; }
            else quoted = false;
            continue;
        }
        if (ch === '"' && field === '') quoted = true;
        else if (ch === delimiter) { row.push(field); field = ''; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += ch;
    }
    row.push(field);
    rows.push(row);
    return rows;
}

/** The separator that splits the first line into the most columns. */
function sniffDelimiter(text: string): string {
    const sample = text.slice(0, SNIFF_BYTES);
    let best: string = DELIMITERS[0];
    let width = 0;
    for (const d of DELIMITERS) {
        const first = parseRows(sample, d)[0] ?? [];
        if (first.length > width) { best = d; width = first.length; }
    }
    return best;
}

/** Split file text into a header row plus data rows; blank lines drop. A BOM is not a header. */
export function parsePasted(text: unknown): Parsed {
    const raw = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (!raw.trim()) return { header: [], rows: [], delimiter: DELIMITERS[0] };
    const delimiter = sniffDelimiter(raw);
    const all = parseRows(raw, delimiter);
    const header = (all[0] ?? []).map((h) => h.trim());
    const rows = all.slice(1).filter((cells) => cells.some((c) => c.trim() !== ''));
    return { header, rows, delimiter };
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Pre-match each file column to a table column by its name or its key,
 * ignoring case, spaces and punctuation. Unmatched maps to '' ("don't import
 * this one"); one column is never claimed twice.
 */
export function suggestMapping(header: readonly string[], fields: readonly Pick<Column, 'key' | 'name'>[]): string[] {
    const taken = new Set<string>();
    return header.map((h) => {
        const n = norm(h);
        if (!n) return '';
        const hit = fields.find((f) => !taken.has(f.key) && (norm(f.name) === n || norm(f.key) === n));
        if (!hit) return '';
        taken.add(hit.key);
        return hit.key;
    });
}

/** A number as a spreadsheet wrote it; the LAST separator is the decimal point. */
export function parseNumberish(text: unknown): number {
    let s = String(text ?? '').trim().replace(/[\s ]/g, '').replace(/^[€$£]|[€$£]$/g, '');
    if (!s) return NaN;
    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    if (hasDot && hasComma) {
        const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
        const grouping = decimal === ',' ? '.' : ',';
        s = s.split(grouping).join('').replace(decimal, '.');
    } else if (hasComma) {
        s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.split(',').join('') : s.replace(',', '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
        s = s.split('.').join('');
    }
    return /^-?\d*\.?\d+$/.test(s) ? Number(s) : NaN;
}

const pad = (n: number) => String(n).padStart(2, '0');

function calendarDate(y: number, m: number, d: number): string | null {
    if (m < 1 || m > 12 || d < 1) return null;
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
}

/** ISO first, then the day-before-month spellings used across Europe. */
export function parseDateish(text: unknown): string | null {
    const s = String(text ?? '').trim();
    if (!s) return null;
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const parts = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (!parts) return null;
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    const year = Number(parts[3]);
    if (b > 12 && a <= 12) return calendarDate(year, a, b);
    return calendarDate(year, b, a);
}

/** A datetime cell: its date and its 'HH:mm' clock time, if any. */
export function parseDatetimeish(text: unknown): string | null {
    const s = String(text ?? '').trim();
    const m = s.match(/^(.*?)[T\s]+(\d{1,2}):(\d{2})(?::\d{2})?/);
    const date = parseDateish(m ? m[1] : s);
    if (!date) return null;
    if (!m) return `${date}T00:00`;
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    if (hh > 23 || mm > 59) return null;
    return `${date}T${pad(hh)}:${pad(mm)}`;
}

function matchChoice(text: string, field: Pick<Column, 'options'>): string | null {
    const wanted = norm(text);
    const hit = optionPairs(field).find((o) => norm(o.value) === wanted || norm(o.label) === wanted);
    return hit ? hit.value : null;
}

export type CellErrorCode = 'required' | 'number' | 'yesno' | 'date' | 'datetime' | 'choice';

/** Why a cell would not convert, and the text it would not convert. */
export interface CellError {
    code: CellErrorCode;
    text: string;
}

type Coerced = { value: unknown; error: CellError | null };
const ok = (value: unknown): Coerced => ({ value, error: null });
const bad = (code: CellErrorCode, text: string): Coerced => ({ value: null, error: { code, text } });

function coerceChoice(text: string, field: Pick<Column, 'type' | 'options'>): Coerced {
    if (field.type === 'select') {
        const v = matchChoice(text, field);
        return v !== null ? ok(v) : bad('choice', text);
    }
    const picked: string[] = [];
    for (const part of text.split(LIST_SPLIT).map((p) => p.trim()).filter(Boolean)) {
        const v = matchChoice(part, field);
        if (v === null) return bad('choice', part);
        picked.push(v);
    }
    return ok(picked);
}

/** The converters for the types that are not free text. */
const CONVERT: Readonly<Record<string, (text: string, field: Pick<Column, 'type' | 'options'>) => Coerced>> = {
    number: (text) => {
        const n = parseNumberish(text);
        return Number.isFinite(n) ? ok(n) : bad('number', text);
    },
    bool: (text) => {
        const t = text.toLowerCase();
        if (YES.has(t)) return ok(true);
        return NO.has(t) ? ok(false) : bad('yesno', text);
    },
    date: (text) => {
        const d = parseDateish(text);
        return d ? ok(d) : bad('date', text);
    },
    datetime: (text) => {
        const d = parseDatetimeish(text);
        return d ? ok(d) : bad('datetime', text);
    },
    select: coerceChoice,
    multiselect: coerceChoice,
};

/** One file cell for one column. */
export function coerceCell(raw: unknown, field: Pick<Column, 'type' | 'options' | 'required'>): Coerced {
    const text = String(raw ?? '').trim();
    const type = field.type || 'text';
    if (text === '') {
        if (field.required && type !== 'bool') return bad('required', text);
        return ok(type === 'bool' ? false : null);
    }
    const convert = CONVERT[type];
    return convert ? convert(text, field) : ok(text);
}

export interface ImportRow {
    /** The row's line in the file, counting the header as line 1. */
    line: number;
    values: Record<string, unknown>;
    problems: { column: string; error: CellError }[];
}

/** Apply a mapping. A cell left empty is omitted, so the column's own default applies. */
export function buildImportRows(parsed: Parsed, mapping: readonly string[], fields: readonly Column[]): ImportRow[] {
    const byKey = new Map(fields.map((f) => [f.key, f]));
    return parsed.rows.map((cells, index) => {
        const values: Record<string, unknown> = {};
        const problems: ImportRow['problems'] = [];
        mapping.forEach((key, col) => {
            const field = key ? byKey.get(key) : undefined;
            if (!field) return;
            const { value, error } = coerceCell(cells[col], field);
            if (error) problems.push({ column: parsed.header[col] || `#${col + 1}`, error });
            else if (value !== null) values[key] = value;
        });
        return { line: index + 2, values, problems };
    });
}
