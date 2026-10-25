// @typecheck
/**
 * The `read_table` step: its settings, their defaults and the findings a bad
 * setting produces. Pure: no parser, no storage, no run. The executor
 * (core/automationRunner/execReadTable.js) and the validator
 * (automation/validate/stepRules/tableRules.js) both read this file, so the
 * step is clamped and judged by one set of rules.
 *
 * Config: { type:'read_table', id, label, source: Binding, sheets, headerRow,
 *   provenanceSheet, format, delimiter, skipHiddenSheets, expiresInDays, forEach? }
 */

'use strict';

/** @typedef {{ code: string, severity: 'error'|'warning', path: string, message: string, hint?: string }} Finding */

const READ_TABLE_FORMATS = Object.freeze(['auto', 'xlsx', 'xlsm', 'xls', 'ods', 'csv']);
const READ_TABLE_DELIMITERS = Object.freeze(['auto', ',', ';', '\t', '|']);
const SHEET_SELECTIONS = Object.freeze(['all', 'first']);
const HEADER_ROW_MIN = 1;
const HEADER_ROW_MAX = 50;
const EXPIRES_MIN_DAYS = 1;
const EXPIRES_MAX_DAYS = 90;
const EXPIRES_DEFAULT_DAYS = 7;
const MAX_SHEET_NAMES = 100;
const MAX_SHEET_NAME_CHARS = 200;

const DEFAULTS = Object.freeze({
    sheets: 'all',
    headerRow: 1,
    provenanceSheet: 'auto',
    format: 'auto',
    delimiter: 'auto',
    skipHiddenSheets: true,
    expiresInDays: EXPIRES_DEFAULT_DAYS,
});

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 'tab' and a typed backslash-t are accepted as the tab character. */
function delimiterOf(raw) {
    if (raw === undefined || raw === null || raw === '') return DEFAULTS.delimiter;
    if (raw === 'tab' || raw === '\\t') return '\t';
    return typeof raw === 'string' ? raw : DEFAULTS.delimiter;
}

/**
 * @param {string} raw
 */
function sheetNamesOf(raw) {
    return (Array.isArray(raw) ? raw : [])
        .filter(n => typeof n === 'string' && n.trim() !== '')
        .map(n => n.slice(0, MAX_SHEET_NAME_CHARS))
        .slice(0, MAX_SHEET_NAMES);
}

/**
 * @param {string} raw
 */
function sheetsOf(raw) {
    if (SHEET_SELECTIONS.includes(raw)) return raw;
    const names = sheetNamesOf(raw);
    return names.length ? names : DEFAULTS.sheets;
}

