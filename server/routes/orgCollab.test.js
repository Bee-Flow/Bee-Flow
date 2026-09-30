/**
 * routes/orgCollab.js over a real Express app (routeHarness serve()), with the
 * gates and the config store injected through makeOrgCollabRouter and the real
 * co-editing settings module on top. No module mocking.
 *
 * Proven:
 *   - no session 401; members read the switch, only the org's admins change it;
 *   - an unconfigured org reads "on" and `configured: false`;
 *   - switching off is stored, applies at once (the memo is dropped) and folds
 *     the organisation's co-edited documents back, in the background;
 *   - closed body: a typo, a missing switch or the string "false" is refused
 *     and nothing is written;
 *   - the operator's kill switch is reported, and a read failure is a 503.
 *
 * Run: cd server && node --test routes/orgCollab.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { serve, assertRefused } = require('../core/http/routeHarness');
const { makeOrgCollabRouter } = require('./orgCollab');
const collabSettings = require('../core/collab/settings');

const ADMIN = { id: 'olga', organizationId: 'org1', orgRole: 'org_admin' };
const MEMBER = { id: 'ann', organizationId: 'org1' };
const OUTSIDER = { id: 'zed', organizationId: 'org2' };

let blobs;
let writes;
let failing;
let detached;
const env = {};
const configStore = {
    getConfig: async (key) => { if (failing) throw new Error('db down'); return blobs[key] ?? null; },
    setConfig: async (key, value) => { writes.push(key); blobs[key] = value; return true; },
};
const engine = collabSettings.makeCollabSettings({
    configStore,
    env,
    detachOrganisation: async (orgId) => { detached.push(orgId); return { failed: 0 }; },
});
const settings = { ...collabSettings, ...engine, killSwitchOn: () => collabSettings.killSwitchOn(env) };

const api = serve('/api/org-collab', makeOrgCollabRouter({
    requireAuth: function requireAuth(req, res, next) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Unauthenticated' });
        return next();
    },
    resolveUserOrgIds: async (req) => new Set([req.session.user.organizationId]),
    isOrgAdmin: async (req, orgId) => req.session.user.orgRole === 'org_admin' && req.session.user.organizationId === orgId,
    settings,
    getConfig: configStore.getConfig,
}), { user: MEMBER });

after(() => api.close());
beforeEach(() => {
    blobs = {}; writes = []; failing = false; detached = [];
    delete env.COLLAB_ENABLED;
    collabSettings.invalidateCollabSettings();
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('no session is 401; only members read, only admins write', async () => {
    assert.strictEqual((await api.call('GET', '/api/org-collab/org1', { user: null })).status, 401);
    const outsider = await api.call('GET', '/api/org-collab/org1', { user: OUTSIDER });
    assert.strictEqual(outsider.status, 403);
    assert.strictEqual(outsider.body.code, 'not_org_member');
    const member = await api.call('PUT', '/api/org-collab/org1', { body: { collabEnabled: false }, user: MEMBER });
    assert.strictEqual(member.status, 403);
    assert.strictEqual(member.body.code, 'not_org_admin');
    const otherAdmin = await api.call('PUT', '/api/org-collab/org2', { body: { collabEnabled: false }, user: ADMIN });
    assert.strictEqual(otherAdmin.status, 403, 'an admin of another org');
    assert.deepStrictEqual(writes, []);
});

test('an unconfigured org reads "on"; switching off is stored, applies at once and folds documents back', async () => {
    const fresh = await api.call('GET', '/api/org-collab/org1');
    assert.strictEqual(fresh.status, 200);
    assert.deepStrictEqual(fresh.body, { collabEnabled: true, serverDisabled: false, configured: false });
    assert.strictEqual(await engine.isCollabEnabled('org1'), true, 'the engine read (and memoised) the default');

    const off = await api.call('PUT', '/api/org-collab/org1', { body: { collabEnabled: false }, user: ADMIN });
    assert.strictEqual(off.status, 200);
    assert.deepStrictEqual(off.body, { collabEnabled: false, serverDisabled: false, configured: true });
    assert.deepStrictEqual(blobs[`${collabSettings.CONFIG_KEY_PREFIX}org1`], { collab_enabled: false });
    assert.strictEqual(await engine.isCollabEnabled('org1'), false, 'the memo was dropped');
    await settle();
    assert.deepStrictEqual(detached, ['org1'], 'the co-edited documents are folded back once');

    const reread = await api.call('GET', '/api/org-collab/org1');
    assert.deepStrictEqual(reread.body, { collabEnabled: false, serverDisabled: false, configured: true });

    const on = await api.call('PUT', '/api/org-collab/org1', { body: { collabEnabled: true }, user: ADMIN });
    assert.strictEqual(on.body.collabEnabled, true);
    await settle();
    assert.deepStrictEqual(detached, ['org1'], 'switching on folds nothing back');
});

test('closed body: nothing is written for a typo, a missing switch or a string "false"', async () => {
    const put = (body) => api.call('PUT', '/api/org-collab/org1', { body, user: ADMIN });
    assertRefused(assert, await put({ collabEnabled: false, colabEnabled: false }), 'body', /does not take "colabEnabled"/);
    assertRefused(assert, await put({}), 'body.collabEnabled', /collabEnabled is true or false/);
    assertRefused(assert, await put({ collabEnabled: 'false' }), 'body.collabEnabled', /collabEnabled is true or false/);
    assert.deepStrictEqual(writes, []);
});

test('the operator kill switch is reported; a read failure is a 503, never the default shown as saved', async () => {
    env.COLLAB_ENABLED = '0';
    const killed = await api.call('GET', '/api/org-collab/org1');
    assert.deepStrictEqual(killed.body, { collabEnabled: true, serverDisabled: true, configured: false });

    failing = true;
    const down = await api.call('GET', '/api/org-collab/org1');
    assert.strictEqual(down.status, 503);
    assert.strictEqual(down.body.code, 'collab_settings_unavailable');
});
