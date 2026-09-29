/**
 * What the tenant support inbox accepts (routes/supportInbox.js,
 * routes/support/inboxSchemas.js).
 *
 *   - PATCH /inboxes/:id handed the whole body to the store, so server-owned
 *     columns (`email_address`, `provider_config`, `known_good_senders`) could
 *     be rewritten by anyone with support_inbox.
 *   - PUT /inboxes/:id/access with a misspelled `sharedGroup` opened a
 *     group-restricted inbox to the whole organisation.
 *   - an agent of ANOTHER organisation could be made the inbox's AI.
 *   - `enabled: "false"` switched the KB automation on.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/supportInbox.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
// The store derives its token key from this at load; any 32 characters will do.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'validation-test-session-secret-000000';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

const FOREIGN_AGENT = { id: 'agent-foreign', name: 'Theirs', organization_id: 'org2', owner_id: 'u9', config: '{}' };
const { db, api } = h.routeUnderTest(test, '/api/support-inbox', () => require('./supportInbox'), {
    gates: { resolveUserOrgIds: async () => new Set(['org1']) },
    answer: (sql, params) => (/FROM agents WHERE id = \$1/.test(sql) && params?.[0] === FOREIGN_AGENT.id ? { rows: [FOREIGN_AGENT] } : undefined),
});

// The agent store backfills its own rows on first use; what matters is the inbox table.
const writes = () => db.queries.filter((q) => /support_inboxes/.test(q) && /INSERT|UPDATE|DELETE/i.test(q));

test('the inbox settings take only what the settings screens edit', async () => {
    for (const key of ['email_address', 'provider_config', 'known_good_senders', 'shared_groups']) {
        const res = await api.call('PATCH', '/api/support-inbox/inboxes/in1', { body: { [key]: 'x' } });
        h.assertRefused(assert, res, 'body', new RegExp(`"${key}"`));
    }
    h.assertRefused(assert, await api.call('PATCH', '/api/support-inbox/inboxes/in1', { body: { autoresolve_threshold: 7 } }), 'body.autoresolve_threshold', /from 0 to 1/);
    h.assertRefused(assert, await api.call('PATCH', '/api/support-inbox/inboxes/in1', { body: { reply_mode: 'yolo' } }), 'body.reply_mode');
    assert.deepStrictEqual(db.queries, []);
});

test('a misspelled sharedGroups is refused instead of opening the inbox to everyone', async () => {
    const res = await api.call('PUT', '/api/support-inbox/inboxes/in1/access', { body: { sharedGroup: ['g1'] } });
    h.assertRefused(assert, res, 'body', /sharedGroups is the list of group ids/);
    assert.deepStrictEqual(db.queries, []);
});

test('booleans are booleans', async () => {
    h.assertRefused(assert, await api.call('PUT', '/api/support-inbox/inboxes/in1/kb-automation', { body: { enabled: 'false' } }), 'body.enabled', /enabled is true or false/);
    h.assertRefused(assert, await api.call('PATCH', '/api/support-inbox/threads/t1', { body: { markNotSupport: 'true' } }), 'body.markNotSupport');
    h.assertRefused(assert, await api.call('GET', '/api/support-inbox/threads?limit=abc'), 'query.limit');
    h.assertRefused(assert, await api.call('PUT', '/api/support-inbox/sla-policies', { body: { priority: 'high', firstResponseMinutes: 'soon', resolutionMinutes: 60 } }), 'body.firstResponseMinutes');
    assert.deepStrictEqual(db.queries, []);
});

test("another organisation's agent cannot become the inbox's AI", async () => {
    const res = await api.call('POST', '/api/support-inbox/inboxes', { body: { provider: 'gmail', defaultAgentId: FOREIGN_AGENT.id } });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.code, 'agent_not_available');
    assert.deepStrictEqual(writes(), [], 'no inbox was created');
});

test('the session is checked before the body', async () => {
    const res = await api.call('PATCH', '/api/support-inbox/inboxes/in1', { body: { email_address: 'x' }, user: null });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid ticket list reaches the store and answers as before', async () => {
    const res = await api.call('GET', '/api/support-inbox/threads?status=open,awaiting_agent&limit=50');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { threads: [], counts: {} });
    assert.ok(db.queries.length > 0);
});
