/**
 * Rotating the secret of an automation webhook (stores/automationStore/webhooks.js
 * rotateWebhookSecret, migrations/automation-webhook-rotation-2026-11.js) against a real
 * Postgres (PGlite): the new secret verifies at once, the one before it for the overlap and
 * not a moment longer, and with an overlap of 0 it stops at once.
 *
 * Run: cd server && node --test stores/automationStore/webhooks.rotation.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { useWebhookStore } = require('../../testUtils/automationWebhookStore.testkit');

const { pg, webhooks } = useWebhookStore(`INSERT INTO automations (id, user_id, organization_id, title, definition_json) VALUES ('a1', 'u1', 'org-1', 'One', '{}')`);
const { createWebhook, getWebhook, getWebhooksForAutomation, rotateWebhookSecret } = webhooks;
const { up } = require('../../migrations/automation-webhook-rotation-2026-11');
const { isSealed } = require('../../migrations/automation-webhook-secret-sealed-2026-11');

const row = async (id) => (await pg.query('SELECT secret, prev_secret, prev_valid_until FROM automation_webhooks WHERE id = $1', [id])).rows[0];
const listed = async (id) => (await getWebhooksForAutomation('a1')).find((w) => w.id === id);
const endOverlap = (id) => pg.query(`UPDATE automation_webhooks SET prev_valid_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [id]);

test('a webhook that was never rotated has no previous secret', async () => {
    const wh = await createWebhook('a1', null);
    assert.strictEqual((await getWebhook(wh.id)).previousSecret, null);
    assert.strictEqual((await listed(wh.id)).previousValidUntil, null);
});

test('after a rotation the new secret and, for the overlap, the one before both verify', async () => {
    const wh = await createWebhook('a1', null);
    const rotated = await rotateWebhookSecret(wh.id, 'a1', { overlapSeconds: 600 });
    assert.notStrictEqual(rotated.secret, wh.secret);
    const until = Date.parse(rotated.previousValidUntil);
    assert.ok(Math.abs(until - (Date.now() + 600_000)) < 60_000, 'the overlap ends about ten minutes from now');

    const read = await getWebhook(wh.id);
    assert.deepStrictEqual([read.secret, read.previousSecret], [rotated.secret, wh.secret]);
    assert.strictEqual((await listed(wh.id)).previousValidUntil, rotated.previousValidUntil);

    const stored = await row(wh.id);
    assert.ok(isSealed(stored.secret) && isSealed(stored.prev_secret), 'both are stored sealed');
    assert.ok(!JSON.stringify(await listed(wh.id)).includes(wh.secret), 'the owner list never carries a secret');
});

test('when the overlap has ended the previous secret no longer verifies, and the next boot clears it', async () => {
    const wh = await createWebhook('a1', null);
    const rotated = await rotateWebhookSecret(wh.id, 'a1', { overlapSeconds: 600 });
    await endOverlap(wh.id);
    const read = await getWebhook(wh.id);
    assert.deepStrictEqual([read.secret, read.previousSecret], [rotated.secret, null]);
    assert.strictEqual((await listed(wh.id)).previousValidUntil, null);

    assert.ok(await up() >= 1);
    assert.deepStrictEqual(await row(wh.id).then((r) => [r.prev_secret, r.prev_valid_until]), [null, null]);
    assert.strictEqual(await up(), 0, 'a second pass finds nothing');
    assert.strictEqual((await getWebhook(wh.id)).secret, rotated.secret);
});

test('an overlap of 0 ends the previous secret at once', async () => {
    const wh = await createWebhook('a1', null);
    const rotated = await rotateWebhookSecret(wh.id, 'a1', { overlapSeconds: 0 });
    assert.strictEqual(rotated.previousValidUntil, null);
    assert.strictEqual((await getWebhook(wh.id)).previousSecret, null);
    assert.deepStrictEqual(await row(wh.id).then((r) => [r.prev_secret, r.prev_valid_until]), [null, null]);
});

test('the overlap is the operator\'s by default (AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS)', async () => {
    const wh = await createWebhook('a1', null);
    process.env.AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS = '0';
    try {
        assert.strictEqual((await rotateWebhookSecret(wh.id, 'a1')).previousValidUntil, null);
        delete process.env.AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS;
        const rotated = await rotateWebhookSecret(wh.id, 'a1');
        assert.ok(Math.abs(Date.parse(rotated.previousValidUntil) - (Date.now() + 3_600_000)) < 60_000, 'one hour when unset');
    } finally {
        delete process.env.AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS;
    }
});

test('a second rotation inside the overlap keeps only the secret right before it', async () => {
    const wh = await createWebhook('a1', null);
    const first = await rotateWebhookSecret(wh.id, 'a1', { overlapSeconds: 600 });
    const second = await rotateWebhookSecret(wh.id, 'a1', { overlapSeconds: 600 });
    const read = await getWebhook(wh.id);
    assert.deepStrictEqual([read.secret, read.previousSecret], [second.secret, first.secret]);
});

test('a secret from before sealing is sealed when it becomes the previous one', async () => {
    const plain = 'ef'.repeat(32);
    await pg.query(`INSERT INTO automation_webhooks (id, automation_id, secret) VALUES ('legacy-r', 'a1', $1)`, [plain]);
    await rotateWebhookSecret('legacy-r', 'a1', { overlapSeconds: 600 });
    assert.ok(isSealed((await row('legacy-r')).prev_secret));
    assert.strictEqual((await getWebhook('legacy-r')).previousSecret, plain);
});

test('a webhook of another automation is not rotated', async () => {
    const wh = await createWebhook('a1', null);
    assert.strictEqual(await rotateWebhookSecret(wh.id, 'someone-else'), null);
    assert.strictEqual((await getWebhook(wh.id)).secret, wh.secret);
});

test('the columns are registered exactly once, after the sealing pass', () => {
    const { MIGRATIONS } = require('./core');
    const { LOOSE_MIGRATIONS } = require('../../boot/bootMigrations');
    const name = 'automation-webhook-rotation-2026-11';
    assert.strictEqual(MIGRATIONS.filter((m) => m === name).length, 1);
    assert.strictEqual(LOOSE_MIGRATIONS.filter((m) => m === name).length, 0);
    assert.ok(MIGRATIONS.indexOf('automation-webhook-secret-sealed-2026-11') < MIGRATIONS.indexOf(name));
});
