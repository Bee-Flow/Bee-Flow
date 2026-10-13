// @typecheck
/**
 * The request boundary of the settings row: sanitizeSettingsPatch turns an
 * untrusted body into a saveSettings patch, SettingsValidationError is its 400.
 * Pure: no database, no clock.
 */

const { SETTINGS_FIELDS } = require('./settingsFields');

// ── the request boundary ─────────────────────────────────────────────────
//
// saveSettings binds every value straight into a typed column, so a body with
// `{"support_end_date":"soon"}` makes Postgres reject the WHOLE update and the
// other 30 fields of the same submit are lost. Values from a request are
// therefore coerced to their declared kind first, and one bad field is a 400
// naming that field instead of a driver error.
//
// The TYPE is not the whole contract. A value can genuinely BE an integer, a
// timestamp or a JSON array and still be one Postgres refuses — same wound,
// same lost submit, so the same 400 covers the column's DOMAIN too. Each of
// these was reproduced against Postgres 17 through the pg driver:
//   · int columns are int4 → 99999999999 is "integer out of range";
//   · a year outside four digits → date '0000-01-01' is "date/time field value
//     out of range" (the calendar Postgres implements has no year zero) and
//     JS's extended-year ISO form, which `new Date()` accepts and
//     `toISOString()` round-trips, is "time zone displacement out of range";
//   · U+0000 → a text bind is 'invalid byte sequence for encoding "UTF8":
//     0x00' and a jsonb bind is "unsupported Unicode escape sequence", because
//     that escape cannot be converted to text.
// One more is not Postgres but the same visible failure: a jsonb value nested
// thousands deep makes JSON.stringify (in _mergeField, before any SQL) throw
// "Maximum call stack size exceeded" — a 500 with a raw runtime message and
// the whole submit gone. It is refused here as well, and the walk that finds
// it is iterative so it cannot fall over the same way.
//
// What is deliberately NOT bounded here, having been checked:
//   · text LENGTH. compliance_settings has no varchar and no index on a
//     body-writable column (only the PK on organization_id), so `text` is
//     unbounded up to 1 GB: a long value is a body-size question, which
//     bodyParser's limit answers, not a value Postgres rejects.
//   · jsonb ELEMENT SHAPE (a list of objects where the reader wants strings).
//     jsonb takes it happily, so it cannot lose a save; it is the consumer's
//     contract, enforced where that consumer reads it.
//   · booleans, which already admit only true/false and their two strings.

const _isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

// A column that forgets to declare min/max still cannot overflow its int4.
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

// The four-digit ISO year window. Postgres itself reaches from 4713 BC to
// 294276 AD, but nothing outside `YYYY` is both storable and plausible here:
// every ts/date column in this table is an attestation moment, a registration
// date or a support end date.
const MIN_YEAR = 1900;
const MAX_YEAR = 9999;

// jsonb nesting. These columns hold flat lists and one-level records, so 20 is
// far past any real shape — and far below the ~4 000 at which JSON.stringify
// blows its own stack.
const MAX_JSON_DEPTH = 20;

const NUL = String.fromCharCode(0); // U+0000, never a literal in source

const _yearInRange = (d) => d.getUTCFullYear() >= MIN_YEAR && d.getUTCFullYear() <= MAX_YEAR;

/**
 * Walk a JSON-shaped value for the two things a jsonb column cannot take.
 * Iterative on purpose: a pathological body must not overflow the stack HERE
 * either. Object keys are checked as well as values — a NUL in a key is just
 * as fatal to the bind.
 * @returns {null | 'nul' | 'depth'}
 */
function _jsonDefect(root) {
    const stack = [[root, 0]];
    while (stack.length) {
        const [v, depth] = stack.pop();
        if (typeof v === 'string') {
            if (v.includes(NUL)) return 'nul';
            continue;
        }
        if (v === null || typeof v !== 'object') continue;
        if (depth > MAX_JSON_DEPTH) return 'depth';
        if (Array.isArray(v)) {
            for (const x of v) stack.push([x, depth + 1]);
            continue;
        }
        for (const [k, x] of Object.entries(v)) {
            if (k.includes(NUL)) return 'nul';
            stack.push([x, depth + 1]);
        }
    }
    return null;
}

/**
 * Coerce one request value to its column's declared kind AND domain.
 * @returns {{ok: true, value: any} | {ok: false, expected: string}}
 */
