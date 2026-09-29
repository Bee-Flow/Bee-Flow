/**
 * Who a mirror talks to Nextcloud as, and the three gates in front of it:
 * a non-Nextcloud org, the Tables integration switched off, and the linker's
 * own scope not covering the table each refuse with their own code — and a
 * refusal is memoised for a minute like a success is. A linker whose session
 * now routes on ANOTHER organisation is refused too: the table's org would
 * pass the instance check while the call went to the other tenant.
 *
 * Run: cd server && node --test core/dataEngine/sources/nextcloudTable/linkerAuth.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');

const world = { ncOrg: true, permitted: true, denial: null, session: { user: { id: 'u1' } }, auth: { baseUrl: 'http://nc', fetch: async () => ({}) }, org: { nc_instance_id: 'inst_1' } };
const restore = installResolveStub({
    '../../../automationRunner/sessionResolution': { resolveUserSession: async () => world.session },
    '../../../../integrations/nextcloudClient': { resolveAuth: async () => world.auth },
    '../../../../auth/ncAudience': { isNcOrg: async () => world.ncOrg },
    '../../../integrations/integrationTools': { isIntegrationPermittedForUser: async () => world.permitted },
    '../../../integrations/ncScopeGuard': { checkToolCall: async () => world.denial },
    '../../../../stores/userStore': { getOrganization: async () => world.org },
});
const linkerAuth = require('./linkerAuth');
test.after(() => restore());
test.beforeEach(() => { linkerAuth._memo.clear(); Object.assign(world, { ncOrg: true, permitted: true, denial: null, session: { user: { id: 'u1' } }, auth: { baseUrl: 'http://nc', fetch: async () => ({}) }, org: { nc_instance_id: 'inst_1' } }); });

const source = { linkedByUserId: 'u1', ncTableId: 4, ncInstanceId: 'inst_1' };

test('resolves the linker\'s auth when every gate passes, and memoises it', async () => {
    const r = await linkerAuth.resolveLinker(source, { orgId: 'org_1' });
    assert.equal(r.userId, 'u1');
    assert.equal(r.auth.baseUrl, 'http://nc');
    world.ncOrg = false;                       // would refuse now — but the memo answers
    const again = await linkerAuth.resolveLinker(source, { orgId: 'org_1' });
    assert.equal(again.auth.baseUrl, 'http://nc');
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1', fresh: true }), (e) => e.code === 'not_nc_org');
});

test('each gate refuses with its own code', async () => {
    world.ncOrg = false;
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'not_nc_org' && e.status === 403);
    linkerAuth._memo.clear(); world.ncOrg = true; world.org = { nc_instance_id: 'other' };
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'nc_instance_changed' && e.status === 503);
    linkerAuth._memo.clear(); world.org = { nc_instance_id: 'inst_1' }; world.permitted = false;
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'nextcloud_integration_off');
    linkerAuth._memo.clear(); world.permitted = true; world.denial = { error: 'x', nc_scope_denied: true };
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'nc_scope_denied' && e.ncTableId === 4);
    linkerAuth._memo.clear(); world.denial = null; world.session = null;
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable');
    linkerAuth._memo.clear(); world.session = { user: { id: 'u1' } }; world.auth = { authError: 'no connection' };
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable' && /no connection/.test(e.message));
});

test('a linker moved to another connector-bound organisation is refused, whatever the table\'s org says about its instance', async () => {
    // The table's org is still bound to inst_1 — but the linker's session now
    // routes on org_2 (connectorOrgId), so resolveAuth would reach org_2's
    // Nextcloud and read ITS table 4 into this one.
    world.session = { user: { id: 'u1', organizationId: 'org_1' }, connectorOrgId: 'org_2' };
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable' && e.status === 503 && /another organisation/.test(e.message));
    // the user row alone says so as well
    linkerAuth._memo.clear();
    world.session = { user: { id: 'u1', organizationId: 'org_2' } };
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable' && /another organisation/.test(e.message));
    // the same org: fine; a personal mirror (no org) and a session without an org are never refused for this
    linkerAuth._memo.clear();
    world.session = { user: { id: 'u1', organizationId: 'org_1' }, connectorOrgId: 'org_1' };
    assert.equal((await linkerAuth.resolveLinker(source, { orgId: 'org_1' })).userId, 'u1');
    linkerAuth._memo.clear();
    world.session = { user: { id: 'u1', organizationId: 'org_2' } };
    assert.equal((await linkerAuth.resolveLinker(source, { orgId: null })).userId, 'u1');
    linkerAuth._memo.clear();
    world.session = { user: { id: 'u1' } };
    assert.equal((await linkerAuth.resolveLinker(source, { orgId: 'org_1' })).userId, 'u1');
});

test('a refusal is memoised for the minute too, and forget() clears it', async () => {
    world.permitted = false;
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }));
    world.permitted = true;
    await assert.rejects(() => linkerAuth.resolveLinker(source, { orgId: 'org_1' }), (e) => e.code === 'nextcloud_integration_off');
    linkerAuth.forget('u1');
    const r = await linkerAuth.resolveLinker(source, { orgId: 'org_1' });
    assert.equal(r.userId, 'u1');
});

test('a source with no linker at all is refused without touching anything', async () => {
    await assert.rejects(() => linkerAuth.resolveLinker({ ncTableId: 4 }, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable');
});
