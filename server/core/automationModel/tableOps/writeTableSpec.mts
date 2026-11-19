/**
 * The `write_table` step: its settings, their defaults and the findings a bad
 * setting produces. Pure: no writer, no storage, no run. The executor
 * (core/automationRunner/execWriteTable.mts) and the validator
 * (automation/validate/stepRules/tableRules.js) both read this file, so the
 * step is clamped and judged by one set of rules.
 *
 * Config: { type:'write_table', id, label, source: Binding, format: 'xlsx'|'csv',
 *   fileName, sheetName, columns: [{ column, header? }], highlightColumn,
 *   delimiter (csv), expiresInDays, forEach? }
 *
 * The counterpart of read_table: a table (a handle from read_table / table, or
 * a list of rows) becomes a file of the run, a `generated_file` the later steps
 * pass on like a generated document.
 */

export const WRITE_TABLE_FORMATS = Object.freeze(['xlsx', 'csv'] as const);
export const WRITE_TABLE_DELIMITERS = Object.freeze([';', ',', '\t'] as const);
export const EXPIRES_MIN_DAYS = 1;
export const EXPIRES_MAX_DAYS = 90;
export const EXPIRES_DEFAULT_DAYS = 7;
export const MAX_COLUMNS = 500;
const MAX_NAME_CHARS = 200;

export type WriteTableFormat = typeof WRITE_TABLE_FORMATS[number];
export type WriteTableDelimiter = typeof WRITE_TABLE_DELIMITERS[number];

export interface Finding { code: string; severity: 'error' | 'warning'; path: string; message: string; hint?: string }

export interface OutputColumn { column: string; header: string | null }

export interface WriteTableSpec {
    source: unknown;
    format: WriteTableFormat;
    fileName: string;
    sheetName: string;
    columns: OutputColumn[];
    highlightColumn: string | null;
    delimiter: WriteTableDelimiter;
    expiresInDays: number;
}

export const DEFAULTS = Object.freeze({
    format: 'xlsx' as WriteTableFormat,
    fileName: '',
    sheetName: '',
    // Dutch Excel's list separator, like the other CSV writer (office/officegen.js buildCsv).
    delimiter: ';' as WriteTableDelimiter,
    expiresInDays: EXPIRES_DEFAULT_DAYS,
});

type Rec = Record<string, unknown>;
const isObject = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function delimiterOf(raw: unknown): string {
    if (raw === 'tab' || raw === '\\t') return '\t';
    return typeof raw === 'string' && raw !== '' ? raw : DEFAULTS.delimiter;
}

