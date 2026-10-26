// @typecheck strict
/**
 * stores/lib/ddlLedger.js — the store schemas in the same ledger as the
 * migrations (`schema_migrations`), so a changed DDL statement can never be
 * skipped on an existing installation, and an unchanged one is not sent again.
 *
 * WHY. Every store owns its schema in its init (makeStoreInit) and used to
 * send all of it on every boot: ~2000 statements, each an ALTER TABLE that
 * takes an ACCESS EXCLUSIVE lock even when the column is already there. Three
 * stores cut that cost with a hand-maintained probe ("is the NEWEST column
 * there yet?") that skipped the whole ladder when it answered yes, so a new
 * statement whose author forgot to move the probe never reached an existing
 * install. The ledger replaces those probes with something nobody maintains.
 *
 * THE UNIT is one store init: the schemaFn of makeStoreInit(tag, ...), entry
 * `store:<tag>` in schema_migrations. While it runs, an AsyncLocalStorage
 * context collects every schema statement the store sends through db.exec or
 * runDdl (stores/lib/_ddl.js).
 *
 * THE GRANULARITY is one statement, keyed by the sha256 of its exact text. A
 * statement is skipped only when it merely creates what is missing (below) and
 * that exact text already succeeded for this unit on this database, so:
 *   - a new or edited statement always runs (a different text, a different key);
 *   - a statement on a branch the init did not take before (an extension that
 *     appeared, a legacy column that was there) runs the first time it is reached;
 *   - a failed or tolerated statement is never recorded and runs again next boot.
 * A unit-level checksum over the file could not promise the second point.
 *
 * WHAT MAY BE SKIPPED: only "create it if it is missing" (isCreateIfMissing in
 * ddlStatements.js): CREATE TABLE / INDEX / SEQUENCE / EXTENSION / SCHEMA … IF
 * NOT EXISTS, and ALTER TABLE whose every clause is ADD COLUMN IF NOT EXISTS.
 * That is the bulk, and where the boot time went.
 *
 * WHAT ALWAYS RUNS. Every statement that makes something SO: CREATE OR REPLACE,
 * SET / DROP DEFAULT, ALTER COLUMN … TYPE, a constraint dropped and added,
 * COMMENT ON, RENAME, DROP, and every DO block (it may call anything). Those
 * are recorded but sent on every boot, as before the ledger, so an older
 * replica that put its own definition back during a rolling upgrade is
 * overruled on the next boot. Data statements (INSERT, UPDATE … SET, DELETE,
 * TRUNCATE, MERGE, COPY), temporary tables, a SELECT and code outside an init
 * (a request, a detached job after its init finished) are not touched at all.
 *
 * A LEDGER THAT LIES IS CAUGHT. Every recorded entry also stores the OID of
 * each relation its statements name (table, index, sequence, view; null for
 * one that is gone). When one of them is gone, is a different object now
 * (dropped, recreated, restored from a dump) or came back (a retired index an
 * older replica recreated), the whole unit runs again. What the ledger cannot
 * see is a column, constraint, default or function changed by hand, or by an
 * older replica that dropped one, on a table that is still the same: what is
 * skipped only ever creates, so nothing an older version changed in place
 * survives a boot. BEEFLOW_DDL_LEDGER=off or `db:migrate --force` runs every
 * statement again.
 *
 * FAIL-OPEN. The ledger only ever decides to SKIP, so every failure of its own
 * (no table yet, no connection, a db double without `ledgerQuery`) falls back
 * to running the whole init, which is what happened before it existed. It
 * never fails an init.
 *
 * FILES. ddlStatements.js reads a statement (key, schema-only, create-if-missing, relations);
 * ddlLedgerTable.js owns the table and reads and writes one unit's entry; this
 * module decides, per running init, what is skipped.
 *
 * DATA STEPS. A one-time backfill that used to hide behind a probe goes
 * through `once(name, version, fn)`: recorded in the same unit when fn
 * reports it finished, run again on the next boot when it did not.
 */

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { statementKey, isSchemaOnly, isCreateIfMissing, relationsIn } = require('./ddlStatements');
const { LEDGER_TABLE, ensureLedgerTable, loadUnit, recordUnit } = require('./ddlLedgerTable');

