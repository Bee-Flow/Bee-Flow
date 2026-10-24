// @typecheck
/** Small XML helpers shared by the .xlsx writers (xlsxWorkbook.js, xlsxCharts.js). */

'use strict';

/**
 * Everything XML 1.0 cannot carry: C0 controls except tab/LF/CR, U+FFFE/U+FFFF
 * and lone surrogates. A pair of surrogates (an emoji) is valid and stays.
 */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripInvalidXmlChars(v) {
    return String(v).replace(XML_INVALID, '');
}

function xmlEscape(v) {
    return stripInvalidXmlChars(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** 0-based column index → spreadsheet column letter (0→A, 26→AA). */
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

module.exports = { xmlEscape, stripInvalidXmlChars, colLetter };
