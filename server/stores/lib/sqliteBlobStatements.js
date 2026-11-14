// @typecheck
'use strict';

/**
 * The statement API of the SQLite-blob engine (./sqliteBlobEngine.js): read
 * (query, schema) and write (exec, batch, applyMigration) over a handle from
 * the loader, plus the stateless SQL/param helpers they share.
 *
 * Two layers. STATEMENT_OPS are the operations on one open better-sqlite3
 * connection, pure functions of (db, ...args). The APIs below resolve the
 * caller's handle (download, owner check, poison check), validate the SQL,
 * and hand the operation to a RUNNER (./sqliteStatementRunner.js), which runs
 * it in the statement process under a deadline, or in this process when the
 * deadline is off.
 */

const { assertPageStatement } = require('./sqliteStatementGuard');

const MAX_SQL_BYTES = 500_000;
const MAX_RESULT_ROWS = 10_000;
const MAX_BATCH_STATEMENTS = 500;

// ── Pure helpers (stateless — shared across engine instances) ───────

/**
 * @param {string} sql
 */
function validateSql(sql) {
    if (typeof sql !== 'string' || !sql.trim()) {
        throw new Error('sql must be a non-empty string');
    }
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
        throw new Error(`sql is larger than the ${MAX_SQL_BYTES}-byte limit`);
    }
    // Every statement that reaches a page database passes this one check, so
    // each entry point (query, exec, batch, applyMigration) is covered.
    assertPageStatement(sql);
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
        // A typed array that crossed a process boundary (the structured clone
        // of a Buffer) is still a blob.
        if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        // Objects/arrays aren't natively supported by SQLite — stringify so the
        // caller doesn't have to remember to JSON.stringify themselves.
        return JSON.stringify(v);
    });
}

/**
 * @param {string} name
 */
function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * @param {{ sql?: unknown, params?: unknown }[]} statements
 * @param {string} label
 */
function validateBatch(statements, label) {
    if (!Array.isArray(statements) || statements.length === 0) {
        throw new Error(`${label}() requires a non-empty statements array`);
    }
    if (statements.length > MAX_BATCH_STATEMENTS) {
        throw new Error(`${label}() supports at most ${MAX_BATCH_STATEMENTS} statements per call`);
    }
}

/** @param {{ changes: number, lastInsertRowid: number | bigint }} r */
function runResult(r) {
    return {
        changes: r.changes,
        lastInsertRowid: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid,
    };
}

// ── Operations on one open connection ───────────────────────────────
// Each validates what it runs: the runner may execute these in another
// process, and nothing reaches a page database without passing the guard.

/**
 * @typedef {ReturnType<typeof import('./sqliteOpen').openPageDatabase>} SqliteDb
 * @typedef {{ name: string, type: string, notnull: number, dflt_value: unknown, pk: number }} TableInfoRow
 */

