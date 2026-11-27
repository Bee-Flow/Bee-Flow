// @typecheck
/**
 * boot/storeSchemas.js — the server's one call to "create the store schemas".
 *
 * WHY THIS EXISTS. Requiring a store must not run DDL: were every store to end with
 * `initDB().catch(...)` at module level, `require('../stores/userStore')`
 * from a script, a test or a route file would issue CREATE TABLE against whatever
 * database that process happened to point at. Schema creation is a decision
 * the server makes at boot, not a side effect of reading a module.
 *
 * WHAT A MISSED init() MEANS — NOTHING. Every store function still opens with
 * `await initDB()`, and that init is the memo from stores/lib/storeInit.js, so
 * a store nobody started here creates its schema on its first query instead.
 * This function is therefore a WARM-UP, not a precondition: it exists so a
 * fresh install has its tables before the first request rather than during it.
 * That is what keeps the migration safe for the hundreds of tests that require
 * a store and call it without ever booting a server.
 *
 * THE MERGED LIST: storeModules.js collectStoreModules(), the core's stores and
 * those of every loaded first-party module (their compositions'
 * firstParty/<id>.stores.js), the same list `npm run db:migrate` awaits. A
 * module that is absent contributes no store, so its DDL does not run. A store
 * that a downloadable platform module declares in the catalog is created when
 * that module is imported (modules/moduleLifecycle.js awaits its initDB).
 *
 * CHEAP ON EVERY BOOT AFTER THE FIRST. Each init runs through the schema ledger
 * (stores/lib/ddlLedger.js, the same `schema_migrations` table as the boot
 * ladder), so a store whose statements all succeeded before costs a ledger
 * read and sends only its overwriting statements (DEFAULT, TYPE, constraints,
 * CREATE OR REPLACE, COMMENT, DO), never the create-if-missing bulk; a
 * statement that is new to this database runs. There is no hand-maintained
 * "is the newest column there yet" probe left to forget.
 *
 * NOT AWAITED, for the same reason the module-level kick-offs never were: the
 * listener is already up, the inits are idempotent and serialized against each
 * other by _ddl.js and db.exec, and a slow or failing schema must not stall
 * boot. `npm run db:migrate` (migrateDb.js) is the awaiting, exit-code-carrying
 * path over the same list in storeModules.js.
 *
 * The report does carry `settled`, a promise for the moment every started init
 * has ended (it never rejects). Nothing in boot waits on it; the readiness
 * probe does (utils/runtimeState.mts), so "ready" comes after the tables
 * while the listener and the liveness answer stay as early as they were.
 */

'use strict';

const log = require('../telemetry/log');
const { collectStoreModules } = require('../storeModules');
const { bestEffort } = require('../utils/bestEffort');

/**
 * A store row's file is a tree path ('./stores/x'), found in whichever root holds it.
 * @param {string} file
 */
const loadStore = (file) => require(require('../moduleRoots.cjs').treePath(file));

/**
 * Start every registered store's schema init, in registry order.
 *
 * @param {{log?: Pick<typeof log, 'info' | 'warn' | 'error'>, modules?: {name: string, file: string}[],
 *          load?: (file: string) => { initDB?: () => Promise<unknown>, ready?: Promise<unknown> } | null}} [opts] - `modules` and `load` are
 *   the injection seam the colocated test uses; boot passes neither.
 * @returns {{started: string[], unverified: string[], failed: string[], settled: Promise<{rejected: string[]}>}}
 *   `unverified` = registered but exposing no awaitable init; `failed` = threw
 *   synchronously on require. A rejected init is logged by the memo, counted
 *   here, and retried by the next caller. `settled` resolves once every started
 *   init has ended, with the names of the ones that rejected.
 */
function startStoreSchemas({ log: logger = log, modules, load = loadStore } = {}) {
    /** @type {{started: string[], unverified: string[], failed: string[]}} */
    const report = { started: [], unverified: [], failed: [] };
    /** @type {Promise<string | null>[]} the name of a store whose init rejected, null for one that succeeded */
    const outcomes = [];
    for (const store of (modules || collectStoreModules(logger))) {
        try {
            const mod = load(store.file);
            const handle = (mod && typeof mod.initDB === 'function') ? mod.initDB()
                : (mod && mod.ready && typeof mod.ready.then === 'function') ? mod.ready
                    : null;
            if (!handle) { report.unverified.push(store.name); continue; }
            report.started.push(store.name);
            outcomes.push(handle.then(() => null, (e) => {
                bestEffort('boot/storeSchemas:startStoreSchemas', e);
                return store.name;
            }));
        } catch (err) {
            report.failed.push(store.name);
            logger.error(`[StoreSchemas] ${store.name} could not be loaded: ${/** @type {Error} */ (err).message}`);
        }
    }
    if (report.unverified.length > 0) {
        logger.warn(`[StoreSchemas] no awaitable init on: ${report.unverified.join(', ')} — their schema now waits for a first query`);
    }
    logger.info(`[StoreSchemas] ${report.started.length} store schemas started`);
    const settled = Promise.all(outcomes).then((names) => ({ rejected: names.filter((name) => name !== null) }));
    return { ...report, settled };
}

module.exports = { startStoreSchemas };
