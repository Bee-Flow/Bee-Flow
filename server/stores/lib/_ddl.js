// @typecheck
/**
 * stores/lib/_ddl.js — loud, serialised boot DDL for stores.
 *
 * WHY. The store inits carried ~250 `try { await exec(...) }`
 * blocks with an empty catch and as a comment "column already exists". But such a catch swallows
 * EVERYTHING: the pool-wide statement_timeout of 30s (db.js), an aborted
 * lock wait, a broken connection — every error read as "already existed" and the
 * store reported itself healthy while the schema was half done. This helper runs
 * the same statements, but collects errors per statement in a loud
 * failures list instead of swallowing them.
 *
 * HOW IT WORKS (one transaction per call):
 *   1. `SELECT pg_advisory_xact_lock(hashtext('beeflow:ddl:<tag>'))` — the same idiom as
 *      configStore.mutateConfig: xact-scoped, released automatically
 *      on COMMIT/ROLLBACK, and serialises the DDL of THIS store across ALL
 *      replicas. (The in-process _schemaQueue in db.js covered only one process
 *      and moreover triggered only on the substrings CREATE TABLE/ALTER TABLE/
 *      CREATE INDEX — 'CREATE UNIQUE INDEX', 'DROP TABLE' and 'CREATE EXTENSION'
 *      slipped past it, the observed pg_class race.)
 *   2. `SET LOCAL lock_timeout = '15s'` — generous but finite. Boot DDL may wait
 *      a while behind a busy table, but a boot may never hang indefinitely
 *      behind someone else's lock; with lock_timeout the waiting
 *      statement fails earlier and with a clear error (55P03) instead of only
 *      at the 30s statement_timeout. SET LOCAL applies only within this
 *      transaction, so the pool-wide behaviour does not change.
 *   3. Each statement under a SAVEPOINT: one failing statement is rolled
 *      back and noted, the rest runs on and simply commits.
 *
 * ERROR SEMANTICS.
 *   - SQLSTATE error (the server answered; db.isSqlStateError): entry in
 *     `failures` + console.error, the rest of the list runs on.
 *   - Expected SQLSTATE (given per statement via `tolerate`): entry in
 *     `tolerated`, NO log. This is for statements where the old catch WAS the
 *     idempotency mechanism (e.g. ADD COLUMN without IF NOT EXISTS that counts on
 *     duplicate_column) — only exactly that code is silent, everything
 *     else stays loud.
 *   - Connection error (no SQLSTATE): the whole call rejects. The store init
 *     then fails and the promise memo retries on the next call —
 *     never start half-healthy on a dead connection.
 *
 * IN-PROCESS QUEUE. All runDdl calls in this process run one by one
 * (like db.js' _schemaQueue): boot DDL should not drain the pool, and
 * test environments with one connection (pglite behind the db.js mock of
 * migrateDb.integration.test.js) cannot handle two overlapping
 * BEGIN/SAVEPOINT series. Mutual exclusion BETWEEN processes comes
 * from the advisory lock and cannot be proven with pglite (one connection) —
 * that remains manual verification, see the colocated test.
 *
 * Relies exclusively on the db.js facade (withTransaction, isSqlStateError) —
 * no own Pool, no pg import — so that the pglite mock of the
 * integration tests covers everything. For DB-less stub facades (hermetic
 * store tests) it falls back to sequential exec statements: see _dbFacade.
 *
 * ── RUNBOOK RULE: CREATE INDEX CONCURRENTLY on volume tables ──────────────
 * A NEW index on a table that is already large does NOT belong in boot DDL: the
 * build holds the table (or breaks here on the 30s statement_timeout)
 * and every pod repeats the attempt on every boot. Such an index is set once
 * manually with `CREATE INDEX CONCURRENTLY` (outside a transaction, via the
 * runbook), and afterwards optionally written into the boot DDL as
 * `IF NOT EXISTS` so that fresh installations get it too — on an empty table
 * that build is free. This applies in any case to the tables without (or with
 * limited) retention that in practice become large:
 *   ai_usage_log, automation_runs, automation_run_steps, conversation_messages,
 *   cowork_runs, notifications, integration_activity_log, guardrail_events,
 *   ai_task_termination_log, azure_service_usage_log, access_audit_log,
 *   consent_acceptances, subscription_audit_log, support_messages,
 *   support_audit_log.
 * The boot indexes that already stand there date from before this rule (idempotent,
 * already exist on running installations); no new ones come in via boot.
 */

