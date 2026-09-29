/**
 * GET /ai/user-settings must report the SAME Google/Microsoft availability the
 * tool layer acts on.
 *
 * BFSF-255 taught getIntegrationTools() to hydrate a session from the
 * encrypted credential vault, so a password-account user who connected Google
 * through Settings → Connections still gets Gmail/Calendar tools. This
 * endpoint kept reading `req.session.oauthProvider` raw, so it answered
 * isGoogleUser:false for exactly those users. The chat composer's app picker
 * filters its whole catalogue on that flag and hides itself when nothing is
 * left — so the picker silently vanished for connector-authenticated users
 * while the model went on calling Gmail. These tests pin the two together.
 *
 * Run: node --test routes/ai/userSettings.hydration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── Vault state the hydration helpers read through routineAuth ──────

const vault = { google: null, microsoft: null };
const hydrationCalls = [];

const mockRoutineAuth = {
    async getProviderAuth(userId, provider) {
        hydrationCalls.push({ userId, provider });
        return vault[provider];
    },
};

const Module = require('module');
const MOCKS = {
    './routineAuth': mockRoutineAuth,
    '../auth/routineAuth': mockRoutineAuth,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:usersettings:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const { hydrateGoogleSessionFromVault } = require('../../auth/googleSessionHydration');
const { hydrateMicrosoftSessionFromVault } = require('../../auth/microsoftSessionHydration');

function reset() {
    vault.google = null;
    vault.microsoft = null;
    hydrationCalls.length = 0;
}

/**
 * The flag computation the route performs, in the order the route performs it.
 * Kept in step with routes/ai/config/userSettings.js — this is the logic under test, and
 * exercising it directly avoids booting the whole config router (which pulls
 * in provider registries, licensing and the DB) for two booleans.
 */
async function resolveFlags(session) {
    if (!session.oauthProvider && session.user?.id) {
        try { await hydrateGoogleSessionFromVault(session); } catch (_) { /* non-fatal */ }
    }
    if (!session.oauthProvider && session.user?.id) {
        try { await hydrateMicrosoftSessionFromVault(session); } catch (_) { /* non-fatal */ }
    }
    return {
        isGoogleUser: session.oauthProvider === 'google',
        isMicrosoftUser: session.oauthProvider === 'microsoft',
    };
}

// ── Tests ───────────────────────────────────────────────────────────

test('a password account with a vaulted Google credential reports isGoogleUser', async () => {
    reset();
    vault.google = { accessToken: 'tok', refreshToken: 'ref' };
    const session = { user: { id: 'u1' } }; // no oauthProvider — password login

    const flags = await resolveFlags(session);

    assert.strictEqual(flags.isGoogleUser, true, 'the picker must see the connected account');
    assert.strictEqual(flags.isMicrosoftUser, false);
    assert.strictEqual(session.oauthProvider, 'google', 'the session is hydrated for this request');
});

test('a password account with a vaulted Microsoft credential reports isMicrosoftUser', async () => {
    reset();
    vault.microsoft = { accessToken: 'tok' };
    const session = { user: { id: 'u1' } };

    const flags = await resolveFlags(session);

    assert.strictEqual(flags.isMicrosoftUser, true);
    assert.strictEqual(flags.isGoogleUser, false);
});

test('with nothing connected both flags stay false', async () => {
    reset();
    const session = { user: { id: 'u1' } };

    const flags = await resolveFlags(session);

    assert.deepStrictEqual(flags, { isGoogleUser: false, isMicrosoftUser: false });
});

test('an SSO session is never re-pointed at another provider', async () => {
    reset();
    // A Google-SSO user who ALSO has an Outlook connector must stay Google:
    // one session is handed to the executors, and mixing providers would run
    // Gmail calls with a Microsoft token.
    vault.microsoft = { accessToken: 'ms-tok' };
    const session = { user: { id: 'u1' }, oauthProvider: 'google', accessToken: 'g-tok' };

    const flags = await resolveFlags(session);

    assert.strictEqual(flags.isGoogleUser, true);
    assert.strictEqual(session.accessToken, 'g-tok', 'the SSO token is untouched');
    assert.deepStrictEqual(hydrationCalls, [], 'an established session never reads the vault');
});

