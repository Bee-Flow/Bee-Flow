/** Small XML helpers shared by the .xlsx writers (xlsxWorkbook.js, xlsxCharts.js). */

'use strict';

function xmlEscape(v) {
    return String(v)
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

module.exports = { xmlEscape, colLetter };