function _coerceSettingValue(f, v) {
    if (v === null) return { ok: true, value: null };
    switch (f.kind) {
        case 'jsonb': {
            // A JSON *string* would be double-encoded by the `::jsonb` bind,
            // so only the declared shape is accepted.
            const wantArray = Array.isArray(f.fallback);
            const shape = wantArray ? 'a JSON array' : 'a JSON object';
            if (wantArray ? !Array.isArray(v) : !_isPlainObject(v)) return { ok: false, expected: shape };
            const defect = _jsonDefect(v);
            if (defect === 'nul') return { ok: false, expected: `${shape} without NUL characters` };
            if (defect === 'depth') return { ok: false, expected: `${shape} nested at most ${MAX_JSON_DEPTH} levels deep` };
            return { ok: true, value: v };
        }
        case 'int': {
            let n = null;
            if (typeof v === 'number' && Number.isInteger(v)) n = v;
            else if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) n = Number(v.trim());
            if (n === null) return { ok: false, expected: 'an integer' };
            // The column's own domain (min/max in SETTINGS_FIELDS). A long
            // digit string parses to Infinity, which fails this the same way.
            const min = Number.isInteger(f.min) ? f.min : INT4_MIN;
            const max = Number.isInteger(f.max) ? f.max : INT4_MAX;
            if (!(n >= min && n <= max)) return { ok: false, expected: `an integer between ${min} and ${max}` };
            return { ok: true, value: n };
        }
        case 'bool': {
            if (typeof v === 'boolean') return { ok: true, value: v };
            if (v === 'true') return { ok: true, value: true };
            if (v === 'false') return { ok: true, value: false };
            return { ok: false, expected: 'a boolean' };
        }
        case 'ts': {
            const d = v instanceof Date ? v : (typeof v === 'string' ? new Date(v) : null);
            if (!d || Number.isNaN(d.getTime())) return { ok: false, expected: 'an ISO-8601 timestamp' };
            if (!_yearInRange(d)) return { ok: false, expected: `an ISO-8601 timestamp in the years ${MIN_YEAR}-${MAX_YEAR}` };
            return { ok: true, value: d.toISOString() };
        }
        case 'date': {
            const strict = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
            const d = strict
                ? new Date(`${strict}T00:00:00Z`)
                : (v instanceof Date ? v : (typeof v === 'string' ? new Date(v) : null));
            if (!d || Number.isNaN(d.getTime())) return { ok: false, expected: 'a date (YYYY-MM-DD)' };
            // JS rolls 2029-02-31 over to March; Postgres rejects it.
            if (strict && d.toISOString().slice(0, 10) !== strict) return { ok: false, expected: 'a date (YYYY-MM-DD)' };
            // The year check also guarantees toISOString() renders a plain
            // four-digit year — an extended year would slice to garbage.
            if (!_yearInRange(d)) return { ok: false, expected: `a date (YYYY-MM-DD) in the years ${MIN_YEAR}-${MAX_YEAR}` };
            return { ok: true, value: d.toISOString().slice(0, 10) };
        }
        default: {
            let s = null;
            if (typeof v === 'string') s = v;
            else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
            else if (typeof v === 'boolean') s = String(v);
            if (s === null) return { ok: false, expected: 'a string' };
            if (s.includes(NUL)) return { ok: false, expected: 'a string without NUL characters' };
            return { ok: true, value: s };
        }
    }
}

/**
 * 400 for a settings body. Carries the FIELD NAMES and the expected type or
 * range and nothing else — a settings value can be personal data (a DPO name,
 * a breach recipient's address), so it is never echoed back or logged
 * (BFSF-441). A range is named, never the value that missed it.
 */
class SettingsValidationError extends Error {
    /** @param {{field: string, expected: string}[]} fields */
    constructor(fields) {
        super(`Invalid settings value for: ${fields.map(f => f.field).join(', ')}`);
        this.name = 'SettingsValidationError';
        this.code = 'invalid_setting';
        this.status = 400;
        this.fields = fields;
        this.body = { error: 'invalid_setting', fields };
    }
}

/**
 * Turn an untrusted request body into a saveSettings patch:
 *   · keys outside SETTINGS_FIELDS are dropped (as saveSettings already does);
 *   · the owner-written columns (SETTINGS_REQUEST_DENY) are dropped, so a body
 *     can neither forge an attestation stamp nor switch a licensed framework
 *     on behind frameworkPolicy's back — a client that wants those uses their
 *     own route, and a whole-row round-trip PUT stays harmless;
 *   · every remaining value is coerced to its declared column type AND held to
 *     that column's domain (its int range, a storable year, no NUL), because a
 *     value Postgres refuses costs the caller the whole submit, not one field.
 * Absent keys and `undefined` stay absent, so the absent/null distinction the
 * merge rules depend on survives.
 * @throws {SettingsValidationError} when any value does not fit its column
 */
function sanitizeSettingsPatch(body) {
    const src = body && typeof body === 'object' ? body : {};
    const out = {};
    const bad = [];
    for (const f of SETTINGS_FIELDS) {
        if (f.owner) continue;
        if (!Object.prototype.hasOwnProperty.call(src, f.col)) continue;
        const v = src[f.col];
        if (v === undefined) continue;
        const r = _coerceSettingValue(f, v);
        if (r.ok) out[f.col] = r.value;
        else bad.push({ field: f.col, expected: /** @type {{expected: string}} */ (r).expected });
    }
    if (bad.length) throw new SettingsValidationError(bad);
    return out;
}

module.exports = { SettingsValidationError, sanitizeSettingsPatch };