test('Google wins when both are vaulted, matching getIntegrationTools precedence', async () => {
    reset();
    vault.google = { accessToken: 'g' };
    vault.microsoft = { accessToken: 'm' };
    const session = { user: { id: 'u1' } };

    const flags = await resolveFlags(session);

    assert.strictEqual(flags.isGoogleUser, true);
    assert.strictEqual(flags.isMicrosoftUser, false);
});

test('a vault failure degrades to false instead of 500ing the settings call', async () => {
    reset();
    const session = { user: { id: 'u1' } };
    const original = mockRoutineAuth.getProviderAuth;
    mockRoutineAuth.getProviderAuth = async () => { throw new Error('vault unreachable'); };
    try {
        const flags = await resolveFlags(session);
        assert.deepStrictEqual(flags, { isGoogleUser: false, isMicrosoftUser: false });
    } finally {
        mockRoutineAuth.getProviderAuth = original;
    }
});

// ── Org integration grants come from the live source ────────────────

test('user-settings resolves org grants via core/enabledIntegrations', () => {
    // An org's live grants — everything the Integrations admin screen toggles —
    // live in `org_enabled_integrations`. The camelCase `enabledIntegrations`
    // column is only set for orgs a super-admin overrode, so reading it alone
    // reports a stale override as the entire allow-list. The composer's app
    // picker filters its whole catalogue through this value and hides itself
    // when nothing survives, which is how every Google app vanished from the
    // picker while the model kept calling Gmail.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'config', 'userSettings.js'), 'utf8');
    const handler = src.slice(src.indexOf("router.get('/user-settings'"));
    const body = handler.slice(0, handler.indexOf('hasN8nConfig'));

    assert.match(body, /resolveOrgIntegrations/, 'must use the shared resolver');
    assert.doesNotMatch(
        body,
        /org\?\.enabledIntegrations/,
        'must not read the legacy column directly — that is the bug',
    );
});

test('the shared resolver unions both columns, newest first', async () => {
    // Guards the resolver itself: a stale legacy override must widen the list,
    // never replace it.
    const { resolveOrgIntegrations } = require('../../core/integrations/enabledIntegrations');
    assert.strictEqual(typeof resolveOrgIntegrations, 'function');

    const userStore = require('../../stores/userStore');
    const originalGet = userStore.getOrganization;
    userStore.getOrganization = async () => ({
        orgEnabledIntegrations: ['gmail', 'google-drive'],
        enabledIntegrations: ['nextcloud'],
    });
    try {
        const list = await resolveOrgIntegrations('org-1');
        assert.ok(list.includes('gmail'), 'live grants survive');
        assert.ok(list.includes('nextcloud'), 'legacy grants are unioned, not dropped');
    } finally {
        userStore.getOrganization = originalGet;
    }
});

test('no org means no restriction, not an empty allow-list', async () => {
    const { resolveOrgIntegrations } = require('../../core/integrations/enabledIntegrations');
    // null reads downstream as "the org restricts nothing"; [] would read as
    // "the org permits nothing" and empty the picker.
    assert.strictEqual(await resolveOrgIntegrations(null), null);
});

test('the route performs the hydration it claims to', () => {
    // Guards the wiring the logic test above stands in for: if the hydration
    // calls are ever dropped from the handler, the behaviour tests would keep
    // passing while the endpoint regressed.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'config', 'userSettings.js'), 'utf8');
    const handler = src.slice(src.indexOf("router.get('/user-settings'"));
    const body = handler.slice(0, handler.indexOf('isGoogleUser ='));

    assert.match(body, /hydrateGoogleSessionFromVault/, 'user-settings must hydrate Google');
    assert.match(body, /hydrateMicrosoftSessionFromVault/, 'user-settings must hydrate Microsoft');
});