'use strict';
const log = require('../../telemetry/log');
const { alreadyApplied, throughLedger } = require('./ddlLedger');

/**
 * The db facade is resolved LAZILY and via two routes, so that runDdl sees under
 * ALL test patterns of this repo the same facade as the store that calls it:
 *   1. `require('../db')` — does not exist on disk (stores/db.js), but the hermetic
 *      store tests intercept exactly this request for files under stores/ with a DB-less
 *      stub (Module._resolveFilename hook).
 *   2. `require('../../db')` — the real db.js; also the path that
 *      migrateDb.integration.test.js replaces with pglite via require.cache.
 * A stub without withTransaction (the hermetic tests) gets the
 * SEQUENTIAL variant below: per statement via db.exec, without lock or
 * transaction — there is no database there, so nothing to serialise either. The
 * real db.js always exports withTransaction, so production always runs
 * the locked transaction variant.
 */
function _dbFacade() {
    try {
        // @ts-ignore -- resolves only where a hermetic test intercepts it; the fallback is the real module
        return require('../db');
    } catch (_) {
        return require('../../db');
    }
}

// Fallback-predicaat voor stubs die isSqlStateError niet exporteren.
function _isSqlStateErrorFallback(err) {
    return typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code);
}

// Veelgebruikte SQLSTATE-codes voor `tolerate` — met naam, zodat de bedoeling
// op de plek van gebruik leesbaar blijft.
const CODES = Object.freeze({
    DUPLICATE_COLUMN: '42701',   // ADD COLUMN zonder IF NOT EXISTS, kolom bestaat al
    DUPLICATE_TABLE: '42P07',    // relatie (tabel/index) bestaat al
    DUPLICATE_OBJECT: '42710',   // constraint/objectnaam bestaat al
    UNDEFINED_TABLE: '42P01',    // table does not exist (yet)
    UNDEFINED_COLUMN: '42703',   // column does not exist (yet)
    UNDEFINED_OBJECT: '42704',   // bv. operator class gin_trgm_ops zonder pg_trgm
    UNIQUE_VIOLATION: '23505',   // CREATE UNIQUE INDEX over bestaande duplicaten
    CHECK_VIOLATION: '23514',    // ADD CONSTRAINT ... CHECK over bestaande legacy-rijen
    FEATURE_NOT_SUPPORTED: '0A000', // bv. CREATE EXTENSION in een omgeving zonder die extensie
});

const DEFAULT_LOCK_TIMEOUT = '15s';
// Just a simple duration — the value is (after validation) interpolated literally into
// SET LOCAL, because SET does not accept bind parameters.
const LOCK_TIMEOUT_RE = /^\d+(ms|s|min)$/;
const LOCK_NS = 'beeflow:ddl:'; // eigen naamruimte naast configStore's kale sleutels

