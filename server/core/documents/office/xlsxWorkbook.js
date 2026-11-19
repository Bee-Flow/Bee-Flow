// @typecheck
/**
 * The .xlsx writer: a minimal OOXML package (inline strings, no shared-strings
 * table) built with jszip, one worksheet per entry of `sheets`. Pure, no I/O.
 * Used by officegen.buildSpreadsheet (automations, nextcloud_create_spreadsheet)
 * and by the chat's create_spreadsheet (integrations/spreadsheetTools.js),
 * which alone turns on `formulas`; a formula is a cell object { formula }.
 */

const JSZip = require('jszip');
const { xmlEscape, stripInvalidXmlChars, colLetter, CELL_STYLE, STYLES_XML } = require('./xlsxXml');
const { chartPartsFor } = require('./xlsxCharts');

function isNumericCell(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A cell the caller marked as a formula: { formula: '=SUM(B2:B10)' } (the "=" is optional).
 * @param {unknown} v
 * @returns {v is { formula: string }}
 */
function isFormulaCell(v) {
    const formula = !!v && typeof v === 'object' ? /** @type {{ formula?: unknown }} */ (v).formula : undefined;
    return typeof formula === 'string' && formula.replace(/^=/, '').trim() !== '';
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

/**
 * The style index of row `ri` of a styled sheet, or 0.
 * @param {{ header?: boolean, highlightRows?: Iterable<number> } | null | undefined} style
 * @param {Set<number> | null} highlighted
 * @param {number} ri
 */
function rowStyle(style, highlighted, ri) {
    if (!style) return CELL_STYLE.plain;
    if (ri === 0 && style.header) return CELL_STYLE.header;
    return highlighted && highlighted.has(ri) ? CELL_STYLE.highlight : CELL_STYLE.plain;
}

/** The frozen header row of a styled sheet: the column names stay in view while scrolling. */
const FROZEN_HEADER = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';

/**
 * One cell; `open` is `<c r="A1"` plus its style attribute, if any.
 * @param {unknown} val
 * @param {string} open
 * @param {boolean} formulas
 * @param {number} ri
 */
function cellXml(val, open, formulas, ri) {
    if (isNumericCell(val)) return `${open}><v>${val}</v></c>`;
    // Only for a model-built workbook (create_spreadsheet): a model
    // often sends amounts as strings, and =SUM() skips text cells.
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- NUMERIC_TEXT is anchored with bounded quantifiers: no backtracking
    if (formulas && ri > 0 && typeof val === 'string' && NUMERIC_TEXT.test(val)) return `${open}><v>${Number(val)}</v></c>`;
    // A formula only when the caller marks it: a cell object
    // { formula: '=SUM(B2:B10)' }. Text is always written as text, whatever
    // it starts with.
    if (formulas && isFormulaCell(val)) {
        return `${open}><f>${xmlEscape(val.formula.replace(/^=/, ''))}</f></c>`;
    }
    const textValue = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return `${open} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(textValue)}</t></is></c>`;
}

/**
 * @param {unknown[][]} matrix
 * @param {boolean} formulas
 * @param {boolean} hasDrawing
 * @param {{ header?: boolean, highlightRows?: Iterable<number> } | null} [style]  a bold, frozen
 *   header row and/or rows (matrix indices) with a highlight fill
 */
function xlsxSheetXml(matrix, formulas, hasDrawing, style = null) {
    const highlighted = style && style.highlightRows ? new Set(style.highlightRows) : null;
    const rowsXml = matrix.map((row, ri) => {
        const s = rowStyle(style, highlighted, ri);
        const sa = s ? ` s="${s}"` : '';
        const cells = row.map((val, ci) => {
            if (val === null || val === undefined || val === '') return '';
            return cellXml(val, `<c r="${colLetter(ci)}${ri + 1}"${sa}`, formulas, ri);
        }).join('');
        return `<row r="${ri + 1}"${s === CELL_STYLE.highlight ? `${sa} customFormat="1"` : ''}>${cells}</row>`;
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `${style && style.header && matrix.length > 1 ? FROZEN_HEADER : ''}<sheetData>${rowsXml}</sheetData>${hasDrawing ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
}

/**
 * A workbook with one or more sheets: `sheets` = [{ name, matrix }]. Sheet names
 * are sanitised and made unique (Excel rejects duplicates). With
 * `opts.formulas`, a cell object { formula } becomes a real formula (text
 * starting with "=" stays text) and a plain decimal string below the header row
 * a number. A sheet may carry
 * `charts` (+ `values`, its computed cells): they become native Excel charts
 * (xlsxCharts.js), and a `style` { header, highlightRows }: a bold, frozen
 * header row and highlighted rows (matrix indices).
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
    // The styles part only when a sheet is styled (write_table): the other
    // workbooks stay byte-for-byte what they were.
    const styled = list.some((sh) => !!sh.style);
    const stylesType = styled ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' : '';
    const stylesRel = styled ? `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` : '';
    if (styled) zip.file('xl/styles.xml', STYLES_XML);
    zip.file('[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        stylesType + charted.contentTypes + '</Types>');
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
        stylesRel + '</Relationships>');
    list.forEach((sh, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, xlsxSheetXml(Array.isArray(sh.matrix) ? sh.matrix : [], opts.formulas, i in charted.sheetRels, sh.style || null)));
    for (const [path, xml] of Object.entries(charted.files)) zip.file(path, xml);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildXlsxWorkbook, xmlEscape, isNumericCell, colLetter, sanitizeSheetName };

/** @typedef {Parameters<typeof import('./rowsMatrix').coerceCell>[0]} CellValue */
