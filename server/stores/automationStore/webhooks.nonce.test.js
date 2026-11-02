/**
 * Webhook nonces (stores/automationStore/webhooks.js checkAndStoreNonce)
 * against a real Postgres (PGlite): ordinary nonces are swept after 24 h; a
 * retained nonce (a delivery signed without a timestamp, which never expires
 * on its own) outlives the sweep, so the same request cannot be sent again
 * a day later.
 *
 * Run: cd server && node --test stores/automationStore/webhooks.nonce.test.js
 */

'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

// The real db.js pool, answered by PGlite: the store runs its own migrations.
const { pg, close } = usePglitePool();
const { checkAndStoreNonce } = require('./webhooks');

before(async () => {
    await require('./core').initDB();
});
after(close);

afterEach(async () => {
    delete process.env.WEBHOOK_UNTIMED_NONCE_RETENTION_DAYS;
    await pg.exec('DELETE FROM automation_webhook_seen_nonces');
});

const ageAll = (interval) => pg.exec(`UPDATE automation_webhook_seen_nonces SET seen_at = NOW() - INTERVAL '${interval}'`);

test('an ordinary nonce is refused twice, then swept after 24 h', async () => {
    assert.strictEqual(await checkAndStoreNonce('hook:n1'), true);
    assert.strictEqual(await checkAndStoreNonce('hook:n1'), false);
    await ageAll('25 hours');
    assert.strictEqual(await checkAndStoreNonce('hook:n1'), true, 'a timestamped request is long expired by then');
});

test('a retained nonce is still refused after the 24 h sweep', async () => {
    assert.strictEqual(await checkAndStoreNonce('hook:n2', { retain: true }), true);
    assert.strictEqual(await checkAndStoreNonce('hook:n2', { retain: true }), false);
    await ageAll('40 days');
    await checkAndStoreNonce('hook:other'); // runs the sweep
    assert.strictEqual(await checkAndStoreNonce('hook:n2', { retain: true }), false);
});

test('a nonce stored the old way (no prefix) is still a replay for a retained check', async () => {
    assert.strictEqual(await checkAndStoreNonce('hook:n3'), true);
    assert.strictEqual(await checkAndStoreNonce('hook:n3', { retain: true }), false);
});

test('WEBHOOK_UNTIMED_NONCE_RETENTION_DAYS bounds how long a retained nonce is kept', async () => {
    process.env.WEBHOOK_UNTIMED_NONCE_RETENTION_DAYS = '30';
    assert.strictEqual(await checkAndStoreNonce('hook:n4', { retain: true }), true);
    await ageAll('10 days');
    assert.strictEqual(await checkAndStoreNonce('hook:n4', { retain: true }), false);
    await ageAll('31 days');
    assert.strictEqual(await checkAndStoreNonce('hook:n4', { retain: true }), true);
});
