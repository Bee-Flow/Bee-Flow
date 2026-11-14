/**
 * What the integration settings accept (routes/ai/config/integrations.js).
 *
 *   - PUT /ai/agent-search/defaults only required a session: any signed-in
 *     user could rewrite the installation-wide search defaults every agent
 *     reads. It is admin-only now (the same isAdminUser as the other AI
 *     config writes).
 *   - `include_citations: "false"` switched citations ON; a misspelled mode or
 *     detail level quietly became the default.
 *   - MCP server and credential bodies ignored misspelled keys.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/ai/config/integrations.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../../testUtils/routeHarness');

// hasPermission answers false: a plain member, not an AI-config admin.
const { db, api } = h.routeUnderTest(test, '/ai', () => {
    require('../../../license/middleware').requireFeature = () => (req, res, next) => next();
    return require('./integrations');
}, { gates: { hasPermission: async () => false } });

const put = (body, user) => api.call('PUT', '/ai/agent-search/defaults', { body, user });
const PLATFORM_ADMIN = { ...h.USER, role: 'admin' };

// The schema runs after the platform-admin gate: only an admin learns what it refuses.
test('the search defaults refuse text booleans and unknown values', async () => {
    h.assertRefused(assert, await put({ include_citations: 'false' }, PLATFORM_ADMIN), 'body.include_citations', /true or false/);
    h.assertRefused(assert, await put({ mode: 'google' }, PLATFORM_ADMIN), 'body.mode', /web, web_fast, kb or auto/);
    h.assertRefused(assert, await put({ web: { detail: 'basic' } }, PLATFORM_ADMIN), 'body.web', /"detail"/);
    assert.deepStrictEqual(db.queries, []);
});

test('a member may not rewrite the installation-wide search defaults, and learns nothing from the schema', async () => {
    const res = await put({ mode: 'kb' });
    assert.strictEqual(res.status, 403, res.text);
    const invalid = await put({ mode: 'google' });
    assert.strictEqual(invalid.status, 403, invalid.text);
    assert.ok(!db.queries.some((q) => /INSERT|UPDATE/i.test(q) && /config/i.test(q)), db.queries.join(' | '));
});

test('an admin may, and the values are stored as before', async () => {
    const res = await put({ mode: 'kb', include_citations: false }, { ...h.USER, role: 'admin' });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { success: true });
    assert.ok(db.queries.some((q) => /config/i.test(q)));
});

test('MCP bodies and the registry query are closed', async () => {
    const ADMIN = { ...h.USER, role: 'admin' };
    h.assertRefused(assert, await api.call('POST', '/ai/mcp-servers/user-credentials', { body: { serverId: 's', credKey: 'k', val: 'x' } }), 'body', /"val"/);
    h.assertRefused(assert, await api.call('POST', '/ai/mcp-servers', { body: { name: 'x', transport: 'sse' }, user: ADMIN }), 'body.transport', /stdio or http/);
    h.assertRefused(assert, await api.call('GET', '/ai/mcp-registry/search?verified=1'), 'query', /"verified"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await put({ include_citations: 'false' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('refreshing an MCP server takes no fields; the empty object the screen sends passes the schema', async () => {
    const ADMIN = { ...h.USER, role: 'admin' };
    h.assertRefused(assert, await api.call('POST', '/ai/mcp-servers/s1/refresh', { body: { force: true }, user: ADMIN }), 'body', /Refreshing an MCP server does not take "force"/);
    const res = await api.call('POST', '/ai/mcp-servers/s1/refresh', { body: {}, user: ADMIN });
    assert.notStrictEqual(res.body?.code, 'invalid_request', res.text);
});

test('enabling n8n for the organisation takes no fields', async () => {
    const res = await api.call('POST', '/ai/n8n/enable-for-org', { body: { orgId: 'org2' }, user: { ...h.USER, role: 'admin' } });
    h.assertRefused(assert, res, 'body', /Enabling n8n for the organisation does not take "orgId"/);
});
