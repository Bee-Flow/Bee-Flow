/**
 * PUT /organizations/:id/encryption (auth/admin/orgRoutes.js): switching an
 * organisation into the zk tier ends its members' sessions AND bridge tokens
 * (sessionCache.endSessionsForOrg), not only the cached sessions.
 * Run: cd server && node --test auth/admin/orgRoutes.zkSessions.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');

let orgTier = 'managed';
const ended = [];
const busted = [];

h.recordDb();
h.openGates({ isOrgAdminForOrg: async () => true });
// Shared objects the router requires lazily, patched in place.
const userStore = require('../../stores/userStore');
userStore.getOrganization = async (id) => ({ id, name: 'Acme', encryption_tier: orgTier });
userStore.updateOrganization = async () => true;
userStore.logAccessAudit = async () => {};
const availability = require('../../stores/encryptionAvailability');
availability.getEncryptionAvailability = async () => ({
    tiers: ['none', 'managed', 'zk'].map((tier) => ({ tier, selectable: true })),
});
const sessionCache = require('../sessionCache');
sessionCache.endSessionsForOrg = async (id) => { ended.push(id); return 0; };
sessionCache.bustSessionsForOrg = async (id) => { busted.push(id); return 0; };

const router = require('./orgRoutes');
const dispatch = h.dispatcher(router, { session: () => ({ user: { id: 'adm' } }) });

test.beforeEach(() => { orgTier = 'managed'; ended.length = 0; busted.length = 0; });

test('entering zk ends every session and bridge token of the org', async () => {
    const res = await dispatch({ method: 'PUT', url: '/organizations/orgA/encryption', body: { tier: 'zk' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(ended, ['orgA']);
    assert.deepStrictEqual(busted, [], 'the lighter cache bust alone leaves bridge tokens alive');
});

test('a change that does not enter zk ends nothing', async () => {
    orgTier = 'zk';
    const res = await dispatch({ method: 'PUT', url: '/organizations/orgA/encryption', body: { tier: 'zk' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(ended, []);
});
