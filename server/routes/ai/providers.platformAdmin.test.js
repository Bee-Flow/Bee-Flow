/**
 * /ai/providers — the platform-admin gate and the member catalogue.
 *
 * Providers are instance-wide (one list, one default, keys shared by every
 * organisation). The router runs behind a real express app
 * (testUtils/routeHarness) with the database recorded; the gate is the real
 * config/shared.isAdminUser → auth/requirePlatformAdmin, built with fixture
 * collaborators and put in the barrel's place. Verifies:
 *   - in cloud and self-hosted alike: an org_admin holding admin_ai_config gets
 *     403 on the mutations and nothing is written; a platform admin gets 200;
 *   - GET /providers: a member (and an org_admin, in either mode) gets id,
 *     name, type and model only — no endpoint URL, no key tail, no service
 *     account; a platform admin gets the masked full record the provider cards
 *     show.
 *
 * Run: cd server && node --test routes/ai/providers.platformAdmin.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const kit = require('./platformAdmin.testkit');

const { PLATFORM_ADMIN, ORG_ADMIN, MEMBER, inEachMode } = kit;

const P1 = {
    id: 'p1', name: 'EU endpoint', type: 'openai-compatible',
    url: 'https://llm.internal.example/v1', model: 'm', apiKey: 'sk-supergeheim-1234',
    serviceAccountKey: '{"private_key":"geheim"}', project: 'proj', location: 'eu',
};

const route = kit.platformGatedRoute(test, () => require('./providers'), (sql, params) => {
    if (/SELECT value FROM config WHERE key = \$1/i.test(sql) && params?.[0] === 'ai') {
        return { rows: [{ value: JSON.stringify({ providers: [P1], defaultProviderId: 'p1' }) }] };
    }
    return undefined;
});
const { db, api, writes } = route;
/** @param {{ providers: Array<{ id: string }> }} body */
const p1Of = (body) => body.providers.find((p) => p.id === 'p1');

const MUTATIONS = [
    ['POST', '/providers', { name: 'x', url: 'https://other.example', type: 'openai-compatible' }],
    ['PUT', '/providers/p1', { url: 'https://other.example' }],
    ['DELETE', '/providers/p1', undefined],
    ['PUT', '/providers/p1/default', undefined],
];

test('an org_admin with admin_ai_config is refused on every mutation, in cloud and self-hosted alike, and nothing is written', async () => {
    await kit.assertOrgAdminRefused(route, MUTATIONS);
});

test('a platform admin mutates, in cloud and self-hosted alike', async () => {
    await inEachMode(async (mode) => {
        db.reset();
        const res = await api.call('PUT', '/ai/providers/p1/default', { user: PLATFORM_ADMIN });
        assert.strictEqual(res.status, 200, `${mode}: ${res.text}`);
        assert.ok(writes().length > 0, `${mode}: the default was written`);
    });
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

test('GET /providers: an org_admin is a member for this read, in cloud and self-hosted alike', async () => {
    await inEachMode(async (mode) => {
        const res = await api.call('GET', '/ai/providers', { user: ORG_ADMIN });
        assert.strictEqual(res.status, 200, `${mode}: ${res.text}`);
        assert.deepStrictEqual(p1Of(res.body), { id: 'p1', name: 'EU endpoint', type: 'openai-compatible', model: 'm' }, mode);
        assert.ok(!res.text.includes('1234'), `${mode}: no key tail`);
    });
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
