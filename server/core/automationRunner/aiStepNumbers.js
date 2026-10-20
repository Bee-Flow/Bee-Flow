// @typecheck
'use strict';
/**
 * Numbers in free text, for the `numbersFrom` check of an ai_step: "every
 * number the model wrote must also appear in the source data".
 *
 * Pure. Numbers are read the way people write them: `1.234,5`, `1,234.5`,
 * `12,5 %`, `1 234`, `1'234`. A group like `1.234` is ambiguous (one and a bit,
 * or one thousand two hundred thirty-four), so it yields BOTH readings and the
 * number passes when either one is in the source. A `-` between two digits is
 * a range (`10-20`), not a sign. Privacy Shield placeholders (`[email_1]`) and,
 * by default, dates are not numbers.
 */

const PLACEHOLDER_RE = /\[[a-z0-9_]+_\d+\]/gi;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const DMY_DATE_RE = /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g;
// Digit groups joined by one of: . , space, apostrophe, thin space.
const NUMBER_RE = /\d+(?:[.,  '’ ]\d+)*/g;
const LETTER_BEFORE_RE = /[\p{L}_]$/u;
const SIGN_OK_BEFORE_RE = /[\p{L}\p{N}]$/u;

/** @typedef {{ value: number, decimals: number }} NumberCandidate */
/** @typedef {{ cands: NumberCandidate[], percent: boolean }} NumberEntry */

/** Digits after the decimal point of a JS number (as it would print). */
function decimalsOf(n) {
    if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
    const s = String(n);
    const e = /e-(\d+)$/i.exec(s);
    if (e) {
        const mant = s.split(/e/i)[0];
        const frac = mant.includes('.') ? mant.split('.')[1].length : 0;
        return frac + Number(e[1]);
    }
    return s.includes('.') ? s.split('.')[1].length : 0;
}

/** Strip placeholders (always) and dates (when asked) so their digits are not read. */
function stripNoise(text, ignoreDates) {
    let s = String(text).replace(PLACEHOLDER_RE, ' ');
    if (ignoreDates) s = s.replace(ISO_DATE_RE, ' ').replace(DMY_DATE_RE, ' ');
    return s;
}

/** The readings of one digit run such as `1.234,5` (see the file header). */
function readingsOf(raw) {
    const groups = raw.split(/\D/);
    const seps = raw.replace(/\d/g, '').split('');
    const k = groups.length - 1;
    if (k === 0) return [{ value: Number(groups[0]), decimals: 0 }];
    const lead = groups[0];
    const leadOk = lead.length >= 1 && lead.length <= 3 && !(lead.length > 1 && lead.startsWith('0')) && lead !== '0';
    const middleOk = (to) => groups.slice(1, to).every((g) => g.length === 3);
    const out = [];
    // A: every separator is a thousands separator (all later groups hold 3 digits).
    if (leadOk && middleOk(k + 1)) out.push({ value: Number(groups.join('')), decimals: 0 });
    // B: the last separator is the decimal mark, the earlier ones are thousands separators.
    const last = seps[k - 1];
    if ((last === '.' || last === ',') && (k === 1 || (leadOk && middleOk(k) && !seps.slice(0, k - 1).includes(last)))) {
        out.push({ value: Number(`${groups.slice(0, k).join('')}.${groups[k]}`), decimals: groups[k].length });
    }
    // A space is also how people separate two numbers: keep each group as a reading.
    if (out.length === 0 || seps.includes(' ')) {
        for (const g of groups) out.push({ value: Number(g), decimals: 0 });
    }
    return out;
}

/**
 * The numbers in a piece of text.
 * @param {string} text
 * @param {{ ignoreDates?: boolean, ignoreUpTo?: number }} [opts]
 * @returns {NumberEntry[]}
 */
function extractNumbers(text, opts = {}) {
    const { ignoreDates = true, ignoreUpTo = 0 } = opts;
    const s = stripNoise(text, ignoreDates);
    const out = [];
    NUMBER_RE.lastIndex = 0;
    let m;
    while ((m = NUMBER_RE.exec(s)) !== null) {
        const before = s.slice(0, m.index);
        if (LETTER_BEFORE_RE.test(before)) continue; // "Q3", "v2", "A4": a label, not a quantity
        let cands = readingsOf(m[0]);
        const minus = /[-−]$/.test(before) && !SIGN_OK_BEFORE_RE.test(before.slice(0, -1));
        if (minus) cands = cands.map((c) => ({ ...c, value: -c.value }));
        if (ignoreUpTo > 0 && cands.every((c) => Number.isInteger(c.value) && Math.abs(c.value) <= ignoreUpTo)) continue;
        out.push({ cands, percent: /^\s?%/.test(s.slice(m.index + m[0].length)) });
    }
    return out;
}

/** Every number found anywhere in a run value (numbers directly, strings scanned), sorted. */
function collectSourceNumbers(value) {
    const nums = [];
    const seen = new Set();
    const stack = [value];
    while (stack.length) {
        const v = stack.pop();
        if (typeof v === 'number') { if (Number.isFinite(v)) nums.push(v); continue; }
        if (typeof v === 'string') {
            for (const e of extractNumbers(v, { ignoreDates: false })) for (const c of e.cands) nums.push(c.value);
            continue;
        }
        if (!v || typeof v !== 'object' || seen.has(v)) continue;
        seen.add(v);
        for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push(x);
    }
    return Float64Array.from(nums).sort();
}

/** Is there a source number in [lo, hi]? `sorted` is ascending. */
function anyInWindow(sorted, lo, hi) {
    let a = 0;
    let b = sorted.length;
    while (a < b) {
        const mid = (a + b) >>> 1;
        if (sorted[mid] < lo) a = mid + 1; else b = mid;
    }
    return a < sorted.length && sorted[a] <= hi;
}

/**
 * Is one number of the answer supported by the source?
 * Passes when |n - s| <= tolerance, or n (with d decimals) is s rounded to d
 * decimals, or, for a percentage, the same against s * 100.
 * @param {NumberEntry} entry
 * @param {Float64Array} sorted
 * @param {{ tolerance?: number, percent?: boolean }} [opts]
 */
function numberSupported(entry, sorted, opts = {}) {
    const { tolerance = 0, percent = true } = opts;
    return entry.cands.some(({ value, decimals }) => {
        const w = Math.max(tolerance, 0.5 * 10 ** -decimals + 1e-9);
        if (anyInWindow(sorted, value - w, value + w)) return true;
        return percent && entry.percent && anyInWindow(sorted, (value - w) / 100, (value + w) / 100);
    });
}

/** The entries of any run-shaped value: text is scanned, numbers taken as written, lists and records walked. */
function entriesOfValue(value, opts, out = []) {
    if (typeof value === 'string') out.push(...extractNumbers(value, opts));
    else if (typeof value === 'number') { if (Number.isFinite(value)) out.push({ cands: [{ value, decimals: decimalsOf(value) }], percent: false }); }
    else if (Array.isArray(value)) for (const x of value) entriesOfValue(x, opts, out);
    else if (value && typeof value === 'object') for (const x of Object.values(value)) entriesOfValue(x, opts, out);
    return out;
}

/**
 * Does `value` hold a number the source does not support?
 * @param {any} value
 * @param {Float64Array} sorted from collectSourceNumbers
 * @param {{ tolerance?: number, ignoreUpTo?: number, percent?: boolean, ignoreDates?: boolean }} [opts]
 */
function hasUnsupportedNumber(value, sorted, opts = {}) {
    const entries = entriesOfValue(value, { ignoreDates: opts.ignoreDates !== false, ignoreUpTo: opts.ignoreUpTo || 0 });
    return entries.some((e) => !numberSupported(e, sorted, opts));
}

module.exports = { extractNumbers, collectSourceNumbers, numberSupported, hasUnsupportedNumber, decimalsOf };
