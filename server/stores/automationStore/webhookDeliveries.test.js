/**
 * The delivery log of automation webhooks (stores/automationStore/webhookDeliveries.js,
 * migrations/automation-webhook-deliveries-2026-11.js) against a real Postgres (PGlite):
 * what a row holds, the newest per webhook for the owner, pruning by count and by age, and
 * that rows go with their webhook.
 *
 * Run: cd server && node --test stores/automationStore/webhookDeliveries.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('../automationStore');

let hookA;
let hookB;
const count = async (id) => Number((await pg.query('SELECT COUNT(*) AS n FROM automation_webhook_deliveries WHERE webhook_id = $1', [id])).rows[0].n);
/** Log `n` deliveries, each a second after the one before. */
async function logMany(webhookId, n, options) {
    for (let i = 0; i < n; i++) {
        const id = await store.logWebhookDelivery({ webhookId, status: 'accepted', bodyBytes: i, bodySha256: 'ab'.repeat(32) }, options);
        await pg.query(`UPDATE automation_webhook_deliveries SET received_at = NOW() - INTERVAL '1 hour' + ($2::int * INTERVAL '1 second') WHERE id = $1`, [id, i]);
    }
}

before(async () => {
    await store.initDB();
    await pg.exec(`INSERT INTO automations (id, user_id, title, definition_json) VALUES ('a1', 'u1', 'One', '{}')`);
    hookA = (await store.createWebhook('a1', null)).id;
    hookB = (await store.createWebhook('a1', null)).id;
});
after(close);
beforeEach(() => pg.exec('DELETE FROM automation_webhook_deliveries'));

test('a row holds what became of the delivery, a size, a hash and a time: the table has no column for more', async () => {
    await store.logWebhookDelivery({ webhookId: hookA, status: 'bad_signature', bodyBytes: 42 });
    await store.logWebhookDelivery({ webhookId: hookA, status: 'accepted', bodyBytes: 17, bodySha256: 'cd'.repeat(32) });
    const { rows } = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'automation_webhook_deliveries' ORDER BY column_name`);
    assert.deepStrictEqual(rows.map((r) => r.column_name), ['body_bytes', 'body_sha256', 'id', 'received_at', 'status', 'webhook_id']);

    const log = await store.recentWebhookDeliveries([hookA, hookB], 20);
    assert.deepStrictEqual(log[hookB], []);
    assert.deepStrictEqual(log[hookA].map((d) => [d.status, d.bodyBytes, d.bodyHash]).sort(), [['accepted', 17, 'cd'.repeat(32)], ['bad_signature', 42, null]]);
    assert.ok(log[hookA].every((d) => d.id.startsWith('awd_') && !Number.isNaN(Date.parse(d.receivedAt))));
});

test('the owner reads the newest of each webhook, newest first', async () => {
    await logMany(hookA, 5, { keep: 0 });
    await logMany(hookB, 2, { keep: 0 });
    const log = await store.recentWebhookDeliveries([hookA, hookB], 3);
    assert.deepStrictEqual(log[hookA].map((d) => d.bodyBytes), [4, 3, 2]);
    assert.deepStrictEqual(log[hookB].map((d) => d.bodyBytes), [1, 0]);
    assert.deepStrictEqual(await store.recentWebhookDeliveries([], 3), {});
});

test('a webhook keeps its newest deliveries up to the ceiling; 0 keeps all', async () => {
    await logMany(hookA, 6, { keep: 4 });
    assert.strictEqual(await count(hookA), 4);
    assert.deepStrictEqual((await store.recentWebhookDeliveries([hookA], 20))[hookA].map((d) => d.bodyBytes), [5, 4, 3, 2]);
    await logMany(hookB, 6, { keep: 0 });
    assert.strictEqual(await count(hookB), 6, 'another webhook is not pruned by the first one\'s ceiling');
});

test('the retention pass deletes deliveries older than the retention; 0 keeps them', async () => {
    await logMany(hookA, 3, { keep: 0 });
    await pg.query(`UPDATE automation_webhook_deliveries SET received_at = NOW() - INTERVAL '40 days' WHERE body_bytes < 2`);
    assert.strictEqual(await store.pruneAutomationWebhookDeliveries({ AUTOMATION_WEBHOOK_DELIVERY_RETENTION_DAYS: '0' }), 0);
    assert.strictEqual(await count(hookA), 3);
    assert.strictEqual(await store.pruneAutomationWebhookDeliveries({}), 2, '30 days when unset');
    assert.strictEqual(await count(hookA), 1);
});

test('the deliveries of a webhook go with it', async () => {
    const gone = (await store.createWebhook('a1', null)).id;
    await logMany(gone, 2, { keep: 0 });
    await store.deleteWebhook(gone, 'a1');
    assert.strictEqual(await count(gone), 0);
});

test('the table is registered exactly once, in the automationStore ladder', () => {
    const { MIGRATIONS } = require('./core');
    const { LOOSE_MIGRATIONS } = require('../../boot/bootMigrations');
    const name = 'automation-webhook-deliveries-2026-11';
    assert.strictEqual(MIGRATIONS.filter((m) => m === name).length, 1);
    assert.strictEqual(LOOSE_MIGRATIONS.filter((m) => m === name).length, 0);
});
