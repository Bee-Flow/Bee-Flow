// @typecheck
/**
 * Transaction-scoped sub-factories of the Postgres app-data engine
 * (pgAppEngine.js composes them). `makeTx` owns the ownership/interlock check and
 * the app-scoped transaction; `makeStatements` and `makeMigration` run on top of
 * it. Moved verbatim out of createPgAppEngine: same SQL, same scoping.
 *
 * @typedef {import('./pgAppEngineHelpers').EngineError} EngineError
 */

'use strict';
const log = require('../../telemetry/log');
const {
    MAX_RESULT_ROWS, MAX_BATCH_STATEMENTS, OWNERSHIP_TTL_MS,
    quoteIdent, validateSql, toDollarParams, normalizeParams, normalizeRows, mapPgError,
} = require('./pgAppEngineHelpers');

/** Ownership/interlock check + the app-scoped transaction wrapper. */
function makeTx({ getClient, entityLabel, schemaFor, assertAccessFn, ownershipCache }) {
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
            try { await client.query('ROLLBACK'); } catch (err) { log.debug('connection-level failure', err); }
            throw mapPgError(err);
        } finally {
            client.release();
        }
    }

    return { schemaIdent, assertOwnership, withAppTx };
}

/** query / exec / batch: the statement runners. */
function makeStatements({ withAppTx }) {
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

    return { query, exec, batch };
}

/** applyMigration / getSchemaStamp: DDL replay and the schema stamp. */
function makeMigration({ logPrefix, schemaIdent, assertOwnership, withAppTx }) {
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
                try { await client.query('SET LOCAL search_path = DEFAULT'); } catch (err) { log.debug('aborted tx', err); }
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

    return { applyMigration, getSchemaStamp };
}

module.exports = { makeTx, makeStatements, makeMigration };
