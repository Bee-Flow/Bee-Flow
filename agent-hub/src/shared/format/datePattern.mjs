// @typecheck strict
/**
 * Date patterns for App Studio value formatting: "dd-MM-yyyy", "d MMM yyyy HH:mm", "EEE d MMMM".
 *
 * A pattern is read character by character (no regular expression over author text). An ASCII
 * letter must start one of the tokens below, longest first, or the whole pattern is refused,
 * so a typo never prints a stray letter on every row. Text in single quotes is literal ('' is a
 * quote); every other character is literal as it stands.
 *
 *   yyyy 2026   yy 26   MMMM March   MMM Mar   MM 03   M 3   dd 07   d 7
 *   EEEE Saturday   EEE Sat   HH 09   H 9   hh 09 (12-hour)   h 9   mm 05   ss 00   a AM/PM
 *
 * Shared by the server (canonicalize, validate) and the web runtime through the generated copy
 * in agent-hub/src/shared/format/.
 */

export const MAX_PATTERN_LEN = 40;

/** Longest first: the parser takes the first token the text starts with. */
const TOKENS = Object.freeze(['yyyy', 'yy', 'MMMM', 'MMM', 'MM', 'M', 'dd', 'd', 'EEEE', 'EEE', 'HH', 'H', 'hh', 'h', 'mm', 'ss', 'a']);

/** @typedef {{ token: string } | { text: string }} PatternPart */

/** @param {string} ch */
function isAsciiLetter(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/**
 * The quoted literal starting at `start` (the opening quote): its text and the index after the
 * closing quote, or null when the quote is never closed.
 * @param {string} pattern
 * @param {number} start
 * @returns {{ text: string, next: number } | null}
 */
function readQuoted(pattern, start) {
    if (pattern[start + 1] === "'") return { text: "'", next: start + 2 };
    let text = '';
    let i = start + 1;
    while (i < pattern.length) {
        if (pattern[i] === "'") {
            if (pattern[i + 1] === "'") { text += "'"; i += 2; continue; }
            return { text, next: i + 1 };
        }
        text += pattern[i];
        i += 1;
    }
    return null;
}

/**
 * The parts of `pattern`, or null when it is not a pattern this module can write: not a string,
 * empty, longer than MAX_PATTERN_LEN, an unknown letter, an unclosed quote, or no token at all.
 * @param {unknown} pattern
 * @returns {PatternPart[] | null}
 */
export function parseDatePattern(pattern) {
    if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN_LEN) return null;
    /** @type {PatternPart[]} */
    const parts = [];
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === "'") {
            const quoted = readQuoted(pattern, i);
            if (!quoted) return null;
            parts.push({ text: quoted.text });
            i = quoted.next;
        } else if (isAsciiLetter(ch)) {
            const token = TOKENS.find((tok) => pattern.startsWith(tok, i));
            if (!token) return null;
            parts.push({ token });
            i += token.length;
        } else {
            parts.push({ text: ch });
            i += 1;
        }
    }
    return parts.some((p) => 'token' in p) ? parts : null;
}

/** @param {unknown} pattern */
export function isDatePattern(pattern) {
    return parseDatePattern(pattern) !== null;
}

/**
 * The calendar and clock fields of a moment, as numbers.
 * @typedef {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} DateFields
 */

/**
 * @param {number} n
 * @param {number} width
 */
const pad = (n, width) => String(n).padStart(width, '0');

/** @typedef {'monthLong' | 'monthShort' | 'weekdayLong' | 'weekdayShort' | 'dayPeriod'} NameField */
/** @typedef {(f: DateFields, name: (field: NameField) => string) => string} TokenWriter */

/** @param {DateFields} f */
const hour12 = (f) => (f.hour % 12 === 0 ? 12 : f.hour % 12);

/** The writer of each token; `name` gives the localised words (month and weekday names, AM/PM). */
/** @type {Readonly<Record<string, TokenWriter>>} */
const TOKEN_WRITERS = Object.freeze({
    yyyy: (f) => pad(f.year, 4),
    yy: (f) => pad(f.year % 100, 2),
    MMMM: (_f, name) => name('monthLong'),
    MMM: (_f, name) => name('monthShort'),
    MM: (f) => pad(f.month, 2),
    M: (f) => String(f.month),
    dd: (f) => pad(f.day, 2),
    d: (f) => String(f.day),
    EEEE: (_f, name) => name('weekdayLong'),
    EEE: (_f, name) => name('weekdayShort'),
    HH: (f) => pad(f.hour, 2),
    H: (f) => String(f.hour),
    hh: (f) => pad(hour12(f), 2),
    h: (f) => String(hour12(f)),
    mm: (f) => pad(f.minute, 2),
    ss: (f) => pad(f.second, 2),
    a: (_f, name) => name('dayPeriod'),
});

/**
 * Write `parts` (from parseDatePattern) for the given fields.
 * @param {PatternPart[]} parts
 * @param {DateFields} fields
 * @param {(field: NameField) => string} name
 */
export function renderDatePattern(parts, fields, name) {
    let out = '';
    for (const part of parts) out += 'token' in part ? TOKEN_WRITERS[part.token](fields, name) : part.text;
    return out;
}
