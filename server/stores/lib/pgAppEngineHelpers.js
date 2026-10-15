// @typecheck
/**
 * Pure helpers of the Postgres app-data engine (see pgAppEngine.js for the
 * contract): SQL validation, `?` -> `$n` conversion, bind-param hygiene, wire
 * format normalization and Postgres error mapping. No I/O, no state.
 */

'use strict';

const MAX_SQL_BYTES = 500_000;   // mirrors sqliteBlobEngine
const MAX_RESULT_ROWS = 10_000;  // mirrors sqliteBlobEngine
const MAX_BATCH_STATEMENTS = 500;
const OWNERSHIP_TTL_MS = 60_000;
const SIZE_TTL_MS = 30_000;

// ── Pure helpers ────────────────────────────────────────────────────


/** An Error carrying the HTTP status and the field it is about. @typedef {Error & { status?: number, code?: string, tableId?: string, fieldId?: string, column?: string, constraint?: string }} EngineError */
function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

function validateSql(sql) {
    if (typeof sql !== 'string' || !sql.trim()) {
        throw new Error('sql must be a non-empty string');
    }
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
        throw new Error(`sql is larger than the ${MAX_SQL_BYTES}-byte limit`);
    }
}

/**
 * Convert compiler-emitted `?` placeholders to Postgres `$1..$n`, skipping
 * quoted regions ('…' string literals with doubled '' escapes, and "…"
 * identifiers). Compiled SQL never carries a literal `?` inside quotes today,
 * but the tokenizer costs nothing and makes that a non-assumption.
 *
 * ASSERTS the placeholder count equals `expectedCount` — a mismatch means the
 * compiler and its params drifted apart, which must throw rather than bind
 * values one position off.
 */
function toDollarParams(sql, expectedCount) {
    let out = '';
    let n = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (inSingle) {
            out += ch;
            if (ch === "'") inSingle = false; // a doubled '' just toggles twice
            continue;
        }
        if (inDouble) {
            out += ch;
            if (ch === '"') inDouble = false;
            continue;
        }
        if (ch === "'") { inSingle = true; out += ch; continue; }
        if (ch === '"') { inDouble = true; out += ch; continue; }
        if (ch === '?') { n++; out += `$${n}`; continue; }
        out += ch;
    }
    if (n !== expectedCount) {
        throw new Error(`placeholder count mismatch: sql has ${n} \`?\` placeholders but ${expectedCount} params were provided`);
    }
    return out;
}

/**
 * Bind-param hygiene, pg flavor: null/undefined → null, scalars (INCLUDING
 * booleans — pg has a real BOOLEAN type) and Buffers/Dates pass through,
 * objects/arrays JSON-stringify (same courtesy as the sqlite engine).
 */
function normalizeParams(params) {
    if (params === undefined || params === null) return [];
    if (!Array.isArray(params)) {
        throw new Error('params must be an array (positional ? placeholders)');
    }
    return params.map(v => {
        if (v === null || v === undefined) return null;
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean') return v;
        if (Buffer.isBuffer(v) || v instanceof Date) return v;
        return JSON.stringify(v);
    });
}

// PG wire type OIDs this engine normalizes (see WIRE FORMAT header note).
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;

function pad2(n) { return String(n).padStart(2, '0'); }

// A DATE column parsed by the driver into a JS Date. node-postgres parses at
// LOCAL midnight, pglite at UTC midnight — pick the accessor family that lands
// on midnight (that is the parser's), so the calendar day survives both.
function dateOnlyString(v) {
    if (!(v instanceof Date)) return typeof v === 'string' ? v.slice(0, 10) : v;
    const utcMidnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0
        && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
    if (utcMidnight) return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
    return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
}

/** In-place wire-format normalization of a driver result's rows. */
function normalizeRows(result) {
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const fields = Array.isArray(result?.fields) ? result.fields : [];
    const fixups = fields.filter(f => f && (
        f.dataTypeID === OID_INT8 || f.dataTypeID === OID_NUMERIC
        || f.dataTypeID === OID_DATE || f.dataTypeID === OID_TIMESTAMP || f.dataTypeID === OID_TIMESTAMPTZ
    ));
    if (!fixups.length) return rows;
    for (const row of rows) {
        for (const f of fixups) {
            const v = row[f.name];
            if (v === null || v === undefined) continue;
            if (f.dataTypeID === OID_INT8 || f.dataTypeID === OID_NUMERIC) {
                if (typeof v === 'string') {
                    const num = Number(v);
                    if (Number.isFinite(num)) row[f.name] = num;
                }
            } else if (f.dataTypeID === OID_DATE) {
                row[f.name] = dateOnlyString(v);
            } else if (v instanceof Date) {
                row[f.name] = v.toISOString();
            }
        }
    }
    return rows;
}

