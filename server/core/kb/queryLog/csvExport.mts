/**
 * csvExport.mts: CSV text for the query-log exports (KB level and compliance).
 *
 * The cells hold text typed by users and written by a model, and the file gets opened in a
 * spreadsheet, so a formula-shaped string is pinned as text with a leading apostrophe
 * (the same rule as the other server-side CSV writers: dataEngine `formulaShaped` + `quoteField`).
 * Both are written out here, so the export of a core feature needs no datatables module;
 * csvExport.datatables.test.js holds them equal to the dataEngine's own.
 */

/** Excel needs the byte order mark to read UTF-8. */
const BOM = '﻿';

export type CsvValue = string | number | boolean | null | undefined;

/** What a spreadsheet reads as the start of a formula (spreadsheetFile/cells.js FORMULA_TRIGGER_RE). */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/** A text cell a spreadsheet would run as a formula (cells.js `formulaShaped(value, 'text')`). */
function formulaShaped(value: string): boolean {
    return value.length > 0 && FORMULA_TRIGGERS.includes(value.charAt(0));
}

/** Quote when the field would otherwise not survive a parse (formats/csv.js `quoteField`, comma). */
function quoteField(s: string): string {
    const needs = s.includes(',') || s.includes('"') || s.includes('\r') || s.includes('\n') || s.trim() !== s;
    return needs ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvCell(value: CsvValue): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return quoteField(formulaShaped(value) ? `'${value}` : value);
    return quoteField(String(value));
}

/** The header line of a streamed file: BOM first, CRLF last. */
export function csvHead(headers: string[]): string {
    return BOM + headers.map(csvCell).join(',') + '\r\n';
}

/** One row of a streamed file, CRLF last. */
export function csvLine(headers: string[], row: Record<string, CsvValue>): string {
    return headers.map((h) => csvCell(row[h])).join(',') + '\r\n';
}

/** One header line plus one line per row, CRLF separated, with a BOM. */
export function toCsv(headers: string[], rows: Array<Record<string, CsvValue>>): string {
    const lines = [headers.map(csvCell).join(',')];
    for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
    return BOM + lines.join('\r\n') + '\r\n';
}
