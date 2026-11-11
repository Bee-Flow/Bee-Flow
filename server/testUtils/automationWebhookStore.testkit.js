// @typecheck
'use strict';

/**
 * The automation webhook store (stores/automationStore/webhooks.js) against a real Postgres
 * (PGlite), for its tests: the master key the sealed secret needs, the real db.js pool answered
 * by PGlite (the store runs its own migrations), the store's schema with the given automations
 * in it before the first test, and the pool closed after the last.
 *
 *   const { pg, webhooks } = useWebhookStore(`INSERT INTO automations (...) VALUES (...)`);
 */

const { before, after } = require('node:test');
const { usePglitePool } = require('./pglitePool');

process.env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';

/** @param {string} seedSql  the automations rows the tests hang their webhooks on */
function useWebhookStore(seedSql) {
    const { pg, close } = usePglitePool();
    before(async () => {
        await require('../stores/automationStore/core').initDB();
        await pg.exec(seedSql);
    });
    after(close);
    return { pg, webhooks: require('../stores/automationStore/webhooks') };
}

module.exports = { useWebhookStore };
