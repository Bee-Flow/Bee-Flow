/**
 * /ai/providers — the platform-admin gate and the member catalogue.
 *
 * Providers are instance-wide (one list, one default, keys shared by every
 * organisation). The router runs behind a real express app
 * (testUtils/routeHarness) with the database recorded; the gate is the real
 * config/shared.isAdminUser → auth/requirePlatformAdmin, built with fixture
 * collaborators and put in the barrel's place. Verifies:
 *   - cloud: an org_admin holding admin_ai_config gets 403 on the mutations and
 *     nothing is written; self-hosted: the same caller gets 200;
 *   - GET /providers: a member (and, in cloud, an org_admin) gets id, name,
 *     type and model only — no endpoint URL, no key tail, no service account;
 *     a platform admin gets the masked full record the provider cards show.
 *
 * Run: cd server && node --test routes/ai/providers.platformAdmin.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');
const { createPlatformAdminGate } = require('../../auth/requirePlatformAdmin');

const fx = { mode: 'cloud', perms: /** @type {string[]} */ (['admin_ai_config']) };
const gate = createPlatformAdminGate({
    hasPermission: async (_userId, permission) => fx.perms.includes(permission) || fx.perms.includes('all'),
    isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
    deploymentMode: () => fx.mode,
});

const P1 = {
    id: 'p1', name: 'EU endpoint', type: 'openai-compatible',
    url: 'https://llm.internal.example/v1', model: 'm', apiKey: 'sk-supergeheim-1234',
    serviceAccountKey: '{"private_key":"geheim"}', project: 'proj', location: 'eu',
};

const { db, api } = h.routeUnderTest(test, '/ai', () => require('./providers'), {
    gates: { hasPlatformAdminAccess: gate.hasPlatformAdminAccess, requirePlatformAdmin: gate.requirePlatformAdmin },
    answer: (sql, params) => {
        if (/SELECT value FROM config WHERE key = \$1/i.test(sql) && params?.[0] === 'ai') {
            return { rows: [{ value: JSON.stringify({ providers: [P1], defaultProviderId: 'p1' }) }] };
        }
        return undefined;
    },
});

const PLATFORM_ADMIN = { ...h.USER, role: 'admin' };
const ORG_ADMIN = { ...h.USER, role: 'user', orgRole: 'org_admin' };
const MEMBER = h.USER;
const writes = () => db.queries.filter((q) => /INSERT|UPDATE|DELETE/i.test(q));
/** @param {{ providers: Array<{ id: string }> }} body */
const p1Of = (body) => body.providers.find((p) => p.id === 'p1');

const MUTATIONS = [
    ['POST', '/providers', { name: 'x', url: 'https://evil.example', type: 'openai-compatible' }],
    ['PUT', '/providers/p1', { url: 'https://evil.example' }],
    ['DELETE', '/providers/p1', undefined],
    ['PUT', '/providers/p1/default', undefined],
];

test.beforeEach(() => { fx.mode = 'cloud'; fx.perms = ['admin_ai_config']; });

test('cloud: an org_admin with admin_ai_config is refused on every mutation, and nothing is written', async () => {
    for (const [method, url, body] of MUTATIONS) {
        const res = await api.call(method, `/ai${url}`, { body, user: ORG_ADMIN });
        assert.strictEqual(res.status, 403, `${method} ${url}: ${res.text}`);
        assert.deepStrictEqual(res.body, { error: 'Admin access required' });
    }
    assert.deepStrictEqual(writes(), []);
});

test('self-hosted: the same org_admin mutates; a platform admin anywhere', async () => {
    fx.mode = 'self-hosted';
    let res = await api.call('PUT', '/ai/providers/p1/default', { user: ORG_ADMIN });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(writes().length > 0, 'the default was written');
    db.reset();
    fx.mode = 'cloud';
    res = await api.call('PUT', '/ai/providers/p1/default', { user: PLATFORM_ADMIN });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(writes().length > 0);
});

test('GET /providers: a member gets the catalogue only', async () => {
    const res = await api.call('GET', '/ai/providers', { user: MEMBER });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(p1Of(res.body), { id: 'p1', name: 'EU endpoint', type: 'openai-compatible', model: 'm' });
    assert.strictEqual(res.body.defaultProvider, 'p1');
    for (const p of res.body.providers) {
        assert.deepStrictEqual(Object.keys(p).sort(), ['id', 'model', 'name', 'type'], `${p.id}: catalogue fields only`);
    }
    assert.ok(!res.text.includes('1234'), 'no key tail');
    assert.ok(!res.text.includes('internal.example'), 'no endpoint');
});

test('GET /providers: in cloud an org_admin is a member for this read; self-hosted it is the admin', async () => {
    let res = await api.call('GET', '/ai/providers', { user: ORG_ADMIN });
    assert.ok(!('url' in p1Of(res.body)));
    assert.ok(!('apiKey' in p1Of(res.body)));
    fx.mode = 'self-hosted';
    res = await api.call('GET', '/ai/providers', { user: ORG_ADMIN });
    assert.strictEqual(p1Of(res.body).url, 'https://llm.internal.example/v1');
    assert.strictEqual(p1Of(res.body).apiKey, '••••1234');
});

test('GET /providers: a platform admin gets the masked full record', async () => {
    const res = await api.call('GET', '/ai/providers', { user: PLATFORM_ADMIN });
    assert.strictEqual(res.status, 200, res.text);
    const p = p1Of(res.body);
    assert.strictEqual(p.url, 'https://llm.internal.example/v1');
    assert.strictEqual(p.apiKey, '••••1234');
    assert.strictEqual(p.serviceAccountKey, '••••(configured)');
    assert.strictEqual(p.project, 'proj');
    assert.ok(!res.text.includes('sk-supergeheim'), 'the real key never leaves the router');
});
