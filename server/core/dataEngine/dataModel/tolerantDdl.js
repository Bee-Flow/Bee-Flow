// @typecheck strict
/**
 * App Studio data model — tolerant DDL execution (the reconcile path): replay a
 * migration plan against SQLite, skipping only the exact already-applied
 * signatures.
 */

'use strict';

const { qi } = require('./ddl');

// ---------------------------------------------------------------------------
// Tolerant DDL execution (the reconcile path)
// ---------------------------------------------------------------------------
//
// saveDataModel applies a migration plan to SQLite BEFORE committing the new
// model to Postgres. If the PG COMMIT then fails, the SQLite schema (and its
// PRAGMA user_version stamp) sits one step AHEAD of the persisted model, so a
// retried save replays a plan whose statements are already applied.
// applyPlanTolerantly executes a plan skipping ONLY the exact "already
// applied" signatures:
//
//   • CREATE TABLE / CREATE (UNIQUE) INDEX and DROP INDEX / DROP TABLE are
//     already emitted by migrationPlan with IF (NOT) EXISTS — natively
//     idempotent, nothing to do here.
//   • ALTER TABLE … ADD COLUMN failing with "duplicate column name" → skipped.
//   • ALTER TABLE … RENAME TO / RENAME COLUMN whose target name already
//     exists AND whose source is gone → no-op'd without executing.
//   • ALTER TABLE … DROP COLUMN of a column that is already gone from a table
//     that exists → no-op'd without executing (a stored-computed rename drops
//     the OLD key; pg emits DROP COLUMN IF EXISTS for the same reason).
//
// Anything else still throws — tolerance must never mask a genuinely broken
// plan. Skipped statements are logged.

