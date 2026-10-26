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
 * statement is skipped only when that exact text already succeeded for this
 * unit on this database, so:
 *   - a new or edited statement always runs (a different text, a different key);
 *   - a statement on a branch the init did not take before (an extension that
 *     appeared, a legacy column that was there) runs the first time it is reached;
 *   - a failed or tolerated statement is never recorded and runs again next boot.
 * A unit-level checksum over the file could not promise the second point.
 *
 * WHAT IS NEVER SKIPPED. Only statements that are schema and nothing else:
 * they start with CREATE / ALTER / DROP / COMMENT ON / DO and contain no data
 * statement (INSERT INTO, UPDATE … SET, DELETE FROM, TRUNCATE, MERGE, COPY).
 * A DO block that also fixes rows, a temporary table, a SELECT, a backfill:
 * those run exactly as before. Code outside an init (a request, a detached
 * job after its init finished) is never touched.
 *
 * A LEDGER THAT LIES IS CAUGHT. Every recorded entry also stores the OID of
 * each relation its statements name (table, index, sequence, view; null for
 * one that is gone). When one of them is gone, is a different object now
 * (dropped, recreated, restored from a dump) or came back (a retired index an
 * older replica recreated), the whole unit runs again. What the ledger cannot
 * see is a column, constraint, default or function changed by hand, or by an
 * older replica that still runs its own DDL during a rolling upgrade, on a
 * table that is still the same; BEEFLOW_DDL_LEDGER=off or `db:migrate --force`
 * runs every statement again.
 *
 * FAIL-OPEN. The ledger only ever decides to SKIP, so every failure of its own
 * (no table yet, no connection, a db double without `ledgerQuery`) falls back
 * to running the whole init, which is what happened before it existed. It
 * never fails an init.
 *
 * DATA STEPS. A one-time backfill that used to hide behind a probe goes
 * through `once(name, version, fn)`: recorded in the same unit when fn
 * reports it finished, run again on the next boot when it did not.
 */

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

const LEDGER_TABLE = 'schema_migrations';
const UNIT_PREFIX = 'store:';

/** @typedef {(sql: string, params?: unknown[]) => Promise<{ rows?: any[] } | undefined>} LedgerQuery */

/**
 * @typedef {Object} UnitContext
 * @property {string} unit             ledger name, `store:<tag>`
 * @property {Set<string>} recorded    statement keys this unit already applied on this database
 * @property {Map<string, string>} applied  key -> statement text, applied this run (executed or skipped)
 * @property {number} executed
 * @property {number} skipped
 * @property {boolean} closed          set when the init returned: later work passes straight through
 */

/** @type {AsyncLocalStorage<UnitContext>} */
const als = new AsyncLocalStorage();

const settings = {
    /** `db:migrate --force`: run every statement, record the result. */
    force: false,
};

/** Process totals, for the migration runner's summary line. */
const stats = { units: 0, unitsUnchanged: 0, executed: 0, skipped: 0 };

/** @param {string} sql */
function statementKey(sql) {
    return crypto.createHash('sha256').update(sql).digest('hex');
}

/** The statement without its leading whitespace and comments. */
/** @param {string} sql */
function _head(sql) {
    let s = sql;
    for (;;) {
        const t = s.replace(/^\s+/, '');
        if (t.startsWith('--')) { const nl = t.indexOf('\n'); s = nl < 0 ? '' : t.slice(nl + 1); continue; }
        if (t.startsWith('/*')) { const end = t.indexOf('*/'); s = end < 0 ? '' : t.slice(end + 2); continue; }
        return t;
    }
}