const UNIT_PREFIX = 'store:';

/** @typedef {import('./ddlLedgerTable').LedgerQuery} LedgerQuery */

/**
 * @typedef {Object} UnitContext
 * @property {string} unit             ledger name, `store:<tag>`
 * @property {Set<string>} recorded    statement keys this unit already applied on this database
 * @property {Map<string, string>} applied  key -> statement text, applied this run (executed or skipped)
 * @property {number} executed      statements new to this database
 * @property {number} reran         recorded, but of a kind that always runs
 * @property {number} skipped
 * @property {boolean} reshaped     a statement that ran may have dropped or renamed a relation
 * @property {boolean} closed          set when the init returned: later work passes straight through
 */

/** @type {AsyncLocalStorage<UnitContext>} */
const als = new AsyncLocalStorage();

const settings = {
    /** `db:migrate --force`: run every statement, record the result. */
    force: false,
};

/** Process totals, for the migration runner's summary line. */
const stats = { units: 0, unitsUnchanged: 0, executed: 0, reran: 0, skipped: 0 };

/** @param {unknown} e */
const _msg = (e) => (e instanceof Error ? e.message : String(e));

/** @param {Set<string>} a @param {Set<string>} b */
function _sameKeys(a, b) {
    if (a.size !== b.size) return false;
    for (const k of a) if (!b.has(k)) return false;
    return true;
}

/**
 * Run one store's schema init through the ledger. `query` is the db facade's
 * `ledgerQuery`; without one (a hermetic db double) the init simply runs.
 *
 * @template T
 * @param {string} tag
 * @param {() => T | Promise<T>} schemaFn
 * @param {LedgerQuery | undefined} query
 * @returns {Promise<T>}
 */
async function runUnit(tag, schemaFn, query) {
    if (typeof query !== 'function' || process.env.BEEFLOW_DDL_LEDGER === 'off') return schemaFn();
    /** @type {UnitContext} */
    const ctx = {
        unit: UNIT_PREFIX + tag, recorded: new Set(), applied: new Map(),
        executed: 0, reran: 0, skipped: 0, reshaped: false, closed: false,
    };
    if (!settings.force) {
        try {
            ctx.recorded = await loadUnit(query, ctx.unit);
        } catch (e) {
            log.warn(`[DdlLedger] ${ctx.unit}: ledger unreadable, the whole schema runs: ${_msg(e)}`);
        }
    }
    /** @type {T} */
    let result;
    try {
        result = await als.run(ctx, schemaFn);
    } finally {
        ctx.closed = true;
    }
    stats.units++;
    // Nothing new, and nothing that ran can have moved a relation's OID: the
    // entry is still exact, so no write.
    if (ctx.executed === 0 && !ctx.reshaped && _sameKeys(new Set(ctx.applied.keys()), ctx.recorded)) {
        stats.unitsUnchanged++;
        return result;
    }
    try {
        await recordUnit(query, ctx.unit, ctx.applied);
    } catch (e) {
        log.warn(`[DdlLedger] ${ctx.unit}: schema applied but not recorded (it runs again next boot): ${_msg(e)}`);
    }
    return result;
}

/** @type {Map<string, number>} */
const _inflight = new Map();

/** @typedef {'executed' | 'reran' | 'skipped'} Outcome executed: new here; reran: recorded but always runs */
/** @typedef {(event: { unit: string, outcome: Outcome, sql: string }) => void} Observer */
/** @type {Set<Observer>} */
const _observers = new Set();

/**
 * Watch every statement the ledger runs or skips (the integration test's
 * gate). Returns the unsubscribe.
 * @param {Observer} fn
 */
function observe(fn) {
    _observers.add(fn);
    return () => { _observers.delete(fn); };
}