/** @type {Record<string, (db: SqliteDb, ...args: any[]) => unknown>} */
const STATEMENT_OPS = {
    /**
     * A read-only SELECT. Refuses SQL that isn't read-only (better-sqlite3's
     * `prepare().readonly`) so write paths can't sneak in via the query entry point.
     */
    query(db, sql, params = []) {
        validateSql(sql);
        const stmt = db.prepare(sql);
        if (!stmt.readonly) {
            throw new Error('query() refuses to run a statement that mutates the database — use exec() instead');
        }
        const safeParams = normalizeParams(params);
        const rows = safeParams.length ? stmt.all(...safeParams) : stmt.all();
        if (rows.length > MAX_RESULT_ROWS) {
            rows.length = MAX_RESULT_ROWS;
        }
        const columns = (stmt.columns?.() || []).map((/** @type {{ name: string }} */ c) => c.name);
        return { rows, columns, truncated: rows.length === MAX_RESULT_ROWS };
    },

    /** Tables, their columns, and column types. */
    schema(db) {
        const tables = /** @type {{ name: string, sql: string }[]} */ (db
            .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all());
        const out = [];
        for (const t of tables) {
            const cols = db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all();
            out.push({
                name: t.name,
                sql: t.sql,
                columns: /** @type {TableInfoRow[]} */ (cols).map((c) => ({
                    name: c.name,
                    type: c.type,
                    notNull: !!c.notnull,
                    defaultValue: c.dflt_value,
                    primaryKey: !!c.pk,
                })),
            });
        }
        return { tables: out };
    },

    /**
     * One write or DDL statement. With `params` empty, accepts multi-statement
     * SQL (several CREATE TABLEs at once) via `db.exec`. With `params`, runs
     * one prepared statement and returns `{ changes, lastInsertRowid }`.
     */
    exec(db, sql, params = []) {
        validateSql(sql);
        const safeParams = normalizeParams(params);
        if (safeParams.length === 0 && /;\s*\S/.test(sql.trim())) {
            // Multi-statement script (no params): db.exec doesn't return
            // per-statement counts but can run several statements.
            db.exec(sql);
            return { changes: 0, lastInsertRowid: 0, multi: true };
        }
        return runResult(db.prepare(sql).run(...safeParams));
    },

    /** A series of `{ sql, params? }` in one transaction; per-statement results. */
    batch(db, statements) {
        validateBatch(statements, 'batch');
        const tx = db.transaction((/** @type {{ sql: string, params?: unknown[], expectChanges?: boolean }[]} */ stmts) => {
            const results = [];
            for (let i = 0; i < stmts.length; i++) {
                const s = stmts[i];
                validateSql(s?.sql);
                const params = normalizeParams(s?.params);
                const stmt = db.prepare(s.sql);
                if (stmt.readonly) {
                    const rows = params.length ? stmt.all(...params) : stmt.all();
                    results.push({ rows: rows.slice(0, MAX_RESULT_ROWS) });
                } else {
                    const res = runResult(params.length ? stmt.run(...params) : stmt.run());
                    // A statement that MUST change a row: none changed rolls the batch back.
                    if (s.expectChanges === true && !res.changes) {
                        throw Object.assign(new Error(`batch statement ${i} changed no rows`), { code: 'batch_no_rows', statementIndex: i });
                    }
                    results.push(res);
                }
            }
            return results;
        });
        return tx(statements);
    },

    /** An ordered list of DDL strings in ONE transaction, all or nothing. */
    applyMigration(db, orderedDDL) {
        const tx = db.transaction((/** @type {string[]} */ ddls) => {
            let applied = 0;
            for (const ddl of ddls) {
                validateSql(ddl);
                // Migration DDL may itself be multi-statement (add-column +
                // backfill); db.exec handles both single and multi.
                db.exec(ddl);
                applied++;
            }
            return applied;
        });
        return { applied: tx(orderedDDL) };
    },
};

/**
 * @typedef {{ run: (entry: import('./sqliteBlobHandles').BlobHandle, op: keyof typeof STATEMENT_OPS, args: unknown[]) => Promise<any> }} StatementRunner
 * @typedef {{ rows: Record<string, unknown>[], columns: string[], truncated: boolean }} QueryResult
 * @typedef {{ name: string, type: string, notNull: boolean, defaultValue: unknown, primaryKey: boolean }} SchemaColumn
 * @typedef {{ tables: Array<{ name: string, sql: string, columns: SchemaColumn[] }> }} SchemaResult
 * @typedef {{ changes: number, lastInsertRowid: number, multi?: boolean }} ExecResult
 */

