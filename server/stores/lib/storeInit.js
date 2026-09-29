// @typecheck
/**
 * stores/lib/storeInit.js — makeStoreInit: the one schema-init memo.
 *
 * WHY HERE AND NOT IN db.js. Fifty stores carried a byte-identical copy of the
 * memo ("have I created my tables yet"), so it had to become one helper. It is
 * pure promise memoization plus a log line — it never touches the pool — and
 * the hermetic store tests replace `../db` with four-function doubles that do
 * not carry it. Living next to _ddl.js, which resolves the facade the same way
 * for the same reason, keeps those doubles working untouched. `db.js` still
 * exports `makeStoreInit`; it re-exports this one.
 *
 * INVARIANT. `ensureInit()` runs `schemaFn` exactly once, however many callers
 * await it concurrently. On failure it clears the memo so the next call
 * retries: a store must never serve queries against a half-created schema, and
 * a boot that lost the database must be able to recover without a restart.
 *
 * LAZY BY DESIGN, and that is load-bearing. Schema creation no longer happens
 * when a store module is required — boot/storeSchemas.js starts it explicitly
 * — so `ensureInit()` is also the safety net: every store function opens with
 * `await initDB()`, and a store whose init nobody started creates its schema on
 * its first query instead. Tests, scripts and one-off tools therefore keep
 * working exactly as before without booting a server, and the boot call is a
 * warm-up rather than a precondition.
 *
 * THE SEAM. A db facade that exports its own `makeStoreInit` OWNS the memo and
 * gets it back verbatim — that is how a test neutralises schema creation
 * (`makeStoreInit: () => async () => {}`). The identity check is what keeps the
 * real db.js, which re-exports this very function, from recursing into itself.
 */

'use strict';
const log = require('../../telemetry/log');

// Resolved lazily and by two routes, exactly as _ddl.js does: '../db' is the
// request the hermetic store tests intercept, '../../db' is the real module.
function _dbFacade() {
    try {
        // @ts-ignore -- resolves only where a hermetic test intercepts it; the fallback is the real module
        return require('../db');
    } catch (_) {
        return require('../../db');
    }
}

function _memoized(tag, schemaFn) {
    let promise = null;
    return function ensureInit() {
        if (!promise) {
            promise = Promise.resolve().then(schemaFn).catch((err) => {
                promise = null;   // allow retry on the next call
                log.error(`[${tag}] Init error:`, err && err.message);
                throw err;
            });
        }
        return promise;
    };
}

/**
 * Build a memoized schema-init function for a store.
 * @param {string} tag - store name for error logs (e.g. 'FeedbackStore')
 * @param {() => Promise<void>} schemaFn - runs the CREATE TABLE / index DDL
 * @returns {() => Promise<void>} ensureInit
 */
function makeStoreInit(tag, schemaFn) {
    const db = _dbFacade();
    if (typeof db.makeStoreInit === 'function' && db.makeStoreInit !== makeStoreInit) {
        return db.makeStoreInit(tag, schemaFn);
    }
    return _memoized(tag, schemaFn);
}

module.exports = { makeStoreInit };
