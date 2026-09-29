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
//
// Anything else still throws — tolerance must never mask a genuinely broken
// plan. Skipped statements are logged.

// The exact shapes migrationPlan emits (identifiers are always double-quoted
// by qi(), so these parses are unambiguous).
const RENAME_TABLE_RE = /^ALTER TABLE\s+"((?:[^"]|"")+)"\s+RENAME TO\s+"((?:[^"]|"")+)"\s*;?\s*$/i;
const RENAME_COLUMN_RE = /^ALTER TABLE\s+"((?:[^"]|"")+)"\s+RENAME COLUMN\s+"((?:[^"]|"")+)"\s+TO\s+"((?:[^"]|"")+)"\s*;?\s*$/i;
const ADD_COLUMN_RE = /^ALTER TABLE\s+"(?:[^"]|"")+"\s+ADD COLUMN\s+/i;

function unquoteIdent(s) {
    return String(s).replace(/""/g, '"');
}

function tableExists(db, name) {
    const r = db.prepare(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
    return !!r;
}

function columnExists(db, tableName, colName) {
    try {
        return db.prepare(`PRAGMA table_info(${qi(tableName)})`).all().some(c => c.name === colName);
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
 * @param {import('better-sqlite3').Database} db  open handle
 * @param {string[]} orderedDDL                    migrationPlan output
 * @param {{ log?: { warn: Function } }} [opts]    logger (console by default)
 * @returns {{ applied: number, skipped: Array<{ sql: string, reason: string }> }}
 */
function applyPlanTolerantly(db, orderedDDL, { log = console } = {}) {
    const skipped = [];
    let applied = 0;
    const skip = (sql, reason) => {
        skipped.push({ sql, reason });
        if (log && typeof log.warn === 'function') {
            log.warn(`[DataModel] tolerant DDL skipped (${reason}): ${String(sql).replace(/\s+/g, ' ').slice(0, 200)}`);
        }
    };

    for (const ddl of (Array.isArray(orderedDDL) ? orderedDDL : [])) {
        if (typeof ddl !== 'string' || !ddl.trim()) {
            throw new Error('DDL statement must be a non-empty string');
        }
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

        try {
            // Migration DDL may itself be multi-statement (ddlForTable joins
            // CREATE TABLE + its unique indexes); db.exec handles both.
            db.exec(ddl);
            applied++;
        } catch (e) {
            // Exact already-applied signature: a replayed single-statement
            // ADD COLUMN (addColumnDdl always emits the ALTER on its own).
            if (ADD_COLUMN_RE.test(sql) && /duplicate column name/i.test((e && e.message) || '')) {
                skip(sql, 'column already added');
                continue;
            }
            throw e;
        }
    }
    return { applied, skipped };
}

module.exports = { applyPlanTolerantly };