// Zelfde afkap-idee als db.js' _sanitizeSql: genoeg om het statement te
// herkennen, nooit hele DDL-lappen in de log.
function _prefix(sql) {
    return String(sql).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function _normalize(s) {
    if (typeof s === 'string') return { sql: s, tolerate: [] };
    if (s && typeof s.sql === 'string') {
        const tol = s.tolerate == null ? [] : (Array.isArray(s.tolerate) ? s.tolerate : [s.tolerate]);
        return { sql: s.sql, tolerate: tol, reden: s.reden };
    }
    throw new TypeError('runDdl: statement moet een SQL-string of { sql, tolerate?, reden? } zijn');
}

function _isTolerated(tolerate, err) {
    return tolerate.some((t) => (t instanceof RegExp ? t.test(err.message || '') : t === err.code));
}

async function _runLocked(tag, list, lockTimeout) {
    const db = _dbFacade();
    const isSqlStateError = typeof db.isSqlStateError === 'function' ? db.isSqlStateError : _isSqlStateErrorFallback;
    const failures = [];
    const tolerated = [];

    // Stub environment without withTransaction (hermetic store tests): run the
    // statements sequentially via exec with the same classification. No lock and
    // no savepoints — there is no real database there.
    if (typeof db.withTransaction !== 'function') {
        for (const stmt of list) {
            try {
                await throughLedger(stmt.sql, () => db.exec(stmt.sql));
            } catch (err) {
                if (!isSqlStateError(err)) throw err;
                const entry = {
                    sql: _prefix(stmt.sql),
                    code: err.code,
                    message: err.message,
                    ...(stmt.reden ? { reden: stmt.reden } : {}),
                };
                if (_isTolerated(stmt.tolerate, err)) tolerated.push(entry);
                else {
                    failures.push(entry);
                    log.error(`[DDL:${tag}] statement gefaald (SQLSTATE ${err.code}): ${entry.sql} — ${err.message}`);
                }
            }
        }
        if (failures.length > 0) {
            log.error(`[DDL:${tag}] ${failures.length} van ${list.length} statements gefaald — schema mogelijk incompleet, zie de regels hierboven`);
        }
        return { tag, failures, tolerated };
    }

    await db.withTransaction(async (client) => {
        // Serialises the same store across all replicas; xact-scoped, so
        // automatically released on COMMIT/ROLLBACK. The waiting time for this lock falls
        // under the pool-wide statement_timeout (30s) — a boot that hangs that long
        // behind another replica fails loudly and the memo retries.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_NS + tag]);
        await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
        for (const stmt of list) {
            await client.query('SAVEPOINT beeflow_ddl_stmt');
            try {
                await throughLedger(stmt.sql, () => client.query(stmt.sql));
                await client.query('RELEASE SAVEPOINT beeflow_ddl_stmt');
            } catch (err) {
                // No SQLSTATE = the server never answered (connection
                // gone, pool timeout). Then the transaction is also unusable:
                // fail hard, so that the store init sees this as a real error.
                if (!isSqlStateError(err)) throw err;
                await client.query('ROLLBACK TO SAVEPOINT beeflow_ddl_stmt');
                await client.query('RELEASE SAVEPOINT beeflow_ddl_stmt');
                const entry = {
                    sql: _prefix(stmt.sql),
                    code: err.code,
                    message: err.message,
                    ...(stmt.reden ? { reden: stmt.reden } : {}),
                };
                if (_isTolerated(stmt.tolerate, err)) {
                    tolerated.push(entry);
                } else {
                    failures.push(entry);
                    log.error(`[DDL:${tag}] statement gefaald (SQLSTATE ${err.code}): ${entry.sql} — ${err.message}`);
                }
            }
        }
    });
    if (failures.length > 0) {
        log.error(`[DDL:${tag}] ${failures.length} van ${list.length} statements gefaald — schema mogelijk incompleet, zie de regels hierboven`);
    }
    return { tag, failures, tolerated };
}

// Force serialisation within this process (see header). The chain itself never
// swallows an error: each call gets its own rejection back.
let _queue = Promise.resolve();

/**
 * Run a series of schema statements for one store, serialised and loud.
 *
 * @param {string} tag - store name for the lock AND the log lines (e.g. 'usageStore')
 * @param {(string|{sql: string, tolerate?: (string|RegExp)|Array<string|RegExp>, reden?: string})[]} statements
 *        SQL strings, or objects with expected SQLSTATE codes (see CODES) /
 *        message RegExps in `tolerate` and a short `reden` for in the report.
 * @param {{ lockTimeout?: string }} [opts] - e.g. { lockTimeout: '30s' }; default 15s.
 * @returns {Promise<{ tag: string, failures: Array<{sql,code,message,reden?}>, tolerated: Array<{sql,code,message,reden?}> }>}
 *          Rejects ONLY on connection errors (or a failed lock/commit) —
 *          SQLSTATE errors come back as entries and are then already logged.
 */
function runDdl(tag, statements, opts = {}) {
    if (typeof tag !== 'string' || tag.trim() === '') {
        throw new TypeError('runDdl: tag moet een niet-lege string zijn');
    }
    // Inside a store init, a statement that already succeeded for that store on
    // this database is dropped here (stores/lib/ddlLedger.js), and a list of
    // nothing but those costs no lock and no transaction at all.
    const list = (Array.isArray(statements) ? statements : [statements]).map(_normalize)
        .filter((stmt) => !alreadyApplied(stmt.sql));
    const lockTimeout = opts.lockTimeout || DEFAULT_LOCK_TIMEOUT;
    if (!LOCK_TIMEOUT_RE.test(lockTimeout)) {
        throw new TypeError(`runDdl: ongeldige lockTimeout '${lockTimeout}' (verwacht bv. '500ms', '15s', '1min')`);
    }
    if (list.length === 0) return Promise.resolve({ tag, failures: [], tolerated: [] });
    const run = _queue.then(
        () => _runLocked(tag, list, lockTimeout),
        () => _runLocked(tag, list, lockTimeout)
    );
    _queue = run.then(() => undefined, () => undefined);
    return run;
}

module.exports = { runDdl, CODES, DEFAULT_LOCK_TIMEOUT };

/** @typedef {{ sql: string, code: string, message: string, reden?: string }} DdlEntry */