/** @param {UnitContext} ctx @param {Outcome} outcome @param {string} sql */
function _emit(ctx, outcome, sql) {
    ctx[outcome]++;
    stats[outcome]++;
    if (outcome !== 'skipped' && /\b(?:DROP|RENAME)\b/i.test(sql)) ctx.reshaped = true;
    for (const fn of _observers) {
        // An observer never breaks an init.
        try { fn({ unit: ctx.unit, outcome, sql }); } catch (e) { bestEffort('stores/lib/ddlLedger:observer', e); }
    }
}

/**
 * Send one statement through the ledger: skipped when it only creates what is
 * missing and this unit already applied exactly this text, otherwise run by
 * `send` and recorded on success. Outside a running init, or for anything that
 * is not schema only, it is `send()` unchanged.
 *
 * @template R
 * @param {string} sql
 * @param {() => Promise<R>} send
 * @returns {Promise<R | { rows: never[], rowCount: 0, command: 'SKIPPED', fields: never[] }>}
 */
async function throughLedger(sql, send) {
    const ctx = als.getStore();
    if (!ctx || ctx.closed || !isSchemaOnly(sql)) return send();
    const key = statementKey(sql);
    const recorded = ctx.recorded.has(key);
    if (recorded && isCreateIfMissing(sql)) {
        ctx.applied.set(key, sql);
        _emit(ctx, 'skipped', sql);
        return { rows: [], rowCount: 0, command: 'SKIPPED', fields: [] };
    }
    _inflight.set(sql, (_inflight.get(sql) || 0) + 1);
    try {
        const res = await send();
        ctx.applied.set(key, sql);
        _emit(ctx, recorded ? 'reran' : 'executed', sql);
        return res;
    } finally {
        const n = (_inflight.get(sql) || 1) - 1;
        if (n > 0) _inflight.set(sql, n); else _inflight.delete(sql);
    }
}

/**
 * For runDdl, which sends a list inside one transaction: may this statement be
 * skipped (create-if-missing, already applied in the running unit)? Marks it
 * applied when it may.
 * @param {string} sql
 */
function alreadyApplied(sql) {
    const ctx = als.getStore();
    if (!ctx || ctx.closed || !isCreateIfMissing(sql)) return false;
    const key = statementKey(sql);
    if (!ctx.recorded.has(key)) return false;
    ctx.applied.set(key, sql);
    _emit(ctx, 'skipped', sql);
    return true;
}

/**
 * A one-time data step inside a store init (a backfill that used to hide
 * behind a probe). Skipped when this unit recorded `name` at `version`; run,
 * and recorded unless `fn` resolves to false (not finished: runs again next
 * boot). Outside an init it simply runs.
 *
 * @template R
 * @param {string} name
 * @param {string} version  the text the step depends on, usually its SQL
 * @param {() => Promise<R>} fn
 * @returns {Promise<R | undefined>}
 */
async function once(name, version, fn) {
    const ctx = als.getStore();
    if (!ctx || ctx.closed) return fn();
    const key = statementKey(`once:${name}\n${version}`);
    if (ctx.recorded.has(key)) {
        ctx.applied.set(key, `-- once: ${name}`);
        _emit(ctx, 'skipped', `-- once: ${name}`);
        return undefined;
    }
    const res = await fn();
    if (res !== false) {
        ctx.applied.set(key, `-- once: ${name}`);
        _emit(ctx, 'executed', `-- once: ${name}`);
    }
    return res;
}

/** `db:migrate --force`: every unit runs every statement again (and records it). */
/** @param {boolean} on */
function setForce(on) {
    settings.force = !!on;
}

/** The ledger unit of the init running here, or null. For the gate test. */
function currentUnit() {
    const ctx = als.getStore();
    return ctx && !ctx.closed ? ctx.unit : null;
}

/** Is this statement being sent by the ledger right now? For the gate test. */
/** @param {string} sql */
function isInflight(sql) {
    return _inflight.has(sql);
}

module.exports = {
    LEDGER_TABLE,
    UNIT_PREFIX,
    runUnit,
    throughLedger,
    alreadyApplied,
    once,
    ensureLedgerTable,
    setForce,
    stats,
    // ddlStatements.js, re-exported for the colocated test
    isSchemaOnly,
    isCreateIfMissing,
    statementKey,
    relationsIn,
    currentUnit,
    isInflight,
    observe,
};
