/**
 * A webhook in 'header_token' mode at rest (stores/automationStore/webhooks.js,
 * migrations/automation-webhook-auth-mode-2026-11.js) against a real Postgres (PGlite): the
 * token is handed out once, the column holds only its sha256, sealed; the inbound route gets
 * the hash and no signing secret; rotation keeps the mode and the one before for the overlap;
 * a webhook created without a mode is 'hmac', as every existing row is.
 *
 * Run: cd server && node --test stores/automationStore/webhooks.headerToken.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { useWebhookStore } = require('../../testUtils/automationWebhookStore.testkit');

const { pg, webhooks } = useWebhookStore(`INSERT INTO automations (id, user_id, organization_id, title, definition_json) VALUES ('a1', 'u1', 'org-1', 'One', '{}')`);
const { createWebhook, getWebhook, getWebhooksForAutomation, rotateWebhookSecret } = webhooks;
const { isSealed } = require('../../migrations/automation-webhook-secret-sealed-2026-11');
const { decryptValue } = require('../configEncryption');
const { hashWebhookToken } = require('../../usecases/automation/webhookSignature');

const stored = async (id) => (await pg.query('SELECT secret, auth_mode FROM automation_webhooks WHERE id = $1', [id])).rows[0];
const listed = async (id) => (await getWebhooksForAutomation('a1')).find((w) => w.id === id);

test('a webhook without a mode is signed (hmac), exactly as before', async () => {
    const wh = await createWebhook('a1', null);
    assert.strictEqual(wh.authMode, 'hmac');
    assert.strictEqual((await stored(wh.id)).auth_mode, 'hmac');
    const read = await getWebhook(wh.id);
    assert.deepStrictEqual([read.authMode, read.secret, read.tokenHash], ['hmac', wh.secret, null]);
    assert.strictEqual((await listed(wh.id)).authMode, 'hmac');
});

test('a header token is returned once and stored only as its sha256, sealed', async () => {
    const wh = await createWebhook('a1', null, { authMode: 'header_token' });
    assert.strictEqual(wh.authMode, 'header_token');
    assert.match(wh.secret, /^[0-9a-f]{64}$/);
    const row = await stored(wh.id);
    assert.strictEqual(row.auth_mode, 'header_token');
    assert.ok(isSealed(row.secret), 'the column holds an envelope');
    assert.strictEqual(decryptValue(row.secret), hashWebhookToken(wh.secret), 'inside it the hash, never the token');
    assert.ok(!row.secret.includes(wh.secret));

    const read = await getWebhook(wh.id);
    assert.deepStrictEqual([read.authMode, read.secret, read.previousSecret, read.tokenHash, read.previousTokenHash],
        ['header_token', null, null, hashWebhookToken(wh.secret), null], 'no signing secret: a signature cannot verify');
    const row2 = await listed(wh.id);
    assert.strictEqual(row2.authMode, 'header_token');
    assert.ok(!JSON.stringify(row2).includes(wh.secret), 'the owner list never carries the token');
});

test('rotating a header token keeps the mode, and the one before verifies for the overlap', async () => {
    const wh = await createWebhook('a1', null, { authMode: 'header_token' });
    const rotated = await rotateWebhookSecret(wh.id, 'a1', { overlapSeconds: 600 });
    assert.strictEqual(rotated.authMode, 'header_token');
    assert.notStrictEqual(rotated.secret, wh.secret);
    const read = await getWebhook(wh.id);
    assert.deepStrictEqual([read.tokenHash, read.previousTokenHash], [hashWebhookToken(rotated.secret), hashWebhookToken(wh.secret)]);
    assert.strictEqual(read.previousSecret, null);

    const once = await rotateWebhookSecret(wh.id, 'a1', { overlapSeconds: 0 });
    const after = await getWebhook(wh.id);
    assert.deepStrictEqual([after.tokenHash, after.previousTokenHash], [hashWebhookToken(once.secret), null]);
});

test('an unknown mode is stored as hmac', async () => {
    const unknownMode = JSON.parse('"query_token"');
    const wh = await createWebhook('a1', null, { authMode: unknownMode });
    assert.strictEqual((await stored(wh.id)).auth_mode, 'hmac');
});
