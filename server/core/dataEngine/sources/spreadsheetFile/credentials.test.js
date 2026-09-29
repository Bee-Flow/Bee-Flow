/**
 * As whom a spreadsheet mirror talks to Google or Microsoft: the vault first,
 * a session-shaped source second (provider-exact — a Microsoft token is never
 * handed to Google), copied INTO the vault under the per-user scope for an
 * org-less account, rotated tokens persisted through save(), refusals with
 * the vault's own reason, and a one-minute memo that forget() clears.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/credentials.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');

const world = { vault: null, vaultRow: null, session: null, upserts: [], user: { id: 'u1', organizationId: 'org_1' } };
const restore = installResolveStub({
    '../../../../auth/routineAuth': {
        getProviderAuth: async (userId, provider) => (world.vault && world.vault.provider === provider ? world.vault : null),
        vaultOrgIdFor: (u) => u?.organizationId || `user:${u?.id}`,
    },
    '../../../automationRunner/sessionResolution': { resolveUserSession: async () => world.session },
    '../../../../stores/routineCredentialStore': {
        upsertCredential: async (row) => { world.upserts.push(row); },
        getCredential: async (userId, provider) => (world.vaultRow && world.vaultRow.provider === provider ? world.vaultRow : null),
    },
    '../../../../stores/userStore': { getUser: async () => world.user },
});
const credentials = require('./credentials');
test.after(() => restore());
test.beforeEach(() => {
    credentials._memo.clear();
    Object.assign(world, { vault: null, vaultRow: null, session: null, upserts: [], user: { id: 'u1', organizationId: 'org_1' } });
});

test('the vault answers first, and the shim carries its tokens under the provider asked for', async () => {
    world.vault = { provider: 'google', userId: 'u1', orgId: 'org_1', accessToken: 'g_at', refreshToken: 'g_rt', expiresAt: Date.now() + 3600e3, scope: 'drive' };
    world.session = { oauthProvider: 'microsoft', accessToken: 'ms_at' };   // must be ignored
    const shim = await credentials.resolveProviderCredential('u1', 'google', { session: world.session });
    assert.equal(shim.oauthProvider, 'google');
    assert.equal(shim.accessToken, 'g_at');
    assert.equal(shim.refreshToken, 'g_rt');
    assert.equal(shim.oauthScope, 'drive');
    assert.equal(typeof shim.save, 'function');
    assert.equal(world.upserts.length, 0, 'a vault hit is not re-written');
});

test('session fallback takes the primary tokens ONLY when oauthProvider matches, else routineProviders[provider]', async () => {
    world.session = { oauthProvider: 'microsoft', accessToken: 'ms_at', refreshToken: 'ms_rt', routineProviders: { google: { accessToken: 'g_at2', refreshToken: 'g_rt2', expiresAt: 5 } } };
    const g = await credentials.resolveProviderCredential('u1', 'google', { session: world.session });
    assert.equal(g.accessToken, 'g_at2', 'google came from routineProviders, never the Microsoft primary');
    credentials._memo.clear();
    const m = await credentials.resolveProviderCredential('u1', 'microsoft', { session: world.session });
    assert.equal(m.accessToken, 'ms_at');
    assert.equal(m.oauthProvider, 'microsoft');
});

test('a session whose only tokens belong to the other provider is a refusal, not a borrowed token', async () => {
    world.session = { oauthProvider: 'microsoft', accessToken: 'ms_at' };
    await assert.rejects(() => credentials.resolveProviderCredential('u1', 'google', { session: world.session }),
        (e) => e.code === 'provider_not_connected' && e.status === 403 && e.safe === true);
    assert.equal(world.upserts.length, 0);
});

test('session tokens are copied into the vault — per-user scope for an org-less account', async () => {
    world.user = { id: 'u1', organizationId: null };
    world.session = { oauthProvider: 'google', accessToken: 'g_at', refreshToken: 'g_rt', expiresAt: 123, oauthScope: 'drive sheets', user: { id: 'u1' } };
    const shim = await credentials.resolveProviderCredential('u1', 'google', { session: world.session });
    assert.equal(shim.accessToken, 'g_at');
    assert.equal(world.upserts.length, 1);
    assert.deepEqual(world.upserts[0], { userId: 'u1', orgId: 'user:u1', provider: 'google', accessToken: 'g_at', refreshToken: 'g_rt', expiresAt: 123, scope: 'drive sheets' });
});

test('an org member\'s copy lands under the org scope', async () => {
    world.session = { oauthProvider: 'google', accessToken: 'g_at' };
    await credentials.resolveProviderCredential('u1', 'google', { session: world.session });
    assert.equal(world.upserts[0].orgId, 'org_1');
});

test('without a caller session the runner\'s rebuilt session is the source', async () => {
    world.session = { oauthProvider: 'google', accessToken: 'g_at', routineProviders: {} };
    const shim = await credentials.resolveProviderCredential('u1', 'google');
    assert.equal(shim.accessToken, 'g_at');
});

test('save() persists rotated tokens (what the Google tokens event and the Graph refresh call) and skips when nothing rotated', async () => {
    world.vault = { provider: 'microsoft', userId: 'u1', orgId: 'org_1', accessToken: 'ms_at', refreshToken: 'ms_rt', expiresAt: Date.now() + 3600e3, scope: 'files' };
    const shim = await credentials.resolveProviderCredential('u1', 'microsoft');
    await shim.save();
    assert.equal(world.upserts.length, 0, 'unchanged tokens are not re-written');
    shim.accessToken = 'ms_at_new';
    shim.refreshToken = 'ms_rt_new';
    const before = Date.now();
    await shim.save();
    assert.equal(world.upserts.length, 1);
    const row = world.upserts[0];
    assert.equal(row.provider, 'microsoft');
    assert.equal(row.orgId, 'org_1');
    assert.equal(row.accessToken, 'ms_at_new');
    assert.equal(row.refreshToken, 'ms_rt_new');
    assert.ok(row.expiresAt >= before + credentials.ASSUMED_TOKEN_LIFETIME_MS - 1000, 'an unknown new expiry is assumed, never left null');
    await shim.save();
    assert.equal(world.upserts.length, 1, 'a second save with the same tokens is a no-op');
});

test('save() never throws into the SDK event handler', async () => {
    world.vault = { provider: 'google', userId: 'u1', orgId: 'org_1', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600e3 };
    const shim = await credentials.resolveProviderCredential('u1', 'google');
    const store = require('../../../../stores/routineCredentialStore');
    const original = store.upsertCredential;
    store.upsertCredential = async () => { throw new Error('db down'); };
    try {
        shim.accessToken = 'b';
        await assert.doesNotReject(() => shim.save());
    } finally {
        store.upsertCredential = original;
    }
});

test('needs_reauth in the vault is named in the refusal', async () => {
    world.vaultRow = { provider: 'google', status: 'needs_reauth' };
    await assert.rejects(() => credentials.resolveProviderCredential('u1', 'google'),
        (e) => e.code === 'provider_not_connected' && e.detail === 'needs_reauth' && /reconnect/i.test(e.message));
});

test('the answer is memoised for a minute, refusals too, and forget() clears it', async () => {
    world.session = { oauthProvider: 'google', accessToken: 'g_at' };
    const first = await credentials.resolveProviderCredential('u1', 'google', { session: world.session });
    world.session = null;
    const again = await credentials.resolveProviderCredential('u1', 'google');
    assert.strictEqual(again, first, 'same shim object from the memo');
    await assert.rejects(() => credentials.resolveProviderCredential('u1', 'google', { fresh: true }), (e) => e.code === 'provider_not_connected');
    world.session = { oauthProvider: 'google', accessToken: 'g_at3' };
    await assert.rejects(() => credentials.resolveProviderCredential('u1', 'google'), 'the refusal is memoised');
    credentials.forget('u1');
    const third = await credentials.resolveProviderCredential('u1', 'google', { session: world.session });
    assert.equal(third.accessToken, 'g_at3');
});

test('an unknown provider is refused before anything is read', async () => {
    await assert.rejects(() => credentials.resolveProviderCredential('u1', 'nextcloud'), (e) => e.code === 'spreadsheet_rejected');
});

test('cheapStatus reads one vault row or the session and never refreshes', async () => {
    assert.deepEqual(await credentials.cheapStatus('u1', 'google'), { connected: false, reason: 'not_connected' });
    world.vaultRow = { provider: 'google', status: 'needs_reauth' };
    assert.deepEqual(await credentials.cheapStatus('u1', 'google'), { connected: false, reason: 'needs_reauth' });
    world.vaultRow = { provider: 'google', status: 'active', refreshToken: 'r' };
    assert.deepEqual(await credentials.cheapStatus('u1', 'google'), { connected: true, reason: null });
    world.vaultRow = null;
    assert.deepEqual(await credentials.cheapStatus('u1', 'microsoft', { session: { oauthProvider: 'microsoft', accessToken: 'x' } }), { connected: true, reason: null });
    assert.deepEqual(await credentials.cheapStatus('u1', 'google', { session: { oauthProvider: 'microsoft', accessToken: 'x' } }), { connected: false, reason: 'not_connected' });
});
