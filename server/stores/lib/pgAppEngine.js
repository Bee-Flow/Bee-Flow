// @typecheck
/**
 * Postgres app-data engine — the 'pg' implementation of the studioAppDbStore
 * facade contract (see that file's ENGINE FACADE CONTRACT block). Where the
 * sqlite blob engine materialises one data.db blob per app, this engine keeps
 * each app's tables in a dedicated Postgres SCHEMA (`app_<appId>`) inside the
 * EXISTING beeflow_core database — no blob, no flush pipeline, no replica
 * clobbering: Postgres itself is the multi-replica story.
 *
 *   query/exec/batch    one transaction each:
 *                       BEGIN → ownership+engine interlock → SET LOCAL
 *                       search_path = "app_<id>", pg_temp → statements → COMMIT
 *   applyMigration      same, with a per-statement SAVEPOINT so a replayed
 *                       plan skips already-applied DDL (SQLSTATE 42701/42P07)
 *                       instead of aborting — the pg analog of
 *                       dataModel.applyPlanTolerantly.
 *   schema stamp        a per-schema `_meta(key,value)` table, key
 *                       'schema_stamp' — the pg analog of PRAGMA user_version.
 *
 * ── TRUST BOUNDARY / SECURITY ───────────────────────────────────────
 * Identical to the sqlite engine: methods are MODULE-INTERNAL, only ever called
 * with compiler-generated SQL, never with client SQL. `ownerId` is a trust
 * boundary — every call re-verifies it against studio_apps.user_id (60 s
 * in-process cache) INSIDE the transaction, and refuses with the same message
 * the sqlite engine uses. The ENGINE INTERLOCK is checked in the same read:
 * studio_apps.engine must be 'pg' or the call fails with
 * { code: 'engine_mismatch', status: 503 } — a stale replica still configured
 * for pg can never touch an app the fleet has migrated back to sqlite (and
 * vice versa, enforced by the sqlite side in B3).
 *
 * All statements run with search_path pinned to the app's schema (+ pg_temp),
 * so compiler-emitted unqualified identifiers can only ever resolve inside
 * that app's namespace. The ownership SELECT runs BEFORE the SET LOCAL, while
 * the connection still resolves studio_apps normally.
 *
 * ── PLACEHOLDERS ────────────────────────────────────────────────────
 * The query compiler always emits `?` placeholders (sqlite style). This engine
 * converts them ONCE via toDollarParams(sql, expectedCount), which is
 * quote-aware and ASSERTS the `?` count equals params.length — a mismatch is a
 * compiler bug and must be loud, not a silently shifted bind.
 *
 * ── WIRE FORMAT (kept stable with the sqlite engine, cheaply) ───────
 * node-postgres would hand back BIGINT/NUMERIC as strings and DATE/TIMESTAMPTZ
 * as JS Dates (DATE at driver-local midnight — a JSON day-shift bug waiting
 * west of UTC). normalizeRows() converts, per result-field type id:
 *   int8/numeric → Number  ·  date → 'YYYY-MM-DD'  ·  timestamp(tz) → ISO
 * so rows serialize exactly like the sqlite engine's. BOOLEAN values stay
 * true/false (sqlite returns 0/1) — every audited consumer (FE boolValue(),
 * connectorSync truthiness) already accepts both; deliberately NOT coerced.
 *
 * ── DEPENDENCY INJECTION (load-bearing, not style) ──────────────────
 * `runQuery` and `getClient` are injected by the wrapper (studioAppDbStore)
 * instead of required here, exactly like the sqlite engine's `storage`/
 * `runQuery`: the wrapper's DB-free tests stub '../db' AS WRITTEN IN THE
 * WRAPPER, and the pg tests back this engine with pglite through the same
 * seam. Do NOT "simplify" this into a direct require('../../db').
 */

'use strict';
const log = require('../../telemetry/log');

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

