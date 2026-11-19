// @typecheck strict
/** Small XML helpers shared by the .xlsx writers (xlsxWorkbook.js, xlsxCharts.js). */

'use strict';

/**
 * Everything XML 1.0 cannot carry: C0 controls except tab/LF/CR, U+FFFE/U+FFFF
 * and lone surrogates. A pair of surrogates (an emoji) is valid and stays.
 */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * @param {string} v
 */
function stripInvalidXmlChars(v) {
    return String(v).replace(XML_INVALID, '');
}

/**
 * @param {string} v
 */
function xmlEscape(v) {
    return stripInvalidXmlChars(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * 0-based column index → spreadsheet column letter (0→A, 26→AA).
 * @param {number} n
 */
function colLetter(n) {
    let s = '';
    n += 1;
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/**
 * The cell styles of a styled sheet (xlsxWorkbook.js `style`): 0 plain, 1 a
 * bold header, 2 a highlighted row (light amber fill, as a spreadsheet user
 * marks rows to check). Only written when a sheet asks for a style, so an
 * unstyled workbook stays the minimal package it always was.
 */
const CELL_STYLE = Object.freeze({ plain: 0, header: 1, highlight: 2 });

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

module.exports = { xmlEscape, stripInvalidXmlChars, colLetter, CELL_STYLE, STYLES_XML };