// The exact shapes migrationPlan emits (identifiers are always double-quoted
// by qi(), so these parses are unambiguous).
const RENAME_TABLE_RE = /^ALTER TABLE\s+"((?:[^"]|"")+)"\s+RENAME TO\s+"((?:[^"]|"")+)"\s*;?\s*$/i;
const RENAME_COLUMN_RE = /^ALTER TABLE\s+"((?:[^"]|"")+)"\s+RENAME COLUMN\s+"((?:[^"]|"")+)"\s+TO\s+"((?:[^"]|"")+)"\s*;?\s*$/i;
const ADD_COLUMN_RE = /^ALTER TABLE\s+"(?:[^"]|"")+"\s+ADD COLUMN\s+/i;
const DROP_COLUMN_RE = /^ALTER TABLE\s+"((?:[^"]|"")+)"\s+DROP COLUMN\s+"((?:[^"]|"")+)"\s*;?\s*$/i;

/**
 * @param {string} s
 */
function unquoteIdent(s) {
    return String(s).replace(/""/g, '"');
}

/**
 * @param {{ prepare: (sql: string) => { get: (...params: unknown[]) => unknown } }} db
 * @param {string} name
 */
function tableExists(db, name) {
    const r = db.prepare(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    return !!r;
}

/**
 * @param {{ prepare: (sql: string) => { all: () => Array<{ name: string }> } }} db
 * @param {string} tableName
 * @param {string} colName
 */
function columnExists(db, tableName, colName) {
    try {
        // table_xinfo, not table_info: table_info hides generated (computed) columns.
        return db.prepare(`PRAGMA table_xinfo(${qi(tableName)})`).all().some(c => c.name === colName);
    } catch (_) {
        return false;
    }
}

/**
 * Execute an ordered DDL plan against a better-sqlite3 handle, skipping the
 * exact already-applied signatures documented above. Synchronous — the caller
 * (studioAppDbStore.applyMigration) wraps it in ONE transaction so the
 * all-or-nothing guarantee is unchanged.
 *
 * `opts.probes` (planMigration's) are COUNT queries run right before the
 * statement they name; their counts come back in `probed`. A refusing probe
 * that counts an unconvertible value fails the plan AFTER every probe ran
 * (code 'migration_precondition', `probed` on the error), so the caller's
 * transaction rolls back and the refusal can name every conversion. A failing
 * statement carries its plan index (`migrationStatementIndex`).
 *
 * @param {InstanceType<typeof import('better-sqlite3')>} db  open handle
 * @param {string[]} orderedDDL                    migrationPlan output
 * @param {{ log?: { warn: Function }, probes?: MigrationProbe[] }} [opts]    logger (console by default)
 * @returns {{ applied: number, skipped: Array<{ sql: string, reason: string }>, probed: ProbeCount[] }}
 */
function applyPlanTolerantly(db, orderedDDL, { log = console, probes = [] } = {}) {
    /** @type {{ sql: string; reason: string; }[]} */
    const skipped = [];
    let applied = 0;
    /** @type {ProbeCount[]} */
    const probed = [];
    const list = Array.isArray(orderedDDL) ? orderedDDL : [];
    /** @param {number} at */
    const runProbes = (at) => {
        for (const pr of probes) {
            if (pr.at !== at) continue;
            /** @type {{ n?: unknown, bad?: unknown } | undefined} */
            let row;
            try {
                row = /** @type {{ n?: unknown, bad?: unknown } | undefined} */ (db.prepare(pr.sql).get());
            } catch (e) {
                // A failing probe belongs to its op: the caller reports it as that op's failure.
                if (e && typeof e === 'object') /** @type {{ migrationOpIndex?: number }} */ (e).migrationOpIndex = pr.opIndex;
                throw e;
            }
            probed.push({ opIndex: pr.opIndex, refuse: pr.refuse === true, n: Number(row?.n) || 0, bad: Number(row?.bad) || 0 });
        }
    };
    /**
     * @param {string} sql
     * @param {string} reason
     */
    const skip = (sql, reason) => {
        skipped.push({ sql, reason });
        if (log && typeof log.warn === 'function') {
            log.warn(`[DataModel] tolerant DDL skipped (${reason}): ${String(sql).replace(/\s+/g, ' ').slice(0, 200)}`);
        }
    };

    for (const [i, ddl] of list.entries()) {
        if (typeof ddl !== 'string' || !ddl.trim()) {
            throw new Error('DDL statement must be a non-empty string');
        }
        runProbes(i);
        const sql = ddl.trim();

        // Rename no-ops are detected BEFORE execution — running them would
        // throw "no such table/column", and the target-present + source-gone
        // combination proves the rename already happened.
        const rt = sql.match(RENAME_TABLE_RE);
        if (rt) {
            const from = unquoteIdent(rt[1]);
            const to = unquoteIdent(rt[2]);
            if (from !== to && !tableExists(db, from) && tableExists(db, to)) {
                skip(sql, 'table already renamed');
                continue;
            }
        }
        const rc = rt ? null : sql.match(RENAME_COLUMN_RE);
        if (rc) {
            const tbl = unquoteIdent(rc[1]);
            const from = unquoteIdent(rc[2]);
            const to = unquoteIdent(rc[3]);
            if (from !== to && tableExists(db, tbl) && !columnExists(db, tbl, from) && columnExists(db, tbl, to)) {
                skip(sql, 'column already renamed');
                continue;
            }
        }
        const dc = (rt || rc) ? null : sql.match(DROP_COLUMN_RE);
        if (dc) {
            const tbl = unquoteIdent(dc[1]);
            if (tableExists(db, tbl) && !columnExists(db, tbl, unquoteIdent(dc[2]))) {
                skip(sql, 'column already dropped');
                continue;
            }
        }

        try {
            // Migration DDL may itself be multi-statement (ddlForTable joins
            // CREATE TABLE + its unique indexes); db.exec handles both.
            db.exec(ddl);
            applied++;
        } catch (e) {
            // Exact already-applied signature: a replayed single-statement
            // ADD COLUMN (addColumnDdl always emits the ALTER on its own).
            if (ADD_COLUMN_RE.test(sql) && /duplicate column name/i.test((e && /** @type {Error} */ (e).message) || '')) {
                skip(sql, 'column already added');
                continue;
            }
            if (e && typeof e === 'object') /** @type {{ migrationStatementIndex?: number }} */ (e).migrationStatementIndex = i;
            throw e;
        }
    }
    runProbes(list.length);
    throwIfRefused(probed);
    return { applied, skipped, probed };
}

/**
 * The refusal of a plan whose refusing probes counted unconvertible values
 * (shared by the SQLite and Postgres engines).
 * @param {ProbeCount[]} probed
 */
function throwIfRefused(probed) {
    if (!probed.some((p) => p.refuse && p.bad > 0)) return;
    /** @type {Error & { code?: string, probed?: ProbeCount[] }} */
    const err = new Error('A field type conversion found values that cannot be converted');
    err.code = 'migration_precondition';
    err.probed = probed;
    throw err;
}

module.exports = { applyPlanTolerantly, throwIfRefused };

/**
 * @typedef {{ sql: string, at: number, opIndex: number, refuse?: boolean, tableKey?: string }} MigrationProbe
 * @typedef {{ opIndex: number, refuse: boolean, n: number, bad: number }} ProbeCount
 */
