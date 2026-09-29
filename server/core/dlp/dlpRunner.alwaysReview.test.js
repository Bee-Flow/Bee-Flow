/**
 * dlpAlwaysReview — the "ask" gate normally only pauses when the detector
 * finds something (dlpRunner.js's `all.length === 0` early-return always
 * said 'allow'). That means a false negative — the ONE thing an "ask" org is
 * trying to catch — never gets a review screen at all. dlpAlwaysReview
 * forces the pause even on a clean scan, opt-in per org.
 *
 * Run: cd server && node --test --test-force-exit core/dlp/dlpRunner.alwaysReview.test.js
 */

const assert = require('assert');
const { test, before, after, beforeEach } = require('node:test');
const http = require('http');

process.env.NODE_ENV = 'test';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return resolved;
}

stub('../aiAgent', { getAIConfig: async () => ({ piiDetectionEnabled: true }) });
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

let server;

before(async () => {
    // No marker in the text below → the guard always reports zero entities.
    // This suite is about the zero-findings branch, not detection itself.
    server = http.createServer((req, res) => {
        req.on('data', () => {});   // drain, so 'end' fires
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasPii: false, entities: [], degraded: false, degraded_reason: null }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const pii = require('../privacy/piiDetection');
const dlpRunner = require('./dlpRunner');

const PROVIDER = { providerType: 'openai', url: 'https://api.openai.com/v1', displayName: 'OpenAI' };
const BASE_SHIELD = {
    enabled: true,
    dlpEnabled: true,
    dlpScope: 'all',
    dlpMode: 'ask',
    piiFailureMode: 'fail_open',
    piiDetectionCategories: ['Email'],
    piiDetectionConfidenceThreshold: 0.7,
};

beforeEach(() => {
    pii._resetGuardCircuit();
    pii.invalidateGuardEndpointCache();
});

test('dlpAlwaysReview off (default): a clean scan still returns allow', async () => {
    const messages = [{ role: 'user', content: 'volledig onschuldige tekst' }];
    const result = await dlpRunner.scan({
        messages, orgShieldConfig: BASE_SHIELD, orgId: 'o1', conversationId: `c-${Date.now()}-a`, providerConfig: PROVIDER,
    });
    assert.strictEqual(result.action, 'allow');
    assert.deepEqual(result.findings, []);
});

test('dlpAlwaysReview on: a clean scan pauses (ask) instead of allowing silently', async () => {
    const messages = [{ role: 'user', content: 'volledig onschuldige tekst' }];
    const result = await dlpRunner.scan({
        messages,
        orgShieldConfig: { ...BASE_SHIELD, dlpAlwaysReview: true },
        orgId: 'o1',
        conversationId: `c-${Date.now()}-b`,
        providerConfig: PROVIDER,
    });
    assert.strictEqual(result.action, 'ask');
    assert.deepEqual(result.findings, [], 'nothing was found — the pause exists purely so the user can add something manually');
});

test('dlpAlwaysReview on, but the user already remembered a choice this conversation: no repeat pause', async () => {
    const conversationId = `c-${Date.now()}-c`;
    dlpRunner.setConversationPref(conversationId, 'allow');
    const messages = [{ role: 'user', content: 'volledig onschuldige tekst' }];
    const result = await dlpRunner.scan({
        messages,
        orgShieldConfig: { ...BASE_SHIELD, dlpAlwaysReview: true },
        orgId: 'o1',
        conversationId,
        providerConfig: PROVIDER,
    });
    assert.strictEqual(result.action, 'allow', 'a remembered per-conversation choice must not be re-litigated on every clean message');
});

test('dlpAlwaysReview on, but this turn has attachments: no redundant message-only pause', async () => {
    // Attachments get their own ask-review a few steps later
    // (attachmentAskFlow.js) — pausing here too, on an empty message-side
    // finding, produced a second near-empty modal right after the first.
    const messages = [{ role: 'user', content: 'hier is de jaarrekening, kun je die samenvatten?' }];
    const result = await dlpRunner.scan({
        messages,
        orgShieldConfig: { ...BASE_SHIELD, dlpAlwaysReview: true },
        orgId: 'o1',
        conversationId: `c-${Date.now()}-e`,
        providerConfig: PROVIDER,
        hasAttachments: true,
    });
    assert.strictEqual(result.action, 'allow');
});

test('dlpAlwaysReview is a no-op when DLP itself is out of scope (disabled shield)', async () => {
    const messages = [{ role: 'user', content: 'volledig onschuldige tekst' }];
    const result = await dlpRunner.scan({
        messages,
        orgShieldConfig: { ...BASE_SHIELD, dlpEnabled: false, dlpAlwaysReview: true },
        orgId: 'o1',
        conversationId: `c-${Date.now()}-d`,
        providerConfig: PROVIDER,
    });
    assert.strictEqual(result.action, 'allow', 'dlpAlwaysReview only widens DLP\'s own gate, it must not expand DLP\'s applicability');
});