/**
 * Build one engine instance.
 *
 * @param {object} config
 * @param {Function} config.runQuery    async (sql, params) => result — pooled,
 *                                      OUTSIDE any app transaction (metadata
 *                                      mirrors like db_size). Wrapper passes db.run.
 * @param {Function} config.getClient   async () => pg client with query() +
 *                                      release() — one checkout per app call.
 * @param {string}   config.logPrefix   Console tag, e.g. 'StudioAppDB'.
 * @param {string}   config.entityLabel Error noun, e.g. 'Studio App DB'.
 * @param {Function} config.schemaFor   (appId) => Postgres schema name
 *                                      ('app_' + appId, dashes kept — always
 *                                      quoted, and at 4+36 chars safely under
 *                                      the 63-char identifier limit).
 *
 * The three below decouple the engine from `studio_apps`. They default to the
 * App Studio behaviour, so the existing wiring and its tests construct the
 * engine exactly as before; a second consumer (automation datatables) passes
 * its own. schemaFor was already injected, but these three SQL statements were
 * not, which is what made the engine App-Studio-only in practice.
 *
 * @param {Function} [config.assertAccess]  async (client, ownerId, entityId) — runs
 *                                      INSIDE the transaction, BEFORE search_path
 *                                      is narrowed, so a metadata table in the
 *                                      public schema still resolves. Must throw
 *                                      404 when absent, refuse a different owner,
 *                                      and enforce any engine interlock.
 * @param {Function} [config.mirrorSize]   (entityId, ownerId, bytes) — fire-and-forget
 *                                      metadata mirror so list reads stay join-free.
 * @param {Function} [config.clearMeta]    async (client, entityId, ownerId) — zero that
 *                                      metadata when the schema is dropped.
 */