function wholeNumber(raw: unknown): number | null {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** A column entry: a name, or { column, header }. `key` / `label` are read as their aliases. */
function columnOf(raw: unknown): OutputColumn | null {
    if (typeof raw === 'string' || typeof raw === 'number') {
        const column = text(raw);
        return column ? { column: column.slice(0, MAX_NAME_CHARS), header: null } : null;
    }
    if (!isObject(raw)) return null;
    const column = text(raw.column ?? raw.key);
    if (!column) return null;
    const header = text(raw.header ?? raw.label);
    return { column: column.slice(0, MAX_NAME_CHARS), header: header ? header.slice(0, MAX_NAME_CHARS) : null };
}

/**
 * The step with every setting present and in range. An invalid value is
 * replaced by its default; validateWriteTableStep is what reports it.
 */
export function normalizeWriteTableStep(step: unknown): WriteTableSpec {
    const s = isObject(step) ? step : {};
    const format = (WRITE_TABLE_FORMATS as readonly string[]).includes(String(s.format)) ? s.format as WriteTableFormat : DEFAULTS.format;
    const delimiter = delimiterOf(s.delimiter);
    const days = wholeNumber(s.expiresInDays);
    return {
        source: s.source === undefined ? null : s.source,
        format,
        fileName: typeof s.fileName === 'string' ? s.fileName : DEFAULTS.fileName,
        sheetName: text(s.sheetName).slice(0, MAX_NAME_CHARS),
        columns: (Array.isArray(s.columns) ? s.columns : []).map(columnOf).filter((c): c is OutputColumn => c !== null).slice(0, MAX_COLUMNS),
        highlightColumn: text(s.highlightColumn).slice(0, MAX_NAME_CHARS) || null,
        delimiter: (WRITE_TABLE_DELIMITERS as readonly string[]).includes(delimiter) ? delimiter as WriteTableDelimiter : DEFAULTS.delimiter,
        expiresInDays: days === null ? DEFAULTS.expiresInDays : Math.min(EXPIRES_MAX_DAYS, Math.max(EXPIRES_MIN_DAYS, Math.round(days))),
    };
}

function sourceFindings(source: unknown): Finding[] {
    const missing: Finding = {
        code: 'write_table.source_missing', severity: 'error', path: 'source',
        message: 'Choose the table to write.',
        hint: 'Bind the source to a table (steps.<id>.output.table of a read_table or table step) or to a list of rows.',
    };
    if (source === undefined || source === null || source === '') return [missing];
    if (!isObject(source) || typeof source.kind !== 'string') {
        return [{ ...missing, code: 'write_table.source_literal', severity: 'warning', message: 'The source is typed in as plain text, but a table cannot be typed in.' }];
    }
    if (source.kind === 'ref' && !text(source.path)) return [missing];
    if ((source.kind === 'template' || source.kind === 'expr') && !text(source.value)) return [missing];
    if (source.kind === 'literal' && (source.value === undefined || source.value === null || source.value === '')) return [missing];
    return [];
}

const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const error = (code: string, path: string, message: string, hint?: string): Finding =>
    ({ code: `write_table.${code}`, severity: 'error', path, message, ...(hint ? { hint } : {}) });

function columnsFinding(columns: unknown): Finding | null {
    if (columns === undefined || columns === null) return null;
    if (!Array.isArray(columns) || columns.some((c) => columnOf(c) === null)) {
        return error('columns_invalid', 'columns', 'Each output column names a column of the table, with an optional header.', 'Leave the list empty to write every column.');
    }
    return columns.length > MAX_COLUMNS ? error('columns_invalid', 'columns', `At most ${MAX_COLUMNS} output columns.`) : null;
}

function expiresFinding(raw: unknown): Finding | null {
    if (!given(raw)) return null;
    const n = wholeNumber(raw);
    const ok = n !== null && Number.isInteger(n) && n >= EXPIRES_MIN_DAYS && n <= EXPIRES_MAX_DAYS;
    return ok ? null : error('expires_invalid', 'expiresInDays', `The file is kept for a whole number of days from ${EXPIRES_MIN_DAYS} to ${EXPIRES_MAX_DAYS}.`);
}

export function validateWriteTableStep(step: unknown): Finding[] {
    const s = isObject(step) ? step : {};
    const found: Array<Finding | null> = [
        given(s.format) && !(WRITE_TABLE_FORMATS as readonly string[]).includes(String(s.format))
            ? error('format_invalid', 'format', `The file format must be one of: ${WRITE_TABLE_FORMATS.join(', ')}.`) : null,
        given(s.delimiter) && !(WRITE_TABLE_DELIMITERS as readonly string[]).includes(delimiterOf(s.delimiter))
            ? error('delimiter_invalid', 'delimiter', 'The delimiter must be a semicolon, a comma or a tab.') : null,
        columnsFinding(s.columns),
        expiresFinding(s.expiresInDays),
        text(s.highlightColumn) && String(s.format) === 'csv' ? {
            code: 'write_table.highlight_in_csv', severity: 'warning', path: 'highlightColumn',
            message: 'A CSV file has no colours, so the highlighted rows are not marked.', hint: 'Choose xlsx to mark those rows.',
        } : null,
    ];
    return [...sourceFindings(s.source), ...found.filter((f): f is Finding => f !== null)];
}