/** @param {{ getHandle: ReturnType<typeof import('./sqliteBlobHandles').createHandleLoader>['getHandle'], runner: StatementRunner }} deps */
function createReadApi({ getHandle, runner }) {
    /**
     * Return a read handle. Identical to getWriteHandle today — reads and
     * writes share the in-process handle. Kept separate to document read
     * intent and to leave room for read-replica routing later.
     * @param {string} ownerId
     * @param {string} id
     */
    async function getReadHandle(ownerId, id) {
        return getHandle(ownerId, id);
    }

    /**
     * Run a read-only SELECT (see STATEMENT_OPS.query).
     * @param {string} sql
     * @returns {Promise<QueryResult>}
     * @param {string} ownerId
     * @param {string} id
     */
    async function query(ownerId, id, sql, params = []) {
        validateSql(sql);
        const safeParams = normalizeParams(params);
        const entry = await getReadHandle(ownerId, id);
        return runner.run(entry, 'query', [sql, safeParams]);
    }

    /**
     * Inspect the schema — tables, their columns, and column types.
     * @returns {Promise<SchemaResult>}
     * @param {string} ownerId
     * @param {string} id
     */
    async function schema(ownerId, id) {
        const entry = await getReadHandle(ownerId, id);
        return runner.run(entry, 'schema', []);
    }

    return { getReadHandle, query, schema };
}

/**
 * @param {{ getHandle: ReturnType<typeof import('./sqliteBlobHandles').createHandleLoader>['getHandle'], scheduleFlush: ReturnType<typeof import('./sqliteBlobFlush').createFlusher>['scheduleFlush'], entityLabel: string, runner: StatementRunner }} deps
 *   getHandle (loader), scheduleFlush (flusher), entityLabel, runner.
 */
function createWriteApi({ getHandle, scheduleFlush, entityLabel, runner }) {
    /**
     * Return the writable handle. In single-replica mode this is just
     * getHandle; the accessor exists so future lease-based multi-replica
     * routing has a single seam to change without touching every caller.
     * @param {string} ownerId
     * @param {string} id
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
     * Run a single write or DDL statement (see STATEMENT_OPS.exec).
     * @param {string} sql
     * @returns {Promise<ExecResult>}
     * @param {string} ownerId
     * @param {string} id
     */
    async function exec(ownerId, id, sql, params = []) {
        validateSql(sql);
        const safeParams = normalizeParams(params);
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const result = await runner.run(entry, 'exec', [sql, safeParams]);
        scheduleFlush(id);
        return result;
    }

    /**
     * Run a series of statements in a single transaction. Each statement is
     * `{ sql, params? }`. Returns an array of per-statement results. At most
     * 500 statements per call.
     * @returns {Promise<Array<{ rows: Record<string, unknown>[] } | ExecResult>>}
     */
    async function batch(ownerId, id, statements) {
        validateBatch(statements, 'batch');
        for (const s of statements) validateSql(s?.sql);
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const results = await runner.run(entry, 'batch', [statements]);
        scheduleFlush(id);
        return results;
    }

    /**
     * Apply an ordered list of DDL statements (a migration plan) inside ONE
     * transaction — all-or-nothing, so a half-applied schema change can never
     * be flushed. Each entry is a SQL string. Returns { applied: N }.
     * @returns {Promise<{ applied: number }>}
     */
    async function applyMigration(ownerId, id, orderedDDL) {
        if (!Array.isArray(orderedDDL)) {
            throw new Error('applyMigration requires an array of DDL strings');
        }
        if (orderedDDL.length === 0) return { applied: 0 };
        if (orderedDDL.length > MAX_BATCH_STATEMENTS) {
            throw new Error(`applyMigration supports at most ${MAX_BATCH_STATEMENTS} statements per call`);
        }
        for (const ddl of orderedDDL) validateSql(ddl);
        const entry = await getWriteHandle(ownerId, id);
        assertWritable(entry);
        const result = await runner.run(entry, 'applyMigration', [orderedDDL]);
        scheduleFlush(id);
        return result;
    }

    return { getWriteHandle, exec, batch, applyMigration };
}

module.exports = { createReadApi, createWriteApi, validateSql, normalizeParams, quoteIdent, STATEMENT_OPS, MAX_SQL_BYTES, MAX_RESULT_ROWS };
