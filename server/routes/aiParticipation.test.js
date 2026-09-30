/**
 * routes/aiParticipation.js over a real Express app (routeHarness serve()),
 * with the gates and configStore injected through makeAiParticipationRouter
 * and the real policy module on top. No module mocking.
 *
 * Proven:
 *   - no session 401; the org policy is readable by the org's members only,
 *     writable by its admins only; an unconfigured org reads the defaults;
 *   - a save round-trips, clamps its numbers and drops the 30 s memo, so the
 *     engine sees it on the very next message;
 *   - closed bodies: a misspelled key, a missing switch, a string "false"
 *     and an unknown sensitivity are refused and nothing is written;
 *   - a read failure is a 503, never a guess shown as the saved settings;
 *   - each person reads and changes only their own opt-out.
 *
 * Run: cd server && node --test routes/aiParticipation.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { serve, assertRefused } = require('../core/http/routeHarness');
const { makeAiParticipationRouter } = require('./aiParticipation');
const { makePolicy, CONFIG_KEY_PREFIX, USER_KEY_PREFIX } = require('../projects/participation/policy');

const ADMIN = { id: 'olga', organizationId: 'org1', orgRole: 'org_admin' };
const MEMBER = { id: 'ann', organizationId: 'org1' };
const OUTSIDER = { id: 'zed', organizationId: 'org2' };

let blobs;
let writes;
let failing;
const policy = makePolicy({
    getConfig: async (key) => { if (failing) throw new Error('db down'); return blobs[key] ?? null; },
    setConfig: async (key, value) => { writes.push(key); blobs[key] = value; return true; },
    env: {},
});

const api = serve('/api/ai-participation', makeAiParticipationRouter({
    requireAuth: function requireAuth(req, res, next) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Unauthenticated' });
        return next();
    },
    resolveUserOrgIds: async (req) => new Set([req.session.user.organizationId]),
    isOrgAdmin: async (req, orgId) => req.session.user.orgRole === 'org_admin' && req.session.user.organizationId === orgId,
    policy,
}), { user: MEMBER });

after(() => api.close());
beforeEach(() => { blobs = {}; writes = []; failing = false; });

const SAVE = { autoAllowed: false, alwaysAllowed: true, commentsAutoAllowed: false, sensitivity: 'conservative', cooldownMinutes: 10 };

test('no session is 401; only members read, only admins write', async () => {
    assert.strictEqual((await api.call('GET', '/api/ai-participation/org/org1', { user: null })).status, 401);
    assert.strictEqual((await api.call('GET', '/api/ai-participation/me', { user: null })).status, 401);
    const outsider = await api.call('GET', '/api/ai-participation/org/org1', { user: OUTSIDER });
    assert.strictEqual(outsider.status, 403);
    assert.strictEqual(outsider.body.code, 'not_org_member');
    const member = await api.call('PUT', '/api/ai-participation/org/org1', { body: SAVE, user: MEMBER });
    assert.strictEqual(member.status, 403);
    assert.strictEqual(member.body.code, 'not_org_admin');
    assert.strictEqual((await api.call('PUT', '/api/ai-participation/org/org2', { body: SAVE, user: ADMIN })).status, 403, 'an admin of another org');
    assert.deepStrictEqual(writes, []);
});

test('an unconfigured org reads the defaults; a save round-trips, clamps, and applies at once', async () => {
    const fresh = await api.call('GET', '/api/ai-participation/org/org1');
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual(fresh.body.autoAllowed, true);
    assert.strictEqual(fresh.body.sensitivity, 'balanced');
    assert.strictEqual(fresh.body.configured, false);
    assert.deepStrictEqual(fresh.body.sensitivities, ['conservative', 'balanced', 'eager']);
    assert.ok(fresh.body.ranges.cooldownMinutes);

    // The engine read (and memoised) the default a moment ago.
    assert.strictEqual((await policy.resolveOrgPolicy('org1')).autoAllowed, true);
    const saved = await api.call('PUT', '/api/ai-participation/org/org1', { body: { ...SAVE, maxAutoPerChatHour: 999 }, user: ADMIN });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.autoAllowed, false);
    assert.strictEqual(saved.body.maxAutoPerChatHour, 30, 'clamped');
    assert.strictEqual(saved.body.configured, true);
    assert.strictEqual(blobs[`${CONFIG_KEY_PREFIX}org1`].updatedBy, 'olga');
    assert.strictEqual((await policy.resolveOrgPolicy('org1')).autoAllowed, false, 'the memo was dropped');
    const reread = await api.call('GET', '/api/ai-participation/org/org1');
    assert.strictEqual(reread.body.sensitivity, 'conservative');
    assert.strictEqual(reread.body.configured, true);
});

test('closed bodies: nothing is written for a typo, a missing switch or a string "false"', async () => {
    const put = (body) => api.call('PUT', '/api/ai-participation/org/org1', { body, user: ADMIN });
    assertRefused(assert, await put({ ...SAVE, autoAlowed: true }), 'body', /does not take "autoAlowed"/);
    assertRefused(assert, await put({ alwaysAllowed: true, commentsAutoAllowed: true }), 'body.autoAllowed', /autoAllowed is true or false/);
    assertRefused(assert, await put({ ...SAVE, sensitivity: 'reckless' }), 'body.sensitivity', /conservative, balanced, eager/);
    assertRefused(assert, await put({ ...SAVE, cooldownMinutes: 'ten' }), 'body.cooldownMinutes', /cooldownMinutes is a number/);
    assertRefused(assert, await api.call('PUT', '/api/ai-participation/me', { body: { autoJoinOnMyMessages: false, autoJoin: false } }), 'body', /does not take "autoJoin"/);
    assert.deepStrictEqual(writes, []);
});

test('a read failure is a 503, never the defaults shown as saved', async () => {
    failing = true;
    const org = await api.call('GET', '/api/ai-participation/org/org-down', { user: { id: 'dora', organizationId: 'org-down' } });
    assert.strictEqual(org.status, 503);
    assert.strictEqual(org.body.code, 'policy_unavailable');
    const me = await api.call('GET', '/api/ai-participation/me', { user: { id: 'down-user', organizationId: 'org1' } });
    assert.strictEqual(me.status, 503);
});

test('each person reads and changes only their own opt-out', async () => {
    assert.deepStrictEqual((await api.call('GET', '/api/ai-participation/me')).body, { autoJoinOnMyMessages: true });
    const off = await api.call('PUT', '/api/ai-participation/me', { body: { autoJoinOnMyMessages: false } });
    assert.deepStrictEqual(off.body, { autoJoinOnMyMessages: false });
    assert.deepStrictEqual(Object.keys(blobs), [`${USER_KEY_PREFIX}ann`]);
    assert.deepStrictEqual((await api.call('GET', '/api/ai-participation/me')).body, { autoJoinOnMyMessages: false });
    assert.deepStrictEqual((await api.call('GET', '/api/ai-participation/me', { user: ADMIN })).body, { autoJoinOnMyMessages: true },
        'somebody else\'s choice is theirs');
});
