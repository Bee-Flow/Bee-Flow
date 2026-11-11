/**
 * GET /:id/webhooks and POST /:id/webhook/:slug/rotate, as the owner reads them
 * (routes/automation/webhooksAndRunOps.js): each webhook with its newest deliveries
 * (what became of each, a size, a short hash) and never a secret; a rotation with the new
 * secret once and until when the previous one is accepted.
 *
 * No module mocking: a few store functions are swapped on the module object for the run.
 *
 * Run: cd server && node --test routes/automation/webhooksAndRunOps.webhookList.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const automationStore = require('../../stores/automationStore');
const userStore = require('../../stores/userStore');
const permissions = require('../../auth/permissions');
const { serve } = require('../../testUtils/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');

const { swap, restore } = makeSwaps();
const asked = [];
let api;

before(() => {
    swap(automationStore, 'getAutomation', async (id) => (id === 'a1' ? { id: 'a1', userId: 'owner', organizationId: 'org1', kind: 'automation', definition: {} } : null));
    swap(automationStore, 'listSharesForAutomation', async () => []);
    swap(userStore, 'getUser', async (id) => ({ id, organizationId: 'org1', groups: [] }));
    swap(permissions, 'hasPermission', async () => false);
    swap(automationStore, 'getWebhooksForAutomation', async () => [
        { id: 'wh1', automationId: 'a1', lastSeenAt: null, triggerStepId: null, previousValidUntil: '2026-11-11T12:00:00.000Z' },
        { id: 'wh2', automationId: 'a1', lastSeenAt: null, triggerStepId: 't2', previousValidUntil: null },
    ]);
    swap(automationStore, 'recentWebhookDeliveries', async (ids, perWebhook) => {
        asked.push([ids, perWebhook]);
        return { wh1: [{ id: 'awd_1', status: 'accepted', bodyBytes: 31, bodyHash: 'ab'.repeat(32), receivedAt: '2026-11-11T10:00:00.000Z' }, { id: 'awd_0', status: 'bad_signature', bodyBytes: 2, bodyHash: null, receivedAt: '2026-11-11T09:00:00.000Z' }], wh2: [] };
    });
    swap(automationStore, 'rotateWebhookSecret', async (slug, automationId) => (slug === 'wh1' ? { id: slug, automationId, secret: 'ef'.repeat(32), previousValidUntil: '2026-11-11T12:00:00.000Z' } : null));
    api = serve('/', [require('./webhooksAndRunOps')]);
});

after(async () => {
    restore();
    await api.close();
});

test('the owner reads each webhook with its newest deliveries and a short hash', async () => {
    const res = await api.call('GET', '/a1/webhooks', { user: { id: 'owner' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(asked, [[['wh1', 'wh2'], 20]]);
    const [wh1, wh2] = res.body.webhooks;
    assert.deepStrictEqual(wh1.deliveries, [
        { id: 'awd_1', status: 'accepted', bodyBytes: 31, bodyHash: 'abababababab', receivedAt: '2026-11-11T10:00:00.000Z' },
        { id: 'awd_0', status: 'bad_signature', bodyBytes: 2, bodyHash: null, receivedAt: '2026-11-11T09:00:00.000Z' },
    ]);
    assert.strictEqual(wh1.previousValidUntil, '2026-11-11T12:00:00.000Z');
    assert.ok(wh1.url.endsWith('/api/automation/webhook/wh1'));
    assert.deepStrictEqual(wh2.deliveries, []);
    assert.ok(!('secret' in wh1) && !('previousSecret' in wh1));
});

test('someone without access to the automation reads nothing', async () => {
    const res = await api.call('GET', '/a1/webhooks', { user: { id: 'stranger' } });
    assert.ok(res.status === 403 || res.status === 404);
    assert.strictEqual(res.body.webhooks, undefined);
});

test('a rotation answers the new secret once and until when the previous one is accepted', async () => {
    const res = await api.call('POST', '/a1/webhook/wh1/rotate', { user: { id: 'owner' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.webhook, { id: 'wh1', automationId: 'a1', secret: 'ef'.repeat(32), previousValidUntil: '2026-11-11T12:00:00.000Z' });
    assert.strictEqual((await api.call('POST', '/a1/webhook/nope/rotate', { user: { id: 'owner' } })).status, 404);
});
