// @typecheck
/**
 * The .xlsx writer: a minimal OOXML package (inline strings, no shared-strings
 * table) built with jszip, one worksheet per entry of `sheets`. Pure, no I/O.
 * Used by officegen.buildSpreadsheet (automations, nextcloud_create_spreadsheet)
 * and by the chat's create_spreadsheet (integrations/spreadsheetTools.js),
 * which alone turns on `formulas`; a formula is a cell object { formula }.
 */

const JSZip = require('jszip');
const { xmlEscape, stripInvalidXmlChars, colLetter } = require('./xlsxXml');
const { chartPartsFor } = require('./xlsxCharts');

function isNumericCell(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/** A cell the caller marked as a formula: { formula: '=SUM(B2:B10)' } (the "=" is optional). */
function isFormulaCell(v) {
    return !!v && typeof v === 'object' && typeof v.formula === 'string' && v.formula.replace(/^=/, '').trim() !== '';
}

/**
 * A name Excel accepts: at most 31 characters, none of \ / ? * [ ] :, no
 * leading or trailing apostrophe, not empty, not the reserved "History".
 */
function sanitizeSheetName(name) {
    const s = stripInvalidXmlChars(name || '').replace(/[\\/?*[\]:]/g, ' ').trim().replace(/^'+|'+$/g, '').trim().slice(0, 31).trim();
    if (!s) return 'Sheet1';
    return s.toLowerCase() === 'history' ? `${s}_` : s;
}

// A plain decimal written as text ("1200", "-3.5"). A leading zero ("0612…",
// a postcode) or an exponent stays text: those are identifiers, not amounts.
const NUMERIC_TEXT = /^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/;

function xlsxSheetXml(matrix, formulas, hasDrawing) {
    const rowsXml = matrix.map((row, ri) => {
        const cells = row.map((val, ci) => {
            if (val === null || val === undefined || val === '') return '';
            const ref = `${colLetter(ci)}${ri + 1}`;
            if (isNumericCell(val)) return `<c r="${ref}"><v>${val}</v></c>`;
            // Only for a model-built workbook (create_spreadsheet): a model
            // often sends amounts as strings, and =SUM() skips text cells.
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- NUMERIC_TEXT is anchored with bounded quantifiers: no backtracking
            if (formulas && ri > 0 && typeof val === 'string' && NUMERIC_TEXT.test(val)) return `<c r="${ref}"><v>${Number(val)}</v></c>`;
            // A formula only when the caller marks it: a cell object
            // { formula: '=SUM(B2:B10)' }. Text is always written as text, whatever
            // it starts with.
            if (formulas && isFormulaCell(val)) {
                return `<c r="${ref}"><f>${xmlEscape(val.formula.replace(/^=/, ''))}</f></c>`;
            }
            if (typeof val === 'object') return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(JSON.stringify(val))}</t></is></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
        }).join('');
        return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheetData>${rowsXml}</sheetData>${hasDrawing ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
}

/**
 * A workbook with one or more sheets: `sheets` = [{ name, matrix }]. Sheet names
 * are sanitised and made unique (Excel rejects duplicates). With
 * `opts.formulas`, a cell object { formula } becomes a real formula (text
 * starting with "=" stays text) and a plain decimal string below the header row
 * a number. A sheet may carry
 * `charts` (+ `values`, its computed cells): they become native Excel charts
 * (xlsxCharts.js).
 */
async function buildXlsxWorkbook(sheets, opts = {}) {
    const list = Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', matrix: [] }];
    const used = new Set();
    const names = list.map((sh, i) => {
        const base = sanitizeSheetName(sh.name || `Sheet${i + 1}`);
        let n = base;
        for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base.slice(0, 31 - String(k).length - 1).replace(/'+$/, '')}_${k}`;
        used.add(n.toLowerCase());
        return n;
    });
    const zip = new JSZip();
    const charted = chartPartsFor(list.map((sh, i) => ({ name: names[i], charts: sh.charts, values: sh.values })));
    zip.file('[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        charted.contentTypes + '</Types>');
    zip.file('_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>');
    zip.file('xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        (opts.formulas ? '<calcPr fullCalcOnLoad="1"/>' : '') +
        '</workbook>');
    zip.file('xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        '</Relationships>');
    list.forEach((sh, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, xlsxSheetXml(Array.isArray(sh.matrix) ? sh.matrix : [], opts.formulas, i in charted.sheetRels)));
    for (const [path, xml] of Object.entries(charted.files)) zip.file(path, xml);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildXlsxWorkbook, xmlEscape, isNumericCell, colLetter, sanitizeSheetName };

/** @typedef {Parameters<typeof import('./rowsMatrix').coerceCell>[0]} CellValue */
