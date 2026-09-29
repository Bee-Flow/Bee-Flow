/**
 * Who a spreadsheet mirror talks to its storage as, and the gates in front
 * of it — each refusing with its own code: no linker, the integration off,
 * no Google/Microsoft credential, a linker moved out of the table's
 * organisation, a Nextcloud instance that changed, and the linker's Files
 * scope not covering the path (read before any fetch, write before any
 * PUT). A refusal is memoised for a minute like a success is.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/linkerAuth.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');

const calls = { checks: [], forLinker: [], credential: [] };
const world = {
    permitted: true,
    denial: null,
    session: { user: { id: 'u1', organizationId: 'org_1' } },
    auth: { baseUrl: 'http://nc', uid: 'alice', fetch: async () => ({}) },
    authThrows: false,
    org: { nc_instance_id: 'inst_1' },
    cred: { oauthProvider: 'google', accessToken: 'at' },
    credError: null,
};
const fakeApi = { probe: async () => ({}) };
const modules = {
    google_drive: { provider: 'google_drive', oauthProvider: 'google', integrationAppIds: ['google-drive'], forLinker: (cred, ctx) => { calls.forLinker.push({ provider: 'google_drive', cred, ctx }); return fakeApi; } },
    onedrive: { provider: 'onedrive', oauthProvider: 'microsoft', integrationAppIds: ['onedrive'], forLinker: (cred, ctx) => { calls.forLinker.push({ provider: 'onedrive', cred, ctx }); return fakeApi; } },
    nextcloud_files: { provider: 'nextcloud_files', oauthProvider: 'nextcloud', integrationAppIds: ['nextcloud'], forLinker: (cred, ctx) => { calls.forLinker.push({ provider: 'nextcloud_files', cred, ctx }); return fakeApi; } },
};
const restore = installResolveStub({
    '../../../automationRunner/sessionResolution': { resolveUserSession: async () => world.session },
    '../../../../integrations/nextcloudClient': { resolveAuth: async () => { if (world.authThrows) throw new Error('Nextcloud not connected'); return world.auth; } },
    '../../../integrations/integrationTools': { isIntegrationPermittedForUser: async () => world.permitted },
    '../../../integrations/ncScopeGuard': { checkToolCall: async (args) => { calls.checks.push(args); return world.denial; } },
    '../../../../stores/userStore': { getOrganization: async () => world.org },
    './credentials': {
        resolveProviderCredential: async (userId, provider, opts) => { calls.credential.push({ userId, provider, opts }); if (world.credError) throw world.credError; return world.cred; },
        forget: () => {},
    },
    './providers': { providerFor: (name) => { if (!modules[name]) throw new Error('unknown'); return modules[name]; } },
});
const linkerAuth = require('./linkerAuth');
const { SpreadsheetSourceError } = require('./errors');
test.after(() => restore());
test.beforeEach(() => {
    linkerAuth._memo.clear();
    calls.checks.length = 0; calls.forLinker.length = 0; calls.credential.length = 0;
    Object.assign(world, {
        permitted: true, denial: null, session: { user: { id: 'u1', organizationId: 'org_1' } },
        auth: { baseUrl: 'http://nc', uid: 'alice', fetch: async () => ({}) }, authThrows: false,
        org: { nc_instance_id: 'inst_1' }, cred: { oauthProvider: 'google', accessToken: 'at' }, credError: null,
    });
});

const gd = { provider: 'google_drive', linkedByUserId: 'u1', file: { id: 'f1' } };
const od = { provider: 'onedrive', linkedByUserId: 'u1', file: { id: 'i1', driveId: 'd1' } };
const nc = { provider: 'nextcloud_files', linkedByUserId: 'u1', ncInstanceId: 'inst_1', file: { id: '42', path: '/Documents/Facturen.xlsx' } };

test('Google: integration gate, then the credential resolver, then the provider\'s linker api', async () => {
    const r = await linkerAuth.resolveLinker(gd, { orgId: 'org_1' });
    assert.equal(r.userId, 'u1');
    assert.strictEqual(r.api, fakeApi);
    assert.strictEqual(r.cred, world.cred);
    assert.deepEqual(calls.credential, [{ userId: 'u1', provider: 'google', opts: { session: world.session, orgId: 'org_1', fresh: false } }]);
    assert.equal(calls.forLinker[0].provider, 'google_drive');
    assert.deepEqual(calls.forLinker[0].ctx, { userId: 'u1', orgId: 'org_1', session: world.session });
    assert.equal(calls.checks.length, 0, 'no Nextcloud scope check for a Drive file');
});

test('OneDrive asks for the microsoft credential', async () => {
    await linkerAuth.resolveLinker(od, { orgId: null });
    assert.equal(calls.credential[0].provider, 'microsoft');
});

test('each gate refuses with its own code', async () => {
    await assert.rejects(() => linkerAuth.resolveLinker({ provider: 'google_drive', file: { id: 'x' } }), (e) => e.code === 'linker_unavailable' && e.status === 503);
    assert.equal(calls.credential.length, 0);

    world.permitted = false;
    await assert.rejects(() => linkerAuth.resolveLinker(gd, { orgId: 'org_1' }), (e) => e.code === 'provider_integration_off' && e.status === 403 && /Google Drive/.test(e.message));
    assert.equal(calls.credential.length, 0, 'the credential is not touched when the integration is off');

    linkerAuth._memo.clear(); world.permitted = true;
    world.credError = new SpreadsheetSourceError(403, 'provider_not_connected', 'not connected');
    await assert.rejects(() => linkerAuth.resolveLinker(gd, { orgId: 'org_1' }), (e) => e.code === 'provider_not_connected');
    assert.equal(calls.forLinker.length, 0);

    linkerAuth._memo.clear();
    await assert.rejects(() => linkerAuth.resolveLinker({ provider: 'dropbox', linkedByUserId: 'u1', file: {} }), (e) => e.code === 'spreadsheet_rejected');
});

test('Nextcloud: instance check, read scope via nextcloud_read_file with the PATH, then resolveAuth', async () => {
    const r = await linkerAuth.resolveLinker(nc, { orgId: 'org_1' });
    assert.strictEqual(r.cred, world.auth);
    assert.strictEqual(r.api, fakeApi);
    assert.deepEqual(calls.checks, [{ toolName: 'nextcloud_read_file', toolArgs: { path: '/Documents/Facturen.xlsx' }, userId: 'u1', orgId: 'org_1' }]);
    assert.equal(calls.credential.length, 0, 'no OAuth credential resolver for Nextcloud');
    assert.equal(calls.forLinker[0].provider, 'nextcloud_files');
});

test('Nextcloud gates: nc_instance_changed, nc_scope_denied before any auth, linker_unavailable without a session or connection', async () => {
    world.org = { nc_instance_id: 'other' };
    await assert.rejects(() => linkerAuth.resolveLinker(nc, { orgId: 'org_1' }), (e) => e.code === 'nc_instance_changed' && e.status === 503);
    assert.equal(calls.checks.length, 0);

    linkerAuth._memo.clear(); world.org = { nc_instance_id: 'inst_1' }; world.denial = { error: 'outside', nc_scope_denied: true };
    await assert.rejects(() => linkerAuth.resolveLinker(nc, { orgId: 'org_1' }), (e) => e.code === 'nc_scope_denied' && e.status === 403 && e.ref.path === '/Documents/Facturen.xlsx' && e.ref.fileId === '/Documents/Facturen.xlsx');
    assert.equal(calls.forLinker.length, 0, 'a denied scope never builds an api');

    linkerAuth._memo.clear(); world.denial = null; world.session = null;
    await assert.rejects(() => linkerAuth.resolveLinker(nc, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable');

    linkerAuth._memo.clear(); world.session = { user: { id: 'u1' } }; world.authThrows = true;
    await assert.rejects(() => linkerAuth.resolveLinker(nc, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable');

    linkerAuth._memo.clear(); world.authThrows = false; world.auth = { authError: 'no connection' };
    await assert.rejects(() => linkerAuth.resolveLinker(nc, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable' && /no connection/.test(e.message));
});

test('a linker moved to another organisation is refused before any scope check or auth — the connector call would route on THEIR org, not the table\'s', async () => {
    // The table's org (org_1) still has its instance; the linker's rebuilt
    // session now says org_2 — resolveAuth → resolveNcBinding would take
    // org_2's connector and read org_2's file at the same path.
    world.session = { user: { id: 'u1', organizationId: 'org_2' }, connectorOrgId: 'org_2' };
    await assert.rejects(() => linkerAuth.resolveLinker(nc, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable' && e.status === 503 && /another organisation/.test(e.message));
    assert.equal(calls.checks.length, 0, 'no scope check');
    assert.equal(calls.forLinker.length, 0, 'no api');
    // the user row alone (no connector org on the session) is enough to tell
    linkerAuth._memo.clear();
    world.session = { user: { id: 'u1', organizationId: 'org_2' } };
    await assert.rejects(() => linkerAuth.resolveLinker(nc, { orgId: 'org_1' }), (e) => e.code === 'linker_unavailable');
    // the same org, spelled either way, passes
    linkerAuth._memo.clear();
    world.session = { user: { id: 'u1', organizationId: 'org_1' }, connectorOrgId: 'org_1' };
    assert.strictEqual((await linkerAuth.resolveLinker(nc, { orgId: 'org_1' })).api, fakeApi);
    // a Drive mirror is not gated on this: its credential is the linker's own vault row, not an org binding
    linkerAuth._memo.clear();
    world.session = { user: { id: 'u1', organizationId: 'org_2' } };
    assert.strictEqual((await linkerAuth.resolveLinker(gd, { orgId: 'org_1' })).api, fakeApi);
});

test('a personal Nextcloud mirror (no orgId) takes the scope org from the session and skips the instance check', async () => {
    world.session = { user: { id: 'u1', organizationId: 'org_s' }, connectorOrgId: 'org_c' };
    await linkerAuth.resolveLinker(nc, { orgId: null });
    assert.equal(calls.checks[0].orgId, 'org_c');
});

test('write:true runs the nextcloud_upload_file gate on every call, on top of the memoised read answer', async () => {
    await linkerAuth.resolveLinker(nc, { orgId: 'org_1' });
    assert.equal(calls.checks.length, 1);
    await linkerAuth.resolveLinker(nc, { orgId: 'org_1', write: true });
    assert.equal(calls.checks.length, 2, 'the read answer came from the memo; only the write gate ran');
    assert.equal(calls.checks[1].toolName, 'nextcloud_upload_file');
    assert.deepEqual(calls.checks[1].toolArgs, { path: '/Documents/Facturen.xlsx' });
    world.denial = { error: 'read-only', nc_scope_denied: true };
    await assert.rejects(() => linkerAuth.resolveLinker(nc, { orgId: 'org_1', write: true }), (e) => e.code === 'nc_scope_denied' && /writing/.test(e.message));
    const again = await linkerAuth.resolveLinker(nc, { orgId: 'org_1' });
    assert.strictEqual(again.api, fakeApi, 'reads still answer from the memo');
    await linkerAuth.resolveLinker(gd, { orgId: 'org_1', write: true });
    assert.equal(calls.checks.filter((c) => c.toolName === 'nextcloud_upload_file').length, 2, 'the write gate is a no-op for Drive');
});

test('the answer is memoised for a minute per linker+file, refusals too, and forget() clears it', async () => {
    const first = await linkerAuth.resolveLinker(gd, { orgId: 'org_1' });
    world.permitted = false;
    const again = await linkerAuth.resolveLinker(gd, { orgId: 'org_1' });
    assert.strictEqual(again, first);
    await assert.rejects(() => linkerAuth.resolveLinker(gd, { orgId: 'org_1', fresh: true }), (e) => e.code === 'provider_integration_off');
    world.permitted = true;
    await assert.rejects(() => linkerAuth.resolveLinker(gd, { orgId: 'org_1' }), (e) => e.code === 'provider_integration_off');
    linkerAuth.forget('u1');
    const third = await linkerAuth.resolveLinker(gd, { orgId: 'org_1' });
    assert.equal(third.userId, 'u1');
    // A second file of the same linker is its own entry (its own scope).
    await linkerAuth.resolveLinker({ ...nc, file: { id: '43', path: '/Other/x.csv' } }, { orgId: 'org_1' });
    assert.equal(calls.checks.at(-1).toolArgs.path, '/Other/x.csv');
});
