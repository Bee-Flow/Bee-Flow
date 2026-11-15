/**
 * routes/orgAutomationImageAi.mts over a real Express app (routeHarness
 * serve()), with the gates and the store injected. No module mocking.
 *
 * Proven: no session 401; members read, only the org's admins change it;
 * an unconfigured org reads off; a closed body (a typo, the string "false")
 * is refused and nothing is written; a read failure is a 503.
 *
 * Run: cd server && node --test routes/orgAutomationImageAi.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { serve } = require('../testUtils/routeHarness');
const { makeOrgAutomationImageAiRouter } = require('./orgAutomationImageAi.mts');
const setting = require('../core/automationRunner/imageAiSetting.mts');

const ADMIN = { id: 'olga', organizationId: 'org1', orgRole: 'org_admin' };
const MEMBER = { id: 'ann', organizationId: 'org1' };
const OUTSIDER = { id: 'zed', organizationId: 'org2' };

let rows;
let failing;
const configStore = {
    getConfig: async (key) => { if (failing) throw new Error('db down'); return rows[key] ?? null; },
    setConfig: async (key, value) => { rows[key] = value; },
};
const store = {
    readImageAiSetting: (orgId) => setting.readImageAiSetting(orgId, configStore),
    saveImageAiSetting: (orgId, enabled, by) => setting.saveImageAiSetting(orgId, enabled, by, configStore),
};

const api = serve('/api/org-automation-image-ai', makeOrgAutomationImageAiRouter({
    requireAuth: function requireAuth(req, res, next) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Unauthenticated' });
        return next();
    },
    resolveUserOrgIds: async (req) => new Set([req.session.user.organizationId]),
    isOrgAdmin: async (req, orgId) => req.session.user.orgRole === 'org_admin' && req.session.user.organizationId === orgId,
    store,
}), { user: MEMBER });

after(() => api.close());
beforeEach(() => { rows = {}; failing = false; setting.invalidateImageAiSetting(); });

const URL = '/api/org-automation-image-ai/org1';

test('no session is 401; a stranger is 403; a member reads the default: off', async () => {
    assert.strictEqual((await api.call('GET', URL, { user: null })).status, 401);
    assert.strictEqual((await api.call('GET', URL, { user: OUTSIDER })).status, 403);
    const read = await api.call('GET', URL);
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(read.body, { enabled: false, configured: false });
});

test('only an admin of the organisation switches it; a member gets 403 and nothing is written', async () => {
    const refused = await api.call('PUT', URL, { body: { enabled: true } });
    assert.strictEqual(refused.status, 403);
    assert.deepStrictEqual(rows, {});
    const saved = await api.call('PUT', URL, { user: ADMIN, body: { enabled: true } });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body, { enabled: true, configured: true });
    assert.strictEqual((await api.call('GET', URL)).body.enabled, true);
});

test('a closed body: the string "false", a typo or no switch is a 400', async () => {
    for (const body of [{ enabled: 'false' }, { enable: true }, {}, { enabled: true, extra: 1 }]) {
        const r = await api.call('PUT', URL, { user: ADMIN, body });
        assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(rows, {});
});

test('a read failure is a 503, never a default shown as saved', async () => {
    failing = true;
    assert.strictEqual((await api.call('GET', URL)).status, 503);
});