function createPgAppEngine({
    runQuery, getClient, logPrefix, entityLabel, schemaFor,
    assertAccess: assertAccessFn,
    mirrorSize: mirrorSizeFn,
    clearMeta: clearMetaFn,
} = /** @type {any} */ ({})) {
    if (typeof runQuery !== 'function' || typeof getClient !== 'function'
        || !logPrefix || !entityLabel || typeof schemaFor !== 'function') {
        throw new Error('createPgAppEngine requires runQuery, getClient, logPrefix, entityLabel, schemaFor');
    }

    // appId → { ownerId, engine, ts } — the 60 s ownership/interlock cache.
    const ownershipCache = new Map();
    // appId → { bytes, ts } — the 30 s sizeBytes cache.
    const sizeCache = new Map();

    function schemaIdent(appId) {
        return quoteIdent(schemaFor(appId));
    }

    /**
     * Verify (on the transaction's client) that `ownerId` owns `appId` and that
     * the app is marked for THIS engine. Row facts are cached 60 s; the
     * decisions are made per call, so a wrong owner is refused even on a cache
     * hit. Runs BEFORE search_path is narrowed, so studio_apps resolves.
     */
    async function assertOwnership(client, ownerId, appId) {
        if (assertAccessFn) return assertAccessFn(client, ownerId, appId);
        const cached = ownershipCache.get(appId);
        let row = (cached && (Date.now() - cached.ts) < OWNERSHIP_TTL_MS) ? cached : null;
        if (!row) {
            const res = await client.query('SELECT user_id, engine FROM studio_apps WHERE id = $1', [appId]);
            if (!res.rows || res.rows.length === 0) {
                /** @type {EngineError} */
                const e = new Error(`${entityLabel} app not found`);
                e.status = 404;
                throw e;
            }
            row = { ownerId: res.rows[0].user_id, engine: res.rows[0].engine, ts: Date.now() };
            ownershipCache.set(appId, row);
        }
        if (row.ownerId !== ownerId) {
            throw new Error(`${entityLabel} handle owned by another user — refusing to share`);
        }
        if (row.engine !== 'pg') {
            /** @type {EngineError} */
            const e = new Error('engine_mismatch');
            e.code = 'engine_mismatch';
            e.status = 503;
            throw e;
        }
    }

    /**
     * One app-scoped transaction: BEGIN [READ ONLY] → ownership/interlock →
     * SET LOCAL search_path = "app_<id>", pg_temp → fn(client) → COMMIT.
     * ROLLBACK on any error (mapped through mapPgError), client ALWAYS
     * released. READ ONLY makes Postgres itself enforce the sqlite engine's
     * "query() never mutates" rule — no fragile SQL sniffing.
     */
    async function withAppTx(ownerId, appId, { readOnly = false } = {}, fn) {
        const client = await getClient();
        try {
            await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
            await assertOwnership(client, ownerId, appId);
            await client.query(`SET LOCAL search_path = ${schemaIdent(appId)}, pg_temp`);
            const out = await fn(client);
            await client.query('COMMIT');
            return out;
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) { /* connection-level failure */ }
            throw mapPgError(err);
        } finally {
            client.release();
        }
    }

    // ── Facade contract ─────────────────────────────────────────────

    /** Read-only SELECT → { rows, columns, truncated } (rows capped at 10k). */
    async function query(ownerId, appId, sql, params = []) {
        validateSql(sql);
        const safeParams = normalizeParams(params);
        const converted = toDollarParams(sql, safeParams.length);
        return withAppTx(ownerId, appId, { readOnly: true }, async (client) => {
            const result = await client.query(converted, safeParams);
            const rows = normalizeRows(result);
            let truncated = false;
            if (rows.length > MAX_RESULT_ROWS) {
                rows.length = MAX_RESULT_ROWS;
                truncated = true;
            }
            return {
                rows,
                columns: result.fields?.map(f => f.name) || [],
                truncated,
            };
        });
    }

    /**
     * Single write/DDL statement → { changes }. With empty params and a
     * multi-statement string (compiler-joined DDL), runs it raw over the
     * simple protocol → { changes: 0, multi: true } — mirroring the sqlite
     * engine's db.exec path.
     */
    async function exec(ownerId, appId, sql, params = []) {
        validateSql(sql);
        const safeParams = normalizeParams(params);
        return withAppTx(ownerId, appId, {}, async (client) => {
            if (safeParams.length === 0 && /;\s*\S/.test(sql.trim())) {
                await client.query(sql); // simple protocol, several statements
                return { changes: 0, multi: true };
            }
            const converted = toDollarParams(sql, safeParams.length);
            const result = await client.query(converted, safeParams);
            return { changes: typeof result.rowCount === 'number' ? result.rowCount : 0 };
        });
    }

    /**
     * Run statements [{ sql, params? }] in ONE transaction. Per-statement
     * result: { rows } for row-returning statements, else { changes }.
     * `result.command === 'SELECT'` decides — a /^select/i sniff would misfile
     * the percentile CTE (`WITH … SELECT`) and any future RETURNING.
     */
    async function batch(ownerId, appId, statements) {
        if (!Array.isArray(statements) || statements.length === 0) {
            throw new Error('batch() requires a non-empty statements array');
        }
        if (statements.length > MAX_BATCH_STATEMENTS) {
            throw new Error(`batch() supports at most ${MAX_BATCH_STATEMENTS} statements per call`);
        }
        return withAppTx(ownerId, appId, {}, async (client) => {
            const results = [];
            for (const s of statements) {
                validateSql(s?.sql);
                const safeParams = normalizeParams(s?.params);
                const converted = toDollarParams(s.sql, safeParams.length);
                const result = await client.query(converted, safeParams);
                if (result.command === 'SELECT') {
                    const rows = normalizeRows(result);
                    results.push({ rows: rows.slice(0, MAX_RESULT_ROWS) });
                } else {
                    results.push({ changes: typeof result.rowCount === 'number' ? result.rowCount : 0 });
                }
            }
            return results;
        });
    }

    /**
     * Apply a migration plan. Tolerant replay is NATIVE here: each statement
     * runs under a SAVEPOINT, and the two "already applied" SQLSTATEs —
     * 42701 (duplicate column) and 42P07 (duplicate table/index) — roll back
     * to the savepoint and are recorded as skipped; anything else aborts the
     * whole transaction. With { targetVersion } the same transaction stamps
     * the per-schema `_meta.schema_stamp` (the PRAGMA user_version analog), so
     * schema change + stamp are atomic exactly like the sqlite override.
     *
     * With { client } the statements run on the CALLER's transaction (no
     * BEGIN/COMMIT here — the B3 migrator owns the boundary; note SET LOCAL
     * search_path then lives until the caller's COMMIT). Without it, the
     * engine opens its own transaction.
     */
    async function applyMigration(ownerId, appId, orderedDDL, { targetVersion = null, client = null } = {}) {
        if (!Array.isArray(orderedDDL)) {
            throw new Error('applyMigration requires an array of DDL strings');
        }
        if (orderedDDL.length > 500) {
            throw new Error('applyMigration supports at most 500 statements per call');
        }
        const stampVersion = (Number.isInteger(targetVersion) && targetVersion >= 0) ? targetVersion : null;
        if (orderedDDL.length === 0 && stampVersion === null) return { applied: 0, skipped: [] };

        const work = async (c) => {
            // The plan's CREATE TABLEs assume the app schema exists; first
            // migration is where it comes to exist. Without this, search_path
            // would fall through to pg_temp and CREATE TABLE would land in a
            // TEMPORARY schema — a silent data-loss trap.
            await c.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent(appId)}`);
            const skipped = [];
            let applied = 0;
            for (const ddl of orderedDDL) {
                if (typeof ddl !== 'string' || !ddl.trim()) {
                    throw new Error('DDL statement must be a non-empty string');
                }
                validateSql(ddl);
                await c.query('SAVEPOINT sp_migrate');
                try {
                    await c.query(ddl); // may be multi-statement (CREATE TABLE + its indexes)
                    applied++;
                    await c.query('RELEASE SAVEPOINT sp_migrate');
                } catch (e) {
                    if (e && (e.code === '42701' || e.code === '42P07')) {
                        await c.query('ROLLBACK TO SAVEPOINT sp_migrate');
                        const reason = e.code === '42701' ? 'column already added' : 'table or index already created';
                        skipped.push({ sql: ddl, reason });
                        log.warn(`[${logPrefix}] tolerant DDL skipped (${reason}): ${String(ddl).replace(/\s+/g, ' ').slice(0, 200)}`);
                        continue;
                    }
                    throw e;
                }
            }
            if (stampVersion !== null) {
                await c.query('CREATE TABLE IF NOT EXISTS "_meta" (key TEXT PRIMARY KEY, value TEXT)');
                // GREATEST, not EXCLUDED.value: two replicas can apply plans in
                // either order, and a slow one finishing second used to stamp
                // the tenant BACKWARDS — the stamp then reads as drift against a
                // model_version that is actually correct, and the repair path
                // built on it re-runs a migration that already landed. The
                // regex guard keeps a hand-edited / non-numeric value from
                // aborting the whole transaction on a cast.
                await c.query(
                    `INSERT INTO "_meta" (key, value) VALUES ('schema_stamp', $1)
                     ON CONFLICT (key) DO UPDATE SET value = GREATEST(
                         CASE WHEN "_meta".value ~ '^[0-9]+$' THEN "_meta".value::bigint ELSE 0 END,
                         EXCLUDED.value::bigint
                     )::text`,
                    [String(stampVersion)],
                );
            }
            return { applied, skipped };
        };

        if (client) {
            // Caller owns the transaction boundary — verify + scope on THEIR
            // client, run, and let them commit/rollback.
            //
            // AND HAND THE SEARCH PATH BACK. SET LOCAL lives until the
            // caller's COMMIT, so without the restore below every statement
            // the caller runs AFTER this — saveDataModel's own write to
            // studio_app_data_meta, for one — looks for a public table on a
            // path that no longer contains public. That made saving a data
            // model on the Postgres engine fail outright: installing a
            // template, adding a table, adding a column. The migrator
            // already restores the path by hand before it touches
            // studio_apps; this is the same discipline, moved into the
            // function that narrows it.
            await assertOwnership(client, ownerId, appId);
            await client.query(`SET LOCAL search_path = ${schemaIdent(appId)}, pg_temp`);
            try {
                return await work(client);
            } catch (err) {
                throw mapPgError(err);
            } finally {
                // DEFAULT = the session's configured path, for the rest of
                // this transaction. A failure here is swallowed: if the
                // transaction is already aborted the caller's error is the
                // one that matters.
                try { await client.query('SET LOCAL search_path = DEFAULT'); } catch { /* aborted tx */ }
            }
        }
        return withAppTx(ownerId, appId, {}, work);
    }

    /**
     * The engine-agnostic schema stamp (PRAGMA user_version analog): the value
     * of `_meta.schema_stamp`, 0 when the schema / table / row doesn't exist.
     */
    async function getSchemaStamp(ownerId, appId) {
        return withAppTx(ownerId, appId, { readOnly: true }, async (client) => {
            // to_regclass is search_path-aware and returns NULL (no error, no
            // aborted tx) when _meta doesn't exist yet.
            const reg = await client.query(`SELECT to_regclass('_meta') AS t`);
            if (!reg.rows?.[0]?.t) return 0;
            const res = await client.query(`SELECT value FROM "_meta" WHERE key = 'schema_stamp'`);
            const n = parseInt(res.rows?.[0]?.value, 10);
            return Number.isFinite(n) ? n : 0;
        });
    }

    /** Schema inspection → { tables: [{ name, columns: [...] }] } (sans _meta). */
    async function schema(ownerId, appId) {
        const schemaName = String(schemaFor(appId));
        return withAppTx(ownerId, appId, { readOnly: true }, async (client) => {
            const cols = await client.query(
                `SELECT table_name, column_name, data_type, is_nullable, column_default
                 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name <> '_meta'
                 ORDER BY table_name, ordinal_position`,
                [schemaName],
            );
            const pks = await client.query(
                `SELECT kcu.table_name, kcu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
                 WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
                [schemaName],
            );
            const pkSet = new Set((pks.rows || []).map(r => `${r.table_name}\u0000${r.column_name}`));
            const byTable = new Map();
            for (const r of (cols.rows || [])) {
                if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
                byTable.get(r.table_name).push({
                    name: r.column_name,
                    type: String(r.data_type || '').toUpperCase(),
                    notNull: r.is_nullable === 'NO',
                    defaultValue: r.column_default ?? null,
                    primaryKey: pkSet.has(`${r.table_name}\u0000${r.column_name}`),
                });
            }
            return { tables: [...byTable.entries()].map(([name, columns]) => ({ name, columns })) };
        });
    }

    /**
     * Total on-disk bytes of the app schema's relations (30 s cache). The
     * authoritative number for quota checks; also mirrored fire-and-forget
     * into studio_apps.db_size so app-list reads stay join-free.
     */
    async function sizeBytes(ownerId, appId) {
        const cached = sizeCache.get(appId);
        if (cached && (Date.now() - cached.ts) < SIZE_TTL_MS) return cached.bytes;
        const schemaName = String(schemaFor(appId));
        const bytes = await withAppTx(ownerId, appId, { readOnly: true }, async (client) => {
            const res = await client.query(
                `SELECT COALESCE(SUM(pg_total_relation_size(
                     (quote_ident(schemaname) || '.' || quote_ident(tablename))::regclass
                 )), 0) AS bytes
                 FROM pg_tables WHERE schemaname = $1`,
                [schemaName],
            );
            const n = Number(res.rows?.[0]?.bytes);
            return Number.isFinite(n) ? n : 0;
        });
        sizeCache.set(appId, { bytes, ts: Date.now() });
        Promise.resolve(
            mirrorSizeFn
                ? mirrorSizeFn(appId, ownerId, bytes)
                : runQuery(
                    'UPDATE studio_apps SET db_size = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
                    [bytes, appId, ownerId],
                ),
        ).catch(err => log.warn(`[${logPrefix}] db_size mirror failed for ${appId}:`, err.message));
        return bytes;
    }

    /** Drop the app schema entirely and zero the studio_apps size metadata. */
    async function reset(ownerId, appId) {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            await assertOwnership(client, ownerId, appId);
            await client.query(`DROP SCHEMA IF EXISTS ${schemaIdent(appId)} CASCADE`);
            if (clearMetaFn) {
                await clearMetaFn(client, appId, ownerId);
            } else {
                await client.query(
                    `UPDATE studio_apps SET db_sha256 = '', db_size = 0, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
                    [appId, ownerId],
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            throw mapPgError(err);
        } finally {
            client.release();
        }
        sizeCache.delete(appId);
    }

    // Postgres commits ARE durability — nothing to flush. Kept so the facade
    // surface is identical across engines.
    async function flush(_ownerId, _appId) { /* no-op */ }

    /** Drop cached facts for one app (ownership + size). */
    async function invalidate(appId) {
        ownershipCache.delete(appId);
        sizeCache.delete(appId);
    }

    /** Clear every cache. No handles to close — the pool belongs to db.js. */
    async function closeAll() {
        ownershipCache.clear();
        sizeCache.clear();
    }

    return {
        query,
        exec,
        batch,
        applyMigration,
        getSchemaStamp,
        schema,
        sizeBytes,
        reset,
        flush,
        invalidate,
        closeAll,
        // Test-only
        _ownershipCache: ownershipCache,
        _sizeCache: sizeCache,
        _normalizeParams: normalizeParams,
    };
}

module.exports = {
    createPgAppEngine,
    toDollarParams,
    mapPgError,
    _normalizeRows: normalizeRows,
    _dateOnlyString: dateOnlyString,
};
