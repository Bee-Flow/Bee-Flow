/**
 * boot/storeSchemas.js — the server's one call to "create the store schemas".
 *
 * WHY THIS EXISTS. Requiring a store used to run DDL: every store ended with
 * `initDB().catch(...)` at module level, so `require('../stores/userStore')`
 * from a script, a test or a route file issued CREATE TABLE against whatever
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
 * THE CORE LIST ONLY. A platform module's own store schema is created when that
 * module is imported (modules/index.js awaits its initDB) and lazily on first
 * use otherwise — booting the server has never created tables for a module
 * nobody imported, and this call does not start doing so. The migration runner
 * still covers every module, imported or not; that is its job, not boot's.
 *
 * NOT AWAITED, for the same reason the module-level kick-offs never were: the
 * listener is already up, the inits are idempotent and serialized against each
 * other by _ddl.js and db.exec, and a slow or failing schema must not stall
 * boot. `npm run db:migrate` (migrateDb.js) is the awaiting, exit-code-carrying
 * path over the same list in storeModules.js.
 */

'use strict';

const path = require('path');
const log = require('../telemetry/log');
const { STORE_MODULES } = require('../storeModules');

const loadStore = (file) => require(path.join(__dirname, '..', file));

/**
 * Start every registered store's schema init, in registry order.
 *
 * @param {{log?: object, modules?: {name: string, file: string}[],
 *          load?: (file: string) => object}} [opts] - `modules` and `load` are
 *   the injection seam the colocated test uses; boot passes neither.
 * @returns {{started: string[], unverified: string[], failed: string[]}}
 *   `unverified` = registered but exposing no awaitable init; `failed` = threw
 *   synchronously on require. A rejected init is logged by the memo, counted
 *   here, and retried by the next caller.
 */
function startStoreSchemas({ log: logger = log, modules, load = loadStore } = {}) {
    const report = { started: [], unverified: [], failed: [] };
    for (const store of (modules || STORE_MODULES)) {
        try {
            const mod = load(store.file);
            const handle = (mod && typeof mod.initDB === 'function') ? mod.initDB()
                : (mod && mod.ready && typeof mod.ready.then === 'function') ? mod.ready
                    : null;
            if (!handle) { report.unverified.push(store.name); continue; }
            report.started.push(store.name);
            handle.catch(() => { /* storeInit already logged it; the first query retries */ });
        } catch (err) {
            report.failed.push(store.name);
            logger.error(`[StoreSchemas] ${store.name} could not be loaded: ${err.message}`);
        }
    }
    if (report.unverified.length > 0) {
        logger.warn(`[StoreSchemas] no awaitable init on: ${report.unverified.join(', ')} — their schema now waits for a first query`);
    }
    logger.info(`[StoreSchemas] ${report.started.length} store schemas started`);
    return report;
}

module.exports = { startStoreSchemas };
