/**
 * Carrying out a pick's take and as on what the run holds, whatever shape it
 * turns out to have:
 *
 *   - first/last of a single value is that value; count of one is 1.
 *   - one of many is the first, with the warning `many_for_one`.
 *   - all of a walk that crossed a list is its items, flattened, the rows
 *     that lacked the field dropped and counted (`holes_dropped`).
 *   - count and all read the same items (walk.mjs manyItems), so the count
 *     a user is shown is the length of the list a step is sent.
 *   - nothing there is '' for text, [] for a list, and no value otherwise;
 *     each reported as `missing` (resolve.mjs turns that into
 *     `missing_required` for a required field).
 *
 * Numbers and dates are read with the injected `parse` (shared/expr's
 * parse.mjs: parseLocaleNumber, parseDate), the same readers the expression
 * engine uses, so '€ 1.554,25' is 1554.25 here as in number(). Without it
 * only what Number() and ISO text read is read.
 *
 * Every function returns `{ value, warnings }`; a warning is `{ code, ... }`
 * and never holds a value from the run.
 */

import { isMany, manyItems } from './walk.mjs';
import { renderText } from './render.mjs';

const ONE_VALUE = new Set(['number', 'date', 'yesno']);
const YES = new Set(['true', 'yes', 'ja', 'j', 'y', '1', 'on', 'waar']);
const NO = new Set(['false', 'no', 'nee', 'n', '0', 'off', 'onwaar']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The value a take selects from a walk result, before it is cast.
 * `missing: true` when there is none.
 * @param {unknown} result — walk.mjs walkMany
 * @param {string} take — one, all, first, last, count (each is resolved to
 *   one or all by the caller, against the repeat item)
 * @param {string} as
 */
export function applyTake(result, take, as) {
    const warnings = [];
    if (take === 'count') return { value: manyItems(result).items.length, warnings };
    if (result === undefined) return { value: undefined, missing: true, warnings };
    if (take === 'all') {
        if (!isMany(result)) return { value: result, warnings };
        const { items, holes } = manyItems(result);
        if (holes > 0) warnings.push({ code: 'holes_dropped', count: holes });
        return { value: items, warnings };
    }
    if (take === 'first' || take === 'last') {
        const { items } = manyItems(result);
        if (!items.length) return { value: undefined, missing: true, warnings };
        return { value: take === 'first' ? items[0] : items[items.length - 1], warnings };
    }
    // one
    if (isMany(result) || (Array.isArray(result) && ONE_VALUE.has(as))) {
        const { items } = manyItems(result);
        if (!items.length) return { value: undefined, missing: true, warnings };
        if (items.length > 1) warnings.push({ code: 'many_for_one', count: items.length });
        return { value: items[0], warnings };
    }
    return { value: result, warnings };
}

function toNumber(value, parse) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const s = value.trim();
    if (s === '') return undefined;
    const n = Number(s);
    if (!Number.isNaN(n)) return Number.isFinite(n) ? n : undefined;
    const local = parse && typeof parse.parseLocaleNumber === 'function' ? parse.parseLocaleNumber(s) : null;
    return typeof local === 'number' && Number.isFinite(local) ? local : undefined;
}

function toDate(value, parse) {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- ISO_DATE is anchored at both ends with fixed-width fields; its one open run (the fraction, \d+) is followed by a character it cannot match, so matching is linear
    if (typeof value === 'string' && ISO_DATE.test(value.trim())) {
        // Already ISO: kept as written, so a date stays a date and an offset
        // stays the offset it was given in. Only a day that exists ('2026-13-45'
        // is no date, though Date.UTC would roll it into 2027).
        const s = value.trim();
        const [y, m, d] = s.slice(0, 10).split('-').map(Number);
        if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return undefined;
        const read = parse && typeof parse.parseDate === 'function' ? parse.parseDate(s) : true;
        return read ? s : undefined;
    }
    const read = parse && typeof parse.parseDate === 'function' ? parse.parseDate(value) : null;
    return read && Number.isFinite(read.epoch) ? new Date(read.epoch).toISOString() : undefined;
}

function toYesNo(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : undefined;
    if (typeof value !== 'string') return undefined;
    const s = value.trim().toLowerCase();
    if (YES.has(s)) return true;
    if (NO.has(s)) return false;
    return undefined;
}

/**
 * A selected value as what the field gets.
 * @param {unknown} value
 * @param {string} as
 * @param {{ join?: string, parse?: { parseLocaleNumber?: Function, parseDate?: Function } }} [ctx]
 */
export function castAs(value, as, { join, parse } = {}) {
    const warnings = [];
    if (as === 'text') return { value: typeof value === 'string' ? value : renderText(value, { join }), warnings };
    if (as === 'list') {
        if (Array.isArray(value)) return { value, warnings };
        return { value: value === null || value === undefined ? [] : [value], warnings };
    }
    if (!ONE_VALUE.has(as)) return { value, warnings };
    let v = value;
    if (Array.isArray(v)) {
        if (!v.length) return { value: undefined, missing: true, warnings };
        if (v.length > 1) warnings.push({ code: 'many_for_one', count: v.length });
        v = v[0];
    }
    if (v === null || v === undefined || v === '') return { value: undefined, missing: true, warnings };
    const out = as === 'number' ? toNumber(v, parse) : as === 'date' ? toDate(v, parse) : toYesNo(v);
    if (out === undefined) warnings.push({ code: 'parse_failed', as });
    return { value: out, warnings };
}

/**
 * Take, then cast, then fill in what nothing gives: the value a pick
 * resolves to, and every warning on the way.
 * @param {unknown} result — walk.mjs walkMany
 * @param {{ take: string, as: string, join?: string }} intent
 * @param {{ parse?: object }} [ctx]
 * @returns {{ value: unknown, warnings: Array<{ code: string }> }}
 */
export function fit(result, { take, as, join }, { parse } = {}) {
    const taken = applyTake(result, take, as);
    const warnings = [...taken.warnings];
    let value;
    let missing = !!taken.missing;
    if (!missing) {
        const cast = castAs(taken.value, as, { join, parse });
        warnings.push(...cast.warnings);
        value = cast.value;
        missing = !!cast.missing;
    }
    if (missing) {
        warnings.push({ code: 'missing' });
        if (as === 'text') value = '';
        else if (as === 'list') value = [];
        else value = undefined;
    }
    return { value, warnings };
}
