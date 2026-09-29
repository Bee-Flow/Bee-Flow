/**
 * Canonical JSON for the compliance evidence chain.
 *
 * Why a canonical form at all
 * ---------------------------
 * compliance_evidence.payload is a JSONB column. Postgres does not keep the
 * bytes it was given: on write it re-encodes the document into its own binary
 * form and on read it prints that form back — object keys come out in JSONB's
 * own order (shorter keys first, then bytewise), whitespace is gone, and
 * numbers are printed as `numeric` text (`1.0` becomes `1`). So the string a
 * caller hashed at write time (`JSON.stringify(payload)`) is generally NOT the
 * string `JSON.stringify(row.payload)` yields on read. That is exactly why the
 * old A.5.28 check could only recompute hashes "as corroboration" and never
 * gate on them.
 *
 * canonicalJSON() makes the serialisation a function of the VALUE rather than
 * of the bytes, so hashing the payload as written and hashing the payload as
 * read back from JSONB give the same digest. It is the input to
 * `payload_hash` (see chain.js) and therefore part of the chain contract:
 * changing this algorithm invalidates every stored payload_hash. Append-only,
 * no rewriting of historic hashes — so do not change it.
 *
 * Algorithm
 * ---------
 *  1. A JSON round-trip: JSON.parse(JSON.stringify(value)). This applies, in
 *     one step, every coercion the JSONB write path applies:
 *       - `undefined` properties and functions disappear;
 *       - Date (and anything else with toJSON) collapses to its JSON form —
 *         a Date to its ISO-8601 string;
 *       - NaN and ±Infinity become null (JSON has no representation);
 *       - numbers are reduced to their shortest round-trippable double
 *         representation, which is also what comes back after the JSONB
 *         `numeric` round-trip and JSON.parse in node-postgres — `1.0`,
 *         `1` and `1e0` all canonicalise to `1`; `0.1 + 0.2` stays
 *         `0.30000000000000004` in both directions.
 *  2. A recursive serialisation of the round-tripped value: object keys sorted
 *     by Unicode code point, arrays in element order, scalars (null, boolean,
 *     number, string) through JSON.stringify so strings are escaped
 *     identically everywhere. No whitespace.
 *
 * Not covered (documented limits, not bugs)
 * -----------------------------------------
 *  - BigInt: JSON.stringify throws a TypeError and we let it propagate. An
 *    evidence payload has no business carrying one.
 *  - NaN / ±Infinity: serialised as null (see step 1); the original value is
 *    lost before it is hashed, so the write side must not rely on it.
 *  - Numeric precision: integers above 2^53 and numerics with more than 17
 *    significant digits are already rounded in JS before the write. JSONB would
 *    have kept the text exactly, but it never sees it, so the round-trip is
 *    still stable — the caller's intended value, however, is not what was
 *    stored.
 *  - U+0000 inside strings: JSONB rejects it ("unsupported Unicode escape
 *    sequence"), so the INSERT itself fails; nothing to canonicalise.
 *  - Unicode normalisation: strings are compared and serialised as JS strings,
 *    JSONB stores UTF-8 and returns the same code points. Non-NFC input stays
 *    non-NFC on both sides, so the round-trip is stable, but two strings that
 *    are canonically equivalent still hash differently.
 *  - Negative zero: JSON.stringify(-0) === '0' on both sides — the sign is
 *    dropped consistently.
 */

const crypto = require('crypto');

/**
 * Compare two strings by Unicode code point (not UTF-16 code unit). The default
 * Array#sort compares code units, which orders U+FFFF before U+10000 — a
 * different order from what a bytewise-UTF-8 implementation in another
 * language would produce. Code-point order is the one every language agrees
 * on, so an external verifier can reproduce the digest.
 */
function compareCodePoints(a, b) {
    const ia = a[Symbol.iterator]();
    const ib = b[Symbol.iterator]();
    for (;;) {
        const x = ia.next();
        const y = ib.next();
        if (x.done && y.done) return 0;
        if (x.done) return -1;
        if (y.done) return 1;
        const cx = x.value.codePointAt(0);
        const cy = y.value.codePointAt(0);
        if (cx !== cy) return cx - cy;
    }
}

// Recursive serialiser over an already round-tripped value: only null,
// boolean, number, string, array and plain object can occur here.
function serialise(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(serialise).join(',')}]`;
    const keys = Object.keys(v).sort(compareCodePoints);
    return `{${keys.map(k => `${JSON.stringify(k)}:${serialise(v[k])}`).join(',')}}`;
}

/**
 * Deterministic JSON text for `value`, stable across the Postgres JSONB
 * round-trip (see the header).
 * @param {any} value
 * @returns {string}
 */
function canonicalJSON(value) {
    // JSON.stringify(undefined) is undefined, not a string — a top-level
    // undefined would make JSON.parse throw. Treat it as null, which is what
    // JSON.stringify does for undefined INSIDE an array anyway.
    const text = JSON.stringify(value);
    const normalised = text === undefined ? null : JSON.parse(text);
    return serialise(normalised);
}

/**
 * `payload_hash` of an evidence payload: sha256 over the canonical JSON.
 * A falsy payload hashes as `{}`, matching what complianceStore.addEvidence
 * stores for a missing payload.
 * @param {any} payload
 * @returns {string} 64 lowercase hex characters
 */
function hashPayload(payload) {
    return crypto.createHash('sha256').update(canonicalJSON(payload || {})).digest('hex');
}

module.exports = { canonicalJSON, hashPayload, compareCodePoints };
