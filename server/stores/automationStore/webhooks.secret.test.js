/**
 * The signing secret of an automation webhook at rest
 * (stores/automationStore/webhooks.js, migrations/automation-webhook-secret-sealed-2026-11.js)
 * against a real Postgres (PGlite): the column holds the sealed form, the owner
 * gets the secret once at create and at rotate, the inbound route reads it in
 * clear, and a value from before sealing keeps working and is sealed in place.
 *
 * Run: cd server && node --test stores/automationStore/webhooks.secret.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { useWebhookStore } = require('../../testUtils/automationWebhookStore.testkit');

const { pg, webhooks } = useWebhookStore(`
    INSERT INTO automations (id, user_id, organization_id, title, definition_json) VALUES ('a-org', 'u1', 'org-1', 'With org', '{}');
    INSERT INTO automations (id, user_id, title, definition_json) VALUES ('a-solo', 'u1', 'Without org', '{}');
`);
const { createWebhook, getWebhook, rotateWebhookSecret } = webhooks;
const { up, isSealed } = require('../../migrations/automation-webhook-secret-sealed-2026-11');
const { decryptValue } = require('../configEncryption');

const stored = async (id) => (await pg.query('SELECT secret FROM automation_webhooks WHERE id = $1', [id])).rows[0].secret;

test('a new webhook stores its secret sealed for the organisation and hands it out in clear once', async () => {
    const wh = await createWebhook('a-org', null);
    assert.match(wh.secret, /^[0-9a-f]{64}$/);
    const value = await stored(wh.id);
    assert.ok(isSealed(value), 'the column holds an envelope');
    assert.ok(!value.includes(wh.secret), 'never the secret itself');
    assert.strictEqual(JSON.parse(value).keyContext, 'org-1');
    assert.strictEqual((await getWebhook(wh.id)).secret, wh.secret, 'the inbound route reads the same secret');
});

test('an automation without an organisation seals in the default context', async () => {
    const wh = await createWebhook('a-solo', null);
    const value = await stored(wh.id);
    assert.ok(isSealed(value));
    assert.strictEqual(JSON.parse(value).keyContext, undefined);
    assert.strictEqual((await getWebhook(wh.id)).secret, wh.secret);
});

test('a rotated secret is stored sealed and returned once', async () => {
    const wh = await createWebhook('a-org', null);
    const rotated = await rotateWebhookSecret(wh.id, 'a-org');
    assert.notStrictEqual(rotated.secret, wh.secret);
    assert.ok(isSealed(await stored(wh.id)));
    assert.strictEqual((await getWebhook(wh.id)).secret, rotated.secret);
});

test('a value from before sealing is read as it is, then sealed in place, and reads the same', async () => {
    const plain = 'ab'.repeat(32);
    await pg.query(`INSERT INTO automation_webhooks (id, automation_id, secret) VALUES ('legacy-1', 'a-org', $1), ('legacy-2', 'a-solo', $1)`, [plain]);
    assert.strictEqual((await getWebhook('legacy-1')).secret, plain);

    assert.strictEqual(await up(), 2);
    for (const id of ['legacy-1', 'legacy-2']) {
        const value = await stored(id);
        assert.ok(isSealed(value), `${id} is sealed`);
        assert.strictEqual(decryptValue(value), plain);
        assert.strictEqual((await getWebhook(id)).secret, plain, 'a sender signs with the same secret as before');
    }
    assert.strictEqual(JSON.parse(await stored('legacy-1')).keyContext, 'org-1');
    assert.strictEqual(await up(), 0, 'a second pass finds nothing');
});

test('of two passes that read the same value one seals it; the other changes nothing', async () => {
    const plain = 'cd'.repeat(32);
    await pg.query(`INSERT INTO automation_webhooks (id, automation_id, secret) VALUES ('legacy-3', 'a-org', $1)`, [plain]);
    const db = require('../../db');
    const read = await db.getAll(`SELECT w.id, w.secret, a.organization_id FROM automation_webhooks w LEFT JOIN automations a ON a.id = w.automation_id WHERE w.id = 'legacy-3'`);
    // Both passes hold the plain value; the second writes only if the row still holds it.
    const pass = () => up({ getAll: async () => read });
    assert.strictEqual(await pass(), 1);
    const first = await stored('legacy-3');
    assert.strictEqual(await pass(), 0);
    assert.strictEqual(await stored('legacy-3'), first);
    assert.strictEqual((await getWebhook('legacy-3')).secret, plain);
});

test('a stored value that cannot be read verifies nothing', async () => {
    const wh = await createWebhook('a-org', null);
    const broken = JSON.stringify({ ...JSON.parse(await stored(wh.id)), data: '00' });
    await pg.query('UPDATE automation_webhooks SET secret = $1 WHERE id = $2', [broken, wh.id]);
    assert.strictEqual((await getWebhook(wh.id)).secret, null);
    const { checkWebhookSignature } = require('../../usecases/automation/webhookSignature');
    const crypto = require('crypto');
    const sig = 'sha256=' + crypto.createHmac('sha256', '').update('n\n{}').digest('hex');
    assert.deepStrictEqual(checkWebhookSignature({ secret: null, sigHeader: sig, nonce: 'n', body: {} }), { ok: false, reason: 'bad_signature' });
});

test('the sealing pass is registered exactly once, in the automationStore ladder', () => {
    const { MIGRATIONS } = require('./core');
    const { LOOSE_MIGRATIONS } = require('../../boot/bootMigrations');
    const name = 'automation-webhook-secret-sealed-2026-11';
    assert.strictEqual(MIGRATIONS.filter((m) => m === name).length, 1);
    assert.strictEqual(LOOSE_MIGRATIONS.filter((m) => m === name).length, 0);
    assert.ok(MIGRATIONS.indexOf('automation-multi-trigger-2026-07') < MIGRATIONS.indexOf(name));
});
