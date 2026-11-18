/**
 * csv.mts: RFC 4180 CSV to rows of strings, the way the OFAC files are written (commas, double
 * quotes around a field that holds a comma or a quote, a doubled quote inside one, CRLF or LF
 * between records). No header handling: the caller knows its columns. A character-by-character
 * scan, linear in the input, no regular expression. Blank lines are left out.
 */

interface Scan { rows: string[][]; row: string[]; field: string; quoted: boolean }

function endRow(s: Scan): void {
    s.row.push(s.field);
    s.field = '';
    if (s.row.length > 1 || s.row[0] !== '') s.rows.push(s.row);
    s.row = [];
}

/** One character inside quotes; returns how many characters it used. */
function quotedChar(s: Scan, ch: string, next: string | undefined): number {
    if (ch !== '"') { s.field += ch; return 1; }
    if (next === '"') { s.field += '"'; return 2; }
    s.quoted = false;
    return 1;
}

/** One character outside quotes; returns how many characters it used. */
function plainChar(s: Scan, ch: string, next: string | undefined): number {
    if (ch === '"' && s.field === '') { s.quoted = true; return 1; }
    if (ch === ',') { s.row.push(s.field); s.field = ''; return 1; }
    if (ch === '\r' || ch === '\n') { endRow(s); return ch === '\r' && next === '\n' ? 2 : 1; }
    s.field += ch;
    return 1;
}

export function parseCsv(text: string): string[][] {
    const s: Scan = { rows: [], row: [], field: '', quoted: false };
    let i = 0;
    while (i < text.length) {
        i += s.quoted ? quotedChar(s, text[i], text[i + 1]) : plainChar(s, text[i], text[i + 1]);
    }
    if (s.field !== '' || s.row.length) endRow(s);
    return s.rows;
}
