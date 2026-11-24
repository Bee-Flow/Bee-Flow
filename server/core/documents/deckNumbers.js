// @typecheck strict
/**
 * Numbers and cells the way people write them in a deck chart: "1.554,25",
 * "€ 12", "12%", "1,2M", and the "; " / "|" / comma separated cells of one
 * ```chart line. Split out of deckChart.js, which re-exports parseNumber and
 * isNumeric.
 *
 * Pure: no I/O, no dependencies.
 */
// ── Numbers ─────────────────────────────────────────────────────────────

const NUMBER_SUFFIX = /** @type {Readonly<Record<string, number>>} */ (Object.freeze({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, mln: 1e6, mrd: 1e9, b: 1e9, B: 1e9 }));

const CURRENCY_SIGNS = Object.freeze(['€', '$', '£', '¥']);
const isAsciiLetter = (/** @type {string} */ c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/**
 * The run of ASCII letters at the end of `s` ("12k" → "k"), or ''. Plain
 * string work: the cell text is the author's (semgrep regex_dos).
 * @param {string} s
 */
function trailingLetters(s) {
    let i = s.length;
    while (i > 0 && isAsciiLetter(s[i - 1])) i -= 1;
    return s.slice(i);
}

/**
 * True when a comma is followed by whitespace ("1, 2" is a list).
 * @param {string} s
 */
function commaThenSpace(s) {
    for (let i = s.indexOf(','); i !== -1 && i < s.length - 1; i = s.indexOf(',', i + 1)) {
        if (s[i + 1].trim() === '') return true;
    }
    return false;
}

/**
 * A number out of human text. Handles currency signs, thousands separators in
 * either convention, a trailing %, and k/M/B suffixes. Returns null when the
 * text is not a number at all. `dotThousands`: the column writes decimals
 * with a comma, so a lone "2.795" is thousands too.
 * @param {unknown} value
 * @param {{ dotThousands?: boolean }} [opts]
 */
function parseNumber(value, { dotThousands = false } = {}) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === null || value === undefined) return null;
    let s = String(value).trim();
    if (!s) return null;
    const money = CURRENCY_SIGNS.some((sign) => s.includes(sign));
    s = s.replace(/[€$£¥]/g, '').replace(/\s+/g, '').replace(/%$/, '');
    let mult = 1;
    const suffix = trailingLetters(s);
    if (suffix && NUMBER_SUFFIX[suffix] !== undefined) { mult = NUMBER_SUFFIX[suffix]; s = s.slice(0, -suffix.length); }
    if (!/^[-+]?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma !== -1 && lastDot !== -1) {
        // Both present: the later one is the decimal mark.
        s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma !== -1) {
        // Only commas: "1,234,567" (groups of three) is thousands; "1,5" and "0,125" are decimal.
        s = thousandsGroups(s, ',', true) ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (lastDot !== -1) {
        // Only dots: "1.234.567" is thousands, and so is "€ 2.795" (money has no
        // third decimal); a lone "1.234" or "0.125" is a decimal.
        s = thousandsGroups(s, '.', money || dotThousands) ? s.replace(/\./g, '') : s;
        if ((s.match(/\./g) || []).length > 1) return null;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n * mult : null;
}

/**
 * True when `sep` separates groups of three digits after a non-zero integer
 * part of at most three digits. One group ("1.234") counts only when
 * `singleGroup` allows it.
 * @param {string} s
 * @param {string} sep
 * @param {boolean} singleGroup
 */
function thousandsGroups(s, sep, singleGroup) {
    const parts = s.replace(/^[-+]/, '').split(sep);
    if (parts.length < 2 || (parts.length === 2 && !singleGroup)) return false;
    if (!/^[1-9]\d{0,2}$/.test(parts[0])) return false;
    return parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

/**
 * True when a cell writes its decimals with a comma ("1,5", "1.554,25").
 * @param {unknown} value
 */
function decimalComma(value) {
    if (typeof value !== 'string') return false;
    const s = value.replace(/[^\d.,]/g, '');
    return /\.\d{3},\d+$/.test(s) || (/^\d+,\d+$/.test(s) && !/^\d{1,3},\d{3}$/.test(s));
}

/**
 * True when the cell reads as a number (a blank cell is neither).
 * @param {unknown} value
 */
function isNumeric(value) {
    if (value === null || value === undefined || value === '') return false;
    return parseNumber(value) !== null;
}

/**
 * @param {string} text
 */
function splitList(text) {
    return String(text).split(/[,;|\t]/).map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * A comma list of numbers, unless the commas are decimal marks: "1, 2" and
 * "1,2,3" are lists, "1,5" is one value unless `expected` cells are due.
 * @param {string} s
 * @param {number | null} expected
 */
function splitNumberCommas(s, expected) {
    const cells = s.split(',');
    if (cells.length < 2) return cells;
    const allNumbers = cells.every((c) => c.trim() === '' || isNumeric(c));
    const listLike = commaThenSpace(s) || (expected !== null && expected > 1 && cells.length === expected) || parseNumber(s) === null;
    return allNumbers && listLike ? cells : [s];
}

/**
 * The cells of one line of a chart block. "; " separates when the line holds one (a
 * label may then carry a comma); otherwise "|" or a tab; otherwise a comma,
 * but only where the pieces are whole numbers and the comma is not a decimal
 * mark: "1,5" stays one value unless `expected` cells are due. Empty cells
 * are kept (a gap); trailing empties are dropped.
 * @param {string} text
 * @param {{ numbers?: boolean, expected?: number | null }} [opts]
 * @returns {string[]}
 */
function splitCells(text, { numbers = false, expected = null } = {}) {
    const s = String(text);
    let cells;
    if (s.includes(';')) cells = s.split(';');
    else if (/[|\t]/.test(s)) cells = s.split(/[|\t]/);
    else cells = numbers ? splitNumberCommas(s, expected) : s.split(',');
    cells = cells.map((c) => c.trim());
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    return cells;
}

module.exports = { NUMBER_SUFFIX, parseNumber, decimalComma, isNumeric, splitList, splitCells };