// Constraint names are minted by dataModel.uniqueIndexName as
// uq_<tableId>_<fieldId> — stable ids, so a violation can name its field.
const UNIQUE_CONSTRAINT_RE = /^uq_(tbl_[a-z0-9]+)_(fld_[a-z0-9]+)$/;

// Postgres names the offending columns in DETAIL as `Key (email)=(x) already
// exists.` — the only place a violation carries the HUMAN column name, since
// the constraint is named after the field's internal id.
const DETAIL_KEY_RE = /^Key \(([^)]+)\)=/;

function detailColumns(err) {
    return (DETAIL_KEY_RE.exec(String(err?.detail || '')) || [])[1] || '';
}

/**
 * Map raw Postgres errors to the caller-facing shapes the routes understand:
 *   23505 (unique_violation)      → 409, code 'unique_violation', column named
 *   23503 (foreign_key_violation) → 422, code 'relation_violation'
 *   23502 (not_null_violation)    → 422, code 'required_value', column named
 *   22xxx (data exception class)  → 422, code 'invalid_value'
 *   25006 (read-only tx)          → the sqlite engine's query()-refusal message
 * Anything else passes through untouched (routes answer a generic 500).
 *
 * The MESSAGE always names the column the person typed into. `fld_9a1c2f` is
 * the model's internal id and means nothing to anybody reading the response —
 * it stays on the error object for programmatic use and out of the sentence.
 */
function mapPgError(err) {
    const code = err && typeof err.code === 'string' ? err.code : '';
    if (!code) return err;
    if (code === '23505') {
        const constraint = String(err.constraint
            || (String(err.message || '').match(/unique constraint "([^"]+)"/) || [])[1]
            || '');
        const m = UNIQUE_CONSTRAINT_RE.exec(constraint);
        const column = detailColumns(err);
        /** @type {EngineError} */
        const e = new Error(column
            ? `A record with this value already exists — "${column}" must be unique`
            : (m
                ? `A record with this value already exists — field ${m[2]} must be unique`
                : 'A record with this value already exists — the field must be unique'));
        e.status = 409;
        e.code = 'unique_violation';
        if (m) { e.tableId = m[1]; e.fieldId = m[2]; }
        if (column) e.column = column;
        if (constraint) e.constraint = constraint;
        e.cause = err;
        return e;
    }
    if (code === '23502') {
        // Reached two ways, and both need the human name: a write that omits a
        // required value, and an ADD COLUMN … NOT NULL against a table that
        // already has rows. `err.column` is the physical column, which for
        // these models IS the author's key.
        const column = String(err.column || '') || detailColumns(err);
        /** @type {EngineError} */
        const e = new Error(column
            ? `"${column}" is required — every row needs a value for it`
            : 'A required value is missing');
        e.status = 422;
        e.code = 'required_value';
        if (column) e.column = column;
        e.cause = err;
        return e;
    }
    if (code === '23503') {
        /** @type {EngineError} */
        const e = new Error('This change points at a related record that does not exist');
        e.status = 422;
        e.code = 'relation_violation';
        e.cause = err;
        return e;
    }
    if (code.startsWith('22')) {
        /** @type {EngineError} */
        const e = new Error('A value does not fit its column type');
        e.status = 422;
        e.code = 'invalid_value';
        e.cause = err;
        return e;
    }
    if (code === '25006') {
        /** @type {EngineError} */
        const e = new Error('query() refuses to run a statement that mutates the database — use exec() instead');
        e.cause = err;
        return e;
    }
    return err;
}

module.exports = {
    MAX_SQL_BYTES,
    MAX_RESULT_ROWS,
    MAX_BATCH_STATEMENTS,
    OWNERSHIP_TTL_MS,
    SIZE_TTL_MS,
    quoteIdent,
    validateSql,
    toDollarParams,
    normalizeParams,
    normalizeRows,
    dateOnlyString,
    mapPgError,
};
