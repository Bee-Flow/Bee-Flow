/**
 * The inbound event webhooks answer failures through the terminal handler
 * (routes/automation/events.js): a dispatch that throws is the generic 500
 * with a correlationId, and an unconfigured GitHub secret is a 503 with a code.
 * GitHub, Google and Microsoft retry on any 5xx, so the JSON body is harmless.
 *
 * Run: cd server && node --test routes/automation/events.errors.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'validation-test-session-secret-000000';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');

h.recordDb();
const triggerBus = require('../../automation/triggerBus');
const configStore = require('../../stores/configStore');
const { api } = h.routeUnderTest(test, '/api/automation', () => require('./events'));

const realDispatch = triggerBus.dispatchEvent;
const realGetConfig = configStore.getConfig;
test.afterEach(() => { triggerBus.dispatchEvent = realDispatch; configStore.getConfig = realGetConfig; });

function assertGeneric500(res) {
    assert.strictEqual(res.status, 500, res.text);
    assert.strictEqual(res.body.error, 'Internal server error');
    assert.ok(res.body.correlationId, 'the sender can quote a correlationId');
    assert.doesNotMatch(res.text, /bus down/);
}

test('a failing dispatch is the generic 500 on the gmail hook', async () => {
    triggerBus.dispatchEvent = async () => { throw new Error('bus down'); };
    const data = Buffer.from(JSON.stringify({ emailAddress: 'a@b.test' })).toString('base64');
    assertGeneric500(await api.call('POST', '/api/automation/events/gmail', { body: { message: { data } } }));
    assert.strictEqual((await api.call('POST', '/api/automation/events/gmail', { body: {} })).status, 204);
});

test('the github hook without a secret is a 503 with a code', async () => {
    configStore.getConfig = async () => null;
    const res = await api.call('POST', '/api/automation/events/github', { body: { zen: 'x' } });
    assert.strictEqual(res.status, 503, res.text);
    assert.strictEqual(res.body.code, 'github_webhooks_unconfigured');
    assert.strictEqual(res.body.error, 'GitHub webhooks not configured');
});

test('the github hook: a failing dispatch is the generic 500', async () => {
    const crypto = require('crypto');
    configStore.getConfig = async () => 'secret';
    triggerBus.dispatchEvent = async () => { throw new Error('bus down'); };
    const body = { zen: 'x' };
    const sig = 'sha256=' + crypto.createHmac('sha256', 'secret').update(JSON.stringify(body)).digest('hex');
    assertGeneric500(await api.call('POST', '/api/automation/events/github', { body, headers: { 'X-Hub-Signature-256': sig } }));
});