const SCHEMA_HEAD = /^(?:CREATE|ALTER|DROP|COMMENT\s+ON|DO)\b/i;
const TEMP_TABLE = /^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP|TEMPORARY)\b/i;
const DATA_STATEMENT = /\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?[\w."$]+(?:\s+(?:AS\s+)?\w+)?\s+SET|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|COPY\s)/i;

/**
 * True for a statement the ledger may skip once it succeeded: schema only.
 * @param {unknown} sql
 */
function isSchemaOnly(sql) {
    if (typeof sql !== 'string') return false;
    const head = _head(sql);
    return SCHEMA_HEAD.test(head) && !TEMP_TABLE.test(head) && !DATA_STATEMENT.test(sql);
}

const IDENT = '(?:"[^"]+"|[A-Za-z_][\\w$]*)(?:\\.(?:"[^"]+"|[A-Za-z_][\\w$]*))?';
const KIND = '(?:UNLOGGED\\s+)?(?:TABLE|INDEX|SEQUENCE|VIEW|MATERIALIZED\\s+VIEW)';
// Every relation a statement creates, changes, drops or renames to: tables,
// indexes, sequences and views, which is what to_regclass can answer for.
const RELATION_REFS = [
    new RegExp(`\\b(?:CREATE(?:\\s+OR\\s+REPLACE)?|ALTER|DROP)\\s+${KIND}\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})`, 'gi'),
    new RegExp(`\\bCREATE\\s+UNIQUE\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, 'gi'),
    new RegExp(`\\bINDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\s+)?ON\\s+(?:ONLY\\s+)?(${IDENT})`, 'gi'),
    new RegExp(`\\bRENAME\\s+TO\\s+(${IDENT})`, 'gi'),
];
const NOT_A_NAME = new Set(['if', 'only', 'on', 'exists', 'not', 'concurrently', 'using']);

/**
 * The relations these statements create, change, drop or rename to, as
 * written (to_regclass reads them). The ledger records the OID of each (null
 * for one that is gone), so a table that was dropped, recreated or restored,
 * or a retired index that came back, makes the whole unit run again.
 * @param {Iterable<string>} statements
 * @returns {string[]}
 */
function relationsIn(statements) {
    const out = new Set();
    for (const sql of statements) {
        for (const re of RELATION_REFS) {
            re.lastIndex = 0;
            for (const m of sql.matchAll(re)) {
                const name = m[1];
                if (!NOT_A_NAME.has(name.toLowerCase())) out.add(name);
            }
        }
    }
    return [...out].sort();
}

/** @param {unknown} e */
const _msg = (e) => (e instanceof Error ? e.message : String(e));

/** @type {Promise<void> | null} */
let _bootstrapping = null;

/**
 * Create the ledger table, or give an older one the two DDL columns. Shared
 * with boot/bootMigrations.js, which owns the same table for the migrations.
 * In-process concurrent callers share one attempt; it is not memoised beyond
 * that, so a test that swaps the database gets a table in the new one.
 *
 * @param {LedgerQuery} query
 */
function ensureLedgerTable(query) {
    if (!_bootstrapping) {
        _bootstrapping = (async () => {
            await query(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                checksum TEXT NOT NULL,
                ddl_statements TEXT[],
                ddl_tables JSONB
            )`);
            // A table from before the store schemas joined: ADD COLUMN takes a
            // lock even when the column exists, so only when one is missing.
            const have = await query(
                `SELECT count(*)::int AS n FROM pg_attribute
                  WHERE attrelid = to_regclass('${LEDGER_TABLE}')
                    AND attname IN ('ddl_statements', 'ddl_tables') AND NOT attisdropped`);
            if (Number(have?.rows?.[0]?.n) < 2) {
                await query(`ALTER TABLE ${LEDGER_TABLE}
                    ADD COLUMN IF NOT EXISTS ddl_statements TEXT[],
                    ADD COLUMN IF NOT EXISTS ddl_tables JSONB`);
            }
        })().finally(() => { _bootstrapping = null; });
    }
    return _bootstrapping;
}

/**
 * Make sure the ledger table (with its DDL columns) is there before a read or
 * write, with a query that cannot fail. That matters beyond tidiness: on a
 * database with one session (PGlite in the tests) a failing ledger query would
 * land inside another store's open runDdl transaction and abort it. Asked per
 * unit, not memoised: one catalog lookup is cheap, and a memo would be wrong
 * after a test swapped the database underneath the pool.
 *
 * @param {LedgerQuery} query
 */
async function _ensureReady(query) {
    const res = await query(
        `SELECT to_regclass('${LEDGER_TABLE}') IS NOT NULL AS t,
                (SELECT count(*)::int FROM pg_attribute
                  WHERE attrelid = to_regclass('${LEDGER_TABLE}')
                    AND attname IN ('ddl_statements', 'ddl_tables') AND NOT attisdropped) AS n`);
    const row = res?.rows?.[0];
    if (!row?.t || Number(row.n) < 2) await ensureLedgerTable(query);
}

/**
 * Run a ledger query once the table is known to be there.
 *
 * @param {LedgerQuery} query
 * @param {string} sql
 * @param {unknown[]} params
 */
async function _ledgerQuery(query, sql, params) {
    await _ensureReady(query);
    return query(sql, params);
}

const LOAD_SQL = `
    SELECT m.ddl_statements AS statements,
           NOT EXISTS (
               SELECT 1 FROM jsonb_each_text(COALESCE(m.ddl_tables, '{}'::jsonb)) t
                WHERE to_regclass(t.key)::oid::text IS DISTINCT FROM t.value
           ) AS intact
      FROM ${LEDGER_TABLE} m
     WHERE m.name = $1`;