function wholeNumber(raw) {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(raw, min, max, fallback) {
    const n = wholeNumber(raw);
    return n === null ? fallback : Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * The step with every setting present and in range. An invalid value is clamped
 * or replaced by its default; validateReadTableStep is what reports it.
 * @param {any} step
 */
function normalizeReadTableStep(step) {
    const s = isObject(step) ? step : {};
    return {
        source: s.source === undefined ? null : s.source,
        sheets: sheetsOf(s.sheets),
        headerRow: clampInt(s.headerRow, HEADER_ROW_MIN, HEADER_ROW_MAX, DEFAULTS.headerRow),
        provenanceSheet: typeof s.provenanceSheet === 'string' && s.provenanceSheet.trim() ? s.provenanceSheet.trim() : DEFAULTS.provenanceSheet,
        format: READ_TABLE_FORMATS.includes(s.format) ? s.format : DEFAULTS.format,
        delimiter: READ_TABLE_DELIMITERS.includes(delimiterOf(s.delimiter)) ? delimiterOf(s.delimiter) : DEFAULTS.delimiter,
        skipHiddenSheets: s.skipHiddenSheets !== false,
        expiresInDays: clampInt(s.expiresInDays, EXPIRES_MIN_DAYS, EXPIRES_MAX_DAYS, DEFAULTS.expiresInDays),
    };
}

/** A literal that is already a file descriptor or a handle is a legitimate (pasted) source. */
function isFileLiteral(value) {
    return isObject(value) && (isObject(value.sourceHandle) || value.kind === 'form_upload' || value.kind === 'generated_file');
}

/** @returns {Finding[]} */
function sourceFindings(source) {
    /** @type {Finding} */
    const missing = {
        code: 'read_table.source_missing', severity: 'error', path: 'source',
        message: 'Choose the file to read.',
        hint: 'Bind the source to a form file answer (trigger.output.<field>) or to a file an earlier step made (steps.<id>.output.sourceHandle).',
    };
    if (source === undefined || source === null || source === '') return [missing];
    if (!isObject(source) || typeof source.kind !== 'string') {
        return [{ ...missing, code: 'read_table.source_literal', severity: /** @type {const} */ ('warning'), message: 'The source is typed in as plain text, but a file cannot be typed in.' }];
    }
    if (source.kind === 'ref' && !(typeof source.path === 'string' && source.path.trim())) return [missing];
    if ((source.kind === 'template' || source.kind === 'expr') && !(typeof source.value === 'string' && source.value.trim())) return [missing];
    if (source.kind === 'literal') {
        if (source.value === undefined || source.value === null || source.value === '') return [missing];
        if (isFileLiteral(source.value)) return [];
        return [{
            code: 'read_table.source_literal', severity: /** @type {const} */ ('warning'), path: 'source',
            message: 'The source is a fixed value, but this step reads an uploaded or generated file.',
            hint: 'Bind it to a form file answer or to a generated file instead.',
        }];
    }
    return [];
}

/**
 * @param {any} step
 * @returns {Finding[]}
 */
function validateReadTableStep(step) {
    const s = isObject(step) ? step : {};
    const out = [...sourceFindings(s.source)];
    /**
     * @type {(code: string, path: string, message: string, hint?: string) => void}
     * @param {string} code
     * @param {string} path
     * @param {string} message
     * @param {string} [hint]
     */
    const err = (code, path, message, hint) => { out.push({ code: `read_table.${code}`, severity: 'error', path, message, ...(hint ? { hint } : {}) }); };

    if (s.headerRow !== undefined && s.headerRow !== null) {
        const n = wholeNumber(s.headerRow);
        if (n === null || !Number.isInteger(n) || n < HEADER_ROW_MIN || n > HEADER_ROW_MAX) {
            err('header_row_invalid', 'headerRow', `The header row must be a whole number from ${HEADER_ROW_MIN} to ${HEADER_ROW_MAX}.`);
        }
    }
    if (s.sheets !== undefined && s.sheets !== null) {
        const ok = SHEET_SELECTIONS.includes(s.sheets)
            || (Array.isArray(s.sheets) && s.sheets.length > 0 && s.sheets.length <= MAX_SHEET_NAMES
                && s.sheets.every(n => typeof n === 'string' && n.trim() !== ''));
        if (!ok) err('sheets_invalid', 'sheets', 'Sheets must be "all", "first" or a list of sheet names.', 'Pick the sheets to read, or leave it on all sheets.');
    }
    if (s.format !== undefined && s.format !== null && !READ_TABLE_FORMATS.includes(s.format)) {
        err('format_invalid', 'format', `The file format must be one of: ${READ_TABLE_FORMATS.join(', ')}.`);
    }
    if (s.delimiter !== undefined && s.delimiter !== null && !READ_TABLE_DELIMITERS.includes(delimiterOf(s.delimiter))) {
        err('delimiter_invalid', 'delimiter', 'The delimiter must be auto, a comma, a semicolon, a tab or a bar (|).');
    }
    if (s.expiresInDays !== undefined && s.expiresInDays !== null) {
        const n = wholeNumber(s.expiresInDays);
        if (n === null || !Number.isInteger(n) || n < EXPIRES_MIN_DAYS || n > EXPIRES_MAX_DAYS) {
            err('expires_invalid', 'expiresInDays', `The tables are kept for a whole number of days from ${EXPIRES_MIN_DAYS} to ${EXPIRES_MAX_DAYS}.`);
        }
    }
    return out;
}

module.exports = {
    normalizeReadTableStep, validateReadTableStep,
    READ_TABLE_FORMATS, READ_TABLE_DELIMITERS, DEFAULTS,
    EXPIRES_MIN_DAYS, EXPIRES_MAX_DAYS, EXPIRES_DEFAULT_DAYS, HEADER_ROW_MIN, HEADER_ROW_MAX,
};

/**
 * A source as bound: a binding object (or a file descriptor), or plain text.
 * @typedef {{ kind?: unknown, path?: unknown, value?: unknown, sourceHandle?: unknown }} SourceBinding
 */
