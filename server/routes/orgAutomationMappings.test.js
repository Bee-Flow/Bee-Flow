/**
 * routes/orgAutomationMappings.js over a real Express app (routeHarness
 * serve()), with the gates and the config store injected through
 * makeOrgAutomationMappingsRouter and the real settings module on top. No
 * module mocking.
 *
 * Proven:
 *   - no session 401; members read the setting, only the org's admins change it;
 *   - an unconfigured org reads OFF and `configured: false`; a stored row that
 *     is not a literal true reads OFF;
 *   - switching on is stored and applies at once (the memo is dropped);
 *   - closed body: a typo, a missing switch or the string "true" is refused
 *     and nothing is written;
 *   - a read failure is a 503 on the screen, and OFF for the builder.
 *
 * Run: cd server && node --test routes/orgAutomationMappings.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { serve, assertRefused } = require('../core/http/routeHarness');
const { makeOrgAutomationMappingsRouter } = require('./orgAutomationMappings');
const mappingSettings = require('../automation/mappingSettings');

const ADMIN = { id: 'olga', organizationId: 'org1', orgRole: 'org_admin' };
const MEMBER = { id: 'ann', organizationId: 'org1' };
const OUTSIDER = { id: 'zed', organizationId: 'org2' };
const KEY = `${mappingSettings.CONFIG_KEY_PREFIX}org1`;

let blobs;
let writes;
let failing;
const configStore = {
    getConfig: async (key) => { if (failing) throw new Error('db down'); return blobs[key] ?? null; },
    setConfig: async (key, value) => { writes.push(key); blobs[key] = value; return true; },
};
const engine = mappingSettings.makeMappingSettings({ configStore });
const settings = { ...mappingSettings, ...engine };

const api = serve('/api/org-automation-mappings', makeOrgAutomationMappingsRouter({
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
    blobs = {}; writes = []; failing = false;
    mappingSettings.invalidateMappingSettings();
});

test('no session is 401; only members read, only admins write', async () => {
    assert.strictEqual((await api.call('GET', '/api/org-automation-mappings/org1', { user: null })).status, 401);
    const outsider = await api.call('GET', '/api/org-automation-mappings/org1', { user: OUTSIDER });
    assert.strictEqual(outsider.status, 403);
    assert.strictEqual(outsider.body.code, 'not_org_member');
    const member = await api.call('PUT', '/api/org-automation-mappings/org1', { body: { autoUpgradeOnOpen: true }, user: MEMBER });
    assert.strictEqual(member.status, 403);
    assert.strictEqual(member.body.code, 'not_org_admin');
    const otherAdmin = await api.call('PUT', '/api/org-automation-mappings/org2', { body: { autoUpgradeOnOpen: true }, user: ADMIN });
    assert.strictEqual(otherAdmin.status, 403, 'an admin of another org');
    assert.deepStrictEqual(writes, []);
});

test('off by default; switching on is stored and applies at once', async () => {
    const fresh = await api.call('GET', '/api/org-automation-mappings/org1');
    assert.deepStrictEqual(fresh.body, { autoUpgradeOnOpen: false, configured: false });
    assert.deepStrictEqual(await engine.readMappingSettings('org1'), { autoUpgradeOnOpen: false }, 'read, and memoised');

    const on = await api.call('PUT', '/api/org-automation-mappings/org1', { body: { autoUpgradeOnOpen: true }, user: ADMIN });
    assert.strictEqual(on.status, 200);
    assert.deepStrictEqual(on.body, { autoUpgradeOnOpen: true, configured: true });
    assert.strictEqual(blobs[KEY].autoUpgradeOnOpen, true);
    assert.strictEqual(blobs[KEY].updatedBy, 'olga');
    assert.deepStrictEqual(await engine.readMappingSettings('org1'), { autoUpgradeOnOpen: true }, 'the memo was dropped');
    assert.deepStrictEqual((await api.call('GET', '/api/org-automation-mappings/org1')).body, { autoUpgradeOnOpen: true, configured: true });

    // A personal automation has no organisation to have decided: off.
    assert.deepStrictEqual(await engine.readMappingSettings(null), { autoUpgradeOnOpen: false });
});

test('only a literal true is on, also in a stored row', async () => {
    blobs[KEY] = { autoUpgradeOnOpen: 'true' };
    assert.deepStrictEqual((await api.call('GET', '/api/org-automation-mappings/org1')).body, { autoUpgradeOnOpen: false, configured: true });
    assert.deepStrictEqual(await engine.readMappingSettings('org1'), { autoUpgradeOnOpen: false });
});

test('closed body: nothing is written for a typo, a missing switch or a string "true"', async () => {
    const put = (body) => api.call('PUT', '/api/org-automation-mappings/org1', { body, user: ADMIN });
    assertRefused(assert, await put({ autoUpgradeOnOpen: true, autoUpgrade: true }), 'body', /does not take "autoUpgrade"/);
    assertRefused(assert, await put({}), 'body.autoUpgradeOnOpen', /autoUpgradeOnOpen is true or false/);
    assertRefused(assert, await put({ autoUpgradeOnOpen: 'true' }), 'body.autoUpgradeOnOpen', /autoUpgradeOnOpen is true or false/);
    assert.deepStrictEqual(writes, []);
});

test('a read failure: 503 on the screen, off for the builder', async () => {
    failing = true;
    const down = await api.call('GET', '/api/org-automation-mappings/org1');
    assert.strictEqual(down.status, 503);
    assert.strictEqual(down.body.code, 'mapping_settings_unavailable');
    assert.deepStrictEqual(await engine.readMappingSettings('org1'), { autoUpgradeOnOpen: false });
});