/**
 * The statement keys recorded for `unit`, empty when there is no entry or
 * when one of its tables is no longer the table it recorded.
 *
 * @param {LedgerQuery} query
 * @param {string} unit
 * @returns {Promise<Set<string>>}
 */
async function _load(query, unit) {
    const res = await _ledgerQuery(query, LOAD_SQL, [unit]);
    const row = res?.rows?.[0];
    if (!row || !Array.isArray(row.statements)) return new Set();
    if (row.intact === false) {
        log.info(`[DdlLedger] ${unit}: a table it recorded was dropped or replaced since, so its whole schema runs again`);
        return new Set();
    }
    return new Set(row.statements.map(String));
}

const RECORD_SQL = `
    INSERT INTO ${LEDGER_TABLE} (name, checksum, applied_at, ddl_statements, ddl_tables)
    SELECT $1, $2, now(), $3::text[],
           COALESCE((SELECT jsonb_object_agg(t, to_regclass(t)::oid::text) FROM unnest($4::text[]) t), '{}'::jsonb)
    ON CONFLICT (name) DO UPDATE SET
        checksum = EXCLUDED.checksum, applied_at = now(),
        ddl_statements = EXCLUDED.ddl_statements, ddl_tables = EXCLUDED.ddl_tables`;

/**
 * @param {LedgerQuery} query
 * @param {UnitContext} ctx
 */
async function _record(query, ctx) {
    const keys = [...ctx.applied.keys()].sort();
    const checksum = statementKey(keys.join('\n'));
    const tables = relationsIn(ctx.applied.values());
    await _ledgerQuery(query, RECORD_SQL, [ctx.unit, checksum, keys, tables]);
}

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
        executed: 0, skipped: 0, closed: false,
    };
    if (!settings.force) {
        try {
            ctx.recorded = await _load(query, ctx.unit);
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
    if (ctx.executed === 0 && _sameKeys(new Set(ctx.applied.keys()), ctx.recorded)) {
        stats.unitsUnchanged++;
        return result;
    }
    try {
        await _record(query, ctx);
    } catch (e) {
        log.warn(`[DdlLedger] ${ctx.unit}: schema applied but not recorded (it runs again next boot): ${_msg(e)}`);
    }
    return result;
}

/** @type {Map<string, number>} */
const _inflight = new Map();

/** @typedef {(event: { unit: string, outcome: 'executed' | 'skipped', sql: string }) => void} Observer */
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

/** @param {UnitContext} ctx @param {'executed' | 'skipped'} outcome @param {string} sql */
function _emit(ctx, outcome, sql) {
    if (outcome === 'executed') { ctx.executed++; stats.executed++; } else { ctx.skipped++; stats.skipped++; }
    for (const fn of _observers) {
        // An observer never breaks an init.
        try { fn({ unit: ctx.unit, outcome, sql }); } catch (e) { bestEffort('stores/lib/ddlLedger:observer', e); }
    }
}

/**
 * Send one statement through the ledger: skipped when this unit already
 * applied exactly this text, otherwise run by `send` and recorded on success.
 * Outside a running init, or for anything that is not schema only, it is
 * `send()` unchanged.
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
    if (ctx.recorded.has(key)) {
        ctx.applied.set(key, sql);
        _emit(ctx, 'skipped', sql);
        return { rows: [], rowCount: 0, command: 'SKIPPED', fields: [] };
    }
    _inflight.set(sql, (_inflight.get(sql) || 0) + 1);
    try {
        const res = await send();
        ctx.applied.set(key, sql);
        _emit(ctx, 'executed', sql);
        return res;
    } finally {
        const n = (_inflight.get(sql) || 1) - 1;
        if (n > 0) _inflight.set(sql, n); else _inflight.delete(sql);
    }
}

/**
 * For runDdl, which sends a list inside one transaction: is this statement
 * already applied in the running unit? Marks it applied when it is.
 * @param {string} sql
 */
function alreadyApplied(sql) {
    const ctx = als.getStore();
    if (!ctx || ctx.closed || !isSchemaOnly(sql)) return false;
    const key = statementKey(sql);
    if (!ctx.recorded.has(key)) return false;
    ctx.applied.set(key, sql);
    _emit(ctx, 'skipped', sql);
    return true;
}

/**
 * For runDdl: `send` runs a statement that is not applied yet; it is recorded
 * when it resolves. A statement that is not schema only is sent unrecorded.
 *
 * @template R
 * @param {string} sql
 * @param {() => Promise<R>} send
 */
function track(sql, send) {
    return throughLedger(sql, send);
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
    track,
    once,
    ensureLedgerTable,
    setForce,
    stats,
    // pure helpers, exported for the colocated test
    isSchemaOnly,
    statementKey,
    relationsIn,
    currentUnit,
    isInflight,
    observe,
};
