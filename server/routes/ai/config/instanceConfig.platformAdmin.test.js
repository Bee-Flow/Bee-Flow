/**
 * GET/POST/DELETE /ai/config — the platform-admin gate and the member view.
 *
 * The writes of this router change INSTANCE-wide state: the LLM providers'
 * keys, the Privacy Shield defaults every organisation falls back to, the
 * search backend, the Stripe secrets. The router runs behind a real express
 * app (testUtils/routeHarness) with the database recorded; the gate is the
 * real config/shared.isAdminUser → auth/requirePlatformAdmin, built with
 * fixture collaborators and put in the barrel's place. Verifies:
 *   - cloud: an org_admin holding admin_ai_config gets 403 on every write and
 *     nothing is written; a platform admin gets 200;
 *   - self-hosted: that same org_admin gets 200;
 *   - GET /config answers a member with the allow-listed projection only — no
 *     endpoint URLs, no ruleset, no inventory of which keys exist — and the
 *     admin with everything.
 *
 * Run: cd server && node --test routes/ai/config/instanceConfig.platformAdmin.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../../testUtils/routeHarness');
const { createPlatformAdminGate } = require('../../../auth/requirePlatformAdmin');

const fx = { mode: 'cloud', perms: /** @type {string[]} */ (['admin_ai_config']) };
const gate = createPlatformAdminGate({
    hasPermission: async (_userId, permission) => fx.perms.includes(permission) || fx.perms.includes('all'),
    isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
    deploymentMode: () => fx.mode,
});

// The config rows the router reads (plain keys only: secrets are read through
// the envelope and answer no row here, which reads as "not configured").
const ROWS = {
    ai: {
        providers: [{ id: 'p1', name: 'EU endpoint', type: 'openai-compatible', url: 'http://llm.internal:8000/v1', model: 'm' }],
        defaultProviderId: 'p1',
        regexGuardrails: { rules: [{ id: 'r1', name: 'IBAN', pattern: 'NL\\d{2}' }], collections: [{ id: 'c1', name: 'Finance', ruleIds: ['r1'] }] },
        piiDetectionEnabled: true, piiDetectionAction: 'block', piiDetectionCategories: ['email'],
    },
    agent_search_url: 'http://search.internal:9200',
    allowedModelsByAgentType: { chat: ['m'] },
    search_provider: 'serper',
    azure_models: 'gpt-4o@eastus',
};

const { db, api } = h.routeUnderTest(test, '/ai', () => require('./instanceConfig'), {
    gates: { hasPlatformAdminAccess: gate.hasPlatformAdminAccess, requirePlatformAdmin: gate.requirePlatformAdmin },
    answer: (sql, params) => {
        if (/SELECT value FROM config WHERE key = \$1/i.test(sql) && params?.[0] in ROWS) {
            return { rows: [{ value: JSON.stringify(ROWS[params[0]]) }] };
        }
        return undefined;
    },
});

const PLATFORM_ADMIN = { ...h.USER, role: 'admin' };
const ORG_ADMIN = { ...h.USER, role: 'user', orgRole: 'org_admin' };
const MEMBER = h.USER;
const writes = () => db.queries.filter((q) => /INSERT|UPDATE|DELETE/i.test(q));

const WRITES = [
    ['POST', '/config', { stripeSecretKey: 'sk_live_new', agentSearchUrl: 'http://attacker.example' }],
    ['POST', '/config', { piiDetectionAction: 'warn' }],
    ['DELETE', '/config/key/stripe_webhook_secret', undefined],
    ['DELETE', '/config/setting/azure_endpoint', undefined],
];

test.beforeEach(() => { fx.mode = 'cloud'; fx.perms = ['admin_ai_config']; });

test('cloud: an org_admin with admin_ai_config is refused on every write, and nothing is written', async () => {
    for (const [method, url, body] of WRITES) {
        const res = await api.call(method, `/ai${url}`, { body, user: ORG_ADMIN });
        assert.strictEqual(res.status, 403, `${method} ${url}: ${res.text}`);
        assert.deepStrictEqual(res.body, { error: 'Admin access required' });
    }
    assert.deepStrictEqual(writes(), []);
});

test('cloud: a platform admin writes', async () => {
    const res = await api.call('DELETE', '/ai/config/key/stripe_webhook_secret', { user: PLATFORM_ADMIN });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(writes().some((q) => /DELETE/i.test(q)), `a DELETE reached the store: ${JSON.stringify(writes())}`);
});

test('self-hosted: the org_admin with admin_ai_config writes', async () => {
    fx.mode = 'self-hosted';
    const res = await api.call('DELETE', '/ai/config/key/stripe_webhook_secret', { user: ORG_ADMIN });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(writes().some((q) => /DELETE/i.test(q)));
});

test('GET /config: a member gets the projection, not the inventory', async () => {
    const res = await api.call('GET', '/ai/config', { user: MEMBER });
    assert.strictEqual(res.status, 200, res.text);
    const body = res.body;
    // What the composer, designer, settings page and mobile read.
    assert.deepStrictEqual(body.allowedModelsByAgentType, { chat: ['m'] });
    assert.strictEqual(body.searchProvider, 'serper');
    assert.strictEqual(body.hasGoogleMapsKey, false);
    assert.strictEqual(body.piiDetectionAction, 'block');
    assert.deepStrictEqual(body.piiDetectionCategories, ['email']);
    assert.strictEqual(body.notebooksEnabled, true);
    assert.strictEqual(body.stripeEnabled, false);
    // The designer lists collections by id and name; the patterns stay with the admin.
    assert.deepStrictEqual(body.regexGuardrails, { collections: [{ id: 'c1', name: 'Finance' }] });
    // The inventory is not there.
    for (const key of ['url', 'model', 'agentSearchUrl', 'hasAgentSearchUrl', 'azureModels', 'directChatRegexGuardrails',
        'embeddingProviderId', 'hasApiKey', 'hasClaudeKey', 'hasStripeSecretKey', 'serviceEmailAddress', 'hasSerperKey']) {
        assert.ok(!(key in body), `${key} must not be in the member view`);
    }
    assert.ok(!res.text.includes('internal'), 'no internal URL reaches a member');
    assert.ok(!res.text.includes('NL\\\\d{2}'), 'no pattern reaches a member');
});

test('GET /config: an org_admin in cloud mode is a member for this read', async () => {
    const res = await api.call('GET', '/ai/config', { user: ORG_ADMIN });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(!('agentSearchUrl' in res.body));
    assert.ok(!('hasStripeSecretKey' in res.body));
    assert.ok(!res.text.includes('internal'));
});

test('GET /config: a platform admin gets everything (the admin pages depend on it)', async () => {
    const res = await api.call('GET', '/ai/config', { user: PLATFORM_ADMIN });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.agentSearchUrl, 'http://search.internal:9200');
    assert.strictEqual(res.body.url, 'http://llm.internal:8000/v1');
    assert.strictEqual(res.body.azureModels, 'gpt-4o@eastus');
    assert.strictEqual(res.body.regexGuardrails.rules[0].pattern, 'NL\\d{2}');
    assert.strictEqual(res.body.hasStripeSecretKey, false);
    assert.strictEqual(res.body.searchProvider, 'serper');
});

test('GET /config: self-hosted, the org_admin keeps the full answer (the admin pages there are theirs)', async () => {
    fx.mode = 'self-hosted';
    const res = await api.call('GET', '/ai/config', { user: ORG_ADMIN });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.agentSearchUrl, 'http://search.internal:9200');
});
