// @typecheck
'use strict';

/**
 * The statement API of the SQLite-blob engine (./sqliteBlobEngine.js): read
 * (query, schema) and write (exec, batch, applyMigration) over a handle from
 * the loader, plus the stateless SQL/param helpers they share.
 */

const MAX_SQL_BYTES = 500_000;
const MAX_RESULT_ROWS = 10_000;

// ── Pure helpers (stateless — shared across engine instances) ───────

function validateSql(sql) {
    if (typeof sql !== 'string' || !sql.trim()) {
        throw new Error('sql must be a non-empty string');
    }
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
        throw new Error(`sql is larger than the ${MAX_SQL_BYTES}-byte limit`);
    }
}

function normalizeParams(params) {
    if (params === undefined || params === null) return [];
    if (!Array.isArray(params)) {
        throw new Error('params must be an array (positional ? placeholders)');
    }
    return params.map(v => {
        if (v === null || v === undefined) return null;
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'bigint') return v;
        // better-sqlite3 only binds numbers/strings/bigints/buffers/null — a raw
        // boolean throws a TypeError at bind time. SQLite has no boolean type
        // anyway (its docs recommend 0/1), so coerce here rather than pushing
        // this footgun onto every caller.
        if (t === 'boolean') return v ? 1 : 0;
        if (Buffer.isBuffer(v)) return v;
        // Objects/arrays aren't natively supported by SQLite — stringify so the
        // caller doesn't have to remember to JSON.stringify themselves.
        return JSON.stringify(v);
    });
}

function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

/** @param {object} deps  getHandle (from the loader). */
function createReadApi({ getHandle }) {
    /**
     * Return a read handle. Identical to getWriteHandle today — reads and
     * writes share the in-process handle. Kept separate to document read
     * intent and to leave room for read-replica routing later.
     */
    async function getReadHandle(ownerId, id) {
        return getHandle(ownerId, id);
    }

    /**
     * Run a read-only SELECT. Errors if the SQL isn't read-only (per
     * better-sqlite3's `prepare().readonly` check) so write paths can't sneak
     * in via the query entry point.
     */
    async function query(ownerId, id, sql, params = []) {
        validateSql(sql);
        const entry = await getReadHandle(ownerId, id);
        const stmt = entry.db.prepare(sql);
        if (!stmt.readonly) {
            throw new Error('query() refuses to run a statement that mutates the database — use exec() instead');
        }
        const safeParams = normalizeParams(params);
        const rows = safeParams.length ? stmt.all(...safeParams) : stmt.all();
        if (rows.length > MAX_RESULT_ROWS) {
            rows.length = MAX_RESULT_ROWS;
        }
        const columns = (stmt.columns?.() || []).map(c => c.name);
        return { rows, columns, truncated: rows.length === MAX_RESULT_ROWS };
    }

    /**
     * Inspect the schema — tables, their columns, and column types.
     */
    async function schema(ownerId, id) {
        const entry = await getReadHandle(ownerId, id);
        const tables = entry.db
            .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all();
        const out = [];
        for (const t of tables) {
            const cols = entry.db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all();
            out.push({
                name: t.name,
                sql: t.sql,
                columns: cols.map(c => ({
                    name: c.name,
                    type: c.type,
                    notNull: !!c.notnull,
                    defaultValue: c.dflt_value,
                    primaryKey: !!c.pk,
                })),
            });
        }
        return { tables: out };
    }

    return { getReadHandle, query, schema };
}

/** @param {object} deps  getHandle (loader), scheduleFlush (flusher), entityLabel. */
function createWriteApi({ getHandle, scheduleFlush, entityLabel }) {
    /**
     * Return the writable handle. In single-replica mode this is just
     * getHandle; the accessor exists so future lease-based multi-replica
     * routing has a single seam to change without touching every caller.
     */
    async function getWriteHandle(ownerId, id) {
        return getHandle(ownerId, id);
    }

    // A poisoned handle detected a foreign flush (see flushNow) — accepting
    // more writes would grow a local state that can never be persisted.
    function assertWritable(entry) {
        if (entry.poisoned) {
            throw new Error(`${entityLabel} is stale: another replica has written this database — refresh required`);
        }
    }

    /**
     * Run a single write or DDL statement. With `params` empty, accepts
     * multi-statement SQL (e.g. several CREATE TABLEs at once) via `db.exec`.
     * With `params`, runs a single prepared statement and returns
     * `{ changes, lastInsertRowid }`.
     */
    async function exec(ownerId, id, sql, params = []) {
        validateSql(sql);
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const safeParams = normalizeParams(params);

        let result;
        if (safeParams.length === 0 && /;\s*\S/.test(sql.trim())) {
            // Multi-statement script (no params): use db.exec which doesn't
            // return per-statement counts but can run several statements.
            entry.db.exec(sql);
            result = { changes: 0, lastInsertRowid: 0, multi: true };
        } else {
            const r = entry.db.prepare(sql).run(...safeParams);
            result = {
                changes: r.changes,
                lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
            };
        }
        scheduleFlush(id);
        return result;
    }

    /**
     * Run a series of statements in a single transaction. Each statement is
     * `{ sql, params? }`. Returns an array of per-statement results. At most
     * 500 statements per call.
     */
    async function batch(ownerId, id, statements) {
        if (!Array.isArray(statements) || statements.length === 0) {
            throw new Error('batch() requires a non-empty statements array');
        }
        if (statements.length > 500) {
            throw new Error('batch() supports at most 500 statements per call');
        }
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const tx = entry.db.transaction((stmts) => {
            const results = [];
            for (const s of stmts) {
                validateSql(s?.sql);
                const params = normalizeParams(s?.params);
                const stmt = entry.db.prepare(s.sql);
                if (stmt.readonly) {
                    const rows = params.length ? stmt.all(...params) : stmt.all();
                    results.push({ rows: rows.slice(0, MAX_RESULT_ROWS) });
                } else {
                    const r = params.length ? stmt.run(...params) : stmt.run();
                    results.push({
                        changes: r.changes,
                        lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
                    });
                }
            }
            return results;
        });
        const results = tx(statements);
        scheduleFlush(id);
        return results;
    }

    /**
     * Apply an ordered list of DDL statements (a migration plan) inside ONE
     * transaction — all-or-nothing, so a half-applied schema change can never
     * be flushed. Each entry is a SQL string. Returns { applied: N }.
     */
    async function applyMigration(ownerId, id, orderedDDL) {
        if (!Array.isArray(orderedDDL)) {
            throw new Error('applyMigration requires an array of DDL strings');
        }
        if (orderedDDL.length === 0) return { applied: 0 };
        if (orderedDDL.length > 500) {
            throw new Error('applyMigration supports at most 500 statements per call');
        }
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const tx = entry.db.transaction((ddls) => {
            let applied = 0;
            for (const ddl of ddls) {
                validateSql(ddl);
                // Migration DDL may itself be multi-statement (e.g. add-column +
                // backfill); db.exec handles both single and multi.
                entry.db.exec(ddl);
                applied++;
            }
            return applied;
        });
        const applied = tx(orderedDDL);
        scheduleFlush(id);
        return { applied };
    }

    return { getWriteHandle, exec, batch, applyMigration };
}

module.exports = { createReadApi, createWriteApi, validateSql, normalizeParams, quoteIdent, MAX_SQL_BYTES, MAX_RESULT_ROWS };
