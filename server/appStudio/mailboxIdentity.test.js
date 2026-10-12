/**
 * Who a mailbox connector runs as, and WHICH credential it uses.
 *
 * The rule this file exists to protect: signing in to Bee Flow with Google or
 * Microsoft already grants the mail scopes, so that login must be enough. Asking
 * such a user to "connect Gmail" separately is asking them to redo the thing
 * they just did — and for an account without an organisation the vault write at
 * login used to be skipped entirely, so there was nothing to connect TO.
 *
 * Run: cd server && node --test appStudio/mailboxIdentity.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { resolveMailboxIdentity } = require('./mailboxIdentity');

const APP = { id: 'app_1', userId: 'owner1', organizationId: null };

function connector(extra = {}) {
    return { id: 'conn_m1', kind: 'mailbox', provider: 'gmail', mode: 'personal', runAs: 'viewer', ...extra };
}

/** A dependency set with nothing connected anywhere. */
function deps(overrides = {}) {
    return {
        getProviderAuth: async () => null,
        upsertCredential: async () => {},
        getIntegrationTools: async () => ({ tools: [] }),
        resolveConnectionForRun: async () => null,
        // Faithful to the real module: it answers with an OBJECT, not a string.
        // A stub that returned a string is what let the object-vs-string bug
        // ship green — see the contract test at the bottom of this file.
        resolveIntegration: (name) => (name.startsWith('gmail') ? { integration: 'gmail', label: 'Gmail' } : null),
        getUser: async (id) => ({ id, organizationId: null }),
        buildUserSession: async () => ({ user: { id: 'u1' }, automationProviders: {} }),
        resolveMailboxAddress: async () => 'ik@acme.nl',
        ...overrides,
    };
}

// The shape core/integrationTools returns when Gmail IS available to a user.
const GMAIL_TOOLS = { tools: [{ function: { name: 'gmail_search' } }] };

test('a Google-SSO session is enough — no separate "connect Gmail" step', async () => {
    // The exact case a user hits after logging in with Google: no vault row
    // (their account has no organisation, so login skipped the write), but a
    // live session carrying the Google tokens.
    const upserts = [];
    const identity = await resolveMailboxIdentity(connector(), {
        app: APP,
        viewerId: 'u1',
        deps: deps({
            getIntegrationTools: async () => GMAIL_TOOLS,
            buildUserSession: async () => ({
                user: { id: 'u1' },
                oauthProvider: 'google',
                accessToken: 'sso-at',
                refreshToken: 'sso-rt',
                automationProviders: {},
            }),
            upsertCredential: async (row) => { upserts.push(row); },
        }),
    });

    assert.strictEqual(identity.userId, 'u1');
    assert.strictEqual(identity.tokens.accessToken, 'sso-at');
    assert.strictEqual(identity.mailbox.address, 'ik@acme.nl');
});

test('the chat Apps preference cannot veto a configured mailbox', async () => {
    // The regression this pins: a user whose saved enabled-apps list (a CHAT
    // preference) does not include gmail was told "Your organisation has not
    // enabled gmail" — gmail is not auto-enabled, so the list hid the tools
    // and the identity check misread that as an org decision. The resolver
    // must pass enabledAppsOverride so ONLY the preference layer is bypassed;
    // entitlement and credential gates inside getIntegrationTools still rule.
    const seen = [];
    const identity = await resolveMailboxIdentity(connector(), {
        app: APP,
        viewerId: 'u1',
        deps: deps({
            getIntegrationTools: async (args) => {
                seen.push(args);
                // Faithful to the fixed behaviour: with the override present
                // the preference no longer filters gmail out.
                return Array.isArray(args.enabledAppsOverride) && args.enabledAppsOverride.includes('gmail')
                    ? GMAIL_TOOLS
                    : { tools: [] };
            },
            buildUserSession: async () => ({
                user: { id: 'u1' },
                oauthProvider: 'google',
                accessToken: 'sso-at',
                refreshToken: 'sso-rt',
                automationProviders: {},
            }),
        }),
    });

    assert.strictEqual(identity.userId, 'u1');
    assert.deepStrictEqual(seen[0].enabledAppsOverride, ['gmail']);
});

test('a session-sourced token is copied into the vault so the SCHEDULED sync survives', async () => {
    // Without this the mailbox would only ever refresh while its owner happened
    // to be online — a background job has no session to read.
    const upserts = [];
    await resolveMailboxIdentity(connector(), {
        app: APP,
        viewerId: 'u1',
        deps: deps({
            getIntegrationTools: async () => GMAIL_TOOLS,
            buildUserSession: async () => ({ user: { id: 'u1' }, oauthProvider: 'google', accessToken: 'sso-at', refreshToken: 'sso-rt', automationProviders: {} }),
            upsertCredential: async (row) => { upserts.push(row); },
        }),
    });

    assert.strictEqual(upserts.length, 1);
    assert.strictEqual(upserts[0].provider, 'google');
    assert.strictEqual(upserts[0].accessToken, 'sso-at');
    // Org-less accounts get the per-user vault scope, not a skipped write.
    assert.strictEqual(upserts[0].orgId, 'user:u1');
});

test('the vault wins when it has a credential (it refreshes; a session does not)', async () => {
    const upserts = [];
    const identity = await resolveMailboxIdentity(connector(), {
        app: APP,
        viewerId: 'u1',
        deps: deps({
            getIntegrationTools: async () => GMAIL_TOOLS,
            getProviderAuth: async () => ({ accessToken: 'vault-at', refreshToken: 'vault-rt' }),
            buildUserSession: async () => ({ user: { id: 'u1' }, oauthProvider: 'google', accessToken: 'sso-at', automationProviders: {} }),
            upsertCredential: async (row) => { upserts.push(row); },
        }),
    });

    assert.strictEqual(identity.tokens.accessToken, 'vault-at');
    assert.strictEqual(upserts.length, 0, 'nothing to copy — it is already durable');
});

test('providers are never mixed: a Microsoft session is not handed to Gmail', async () => {
    await assert.rejects(
        () => resolveMailboxIdentity(connector(), {
            app: APP,
            viewerId: 'u1',
            deps: deps({
                getIntegrationTools: async () => GMAIL_TOOLS,
                buildUserSession: async () => ({ user: { id: 'u1' }, oauthProvider: 'microsoft', accessToken: 'ms-at', automationProviders: {} }),
            }),
        }),
        (e) => e.code === 'connection_required',
    );
});

test('a token under automationProviders is used too', async () => {
    const identity = await resolveMailboxIdentity(connector(), {
        app: APP,
        viewerId: 'u1',
        deps: deps({
            getIntegrationTools: async () => GMAIL_TOOLS,
            buildUserSession: async () => ({
                user: { id: 'u1' },
                oauthProvider: 'microsoft',
                accessToken: 'ms-at',
                automationProviders: { google: { accessToken: 'g-at', refreshToken: 'g-rt' } },
            }),
        }),
    });
    assert.strictEqual(identity.tokens.accessToken, 'g-at');
});

test('"your org disabled it" is reported differently from "you are not connected"', async () => {
    // Telling a connected user to connect something gives them nothing to click.
    await assert.rejects(
        () => resolveMailboxIdentity(connector(), {
            app: APP,
            viewerId: 'u1',
            deps: deps({
                // The org gate says no…
                getIntegrationTools: async () => ({ tools: [] }),
                // …but the account itself holds a perfectly good token.
                getProviderAuth: async () => ({ accessToken: 'vault-at' }),
            }),
        }),
        (e) => {
            assert.strictEqual(e.status, 403);
            assert.strictEqual(e.code, 'integration_disabled');
            assert.match(e.message, /organisation has not enabled/i);
            return true;
        },
    );

    await assert.rejects(
        () => resolveMailboxIdentity(connector(), { app: APP, viewerId: 'u1', deps: deps() }),
        (e) => {
            assert.strictEqual(e.status, 409);
            assert.strictEqual(e.code, 'connection_required');
            assert.strictEqual(e.provider, 'gmail');
            return true;
        },
    );
});

test('runAs owner reads the app owner, and needs no viewer at all', async () => {
    const identity = await resolveMailboxIdentity(connector({ runAs: 'owner' }), {
        app: APP,
        viewerId: null,
        deps: deps({ getProviderAuth: async (id) => (id === 'owner1' ? { accessToken: 'owner-at' } : null) }),
    });
    assert.strictEqual(identity.userId, 'owner1');
    assert.strictEqual(identity.tokens.accessToken, 'owner-at');
});

test('a shared mailbox keeps the authored address; a personal one is discovered', async () => {
    const shared = await resolveMailboxIdentity(
        connector({ runAs: 'owner', mode: 'shared', address: 'Support@ACME.nl' }),
        { app: APP, deps: deps({ getProviderAuth: async () => ({ accessToken: 'at' }) }) },
    );
    assert.strictEqual(shared.mailbox.address, 'support@acme.nl');
    assert.strictEqual(shared.mailbox.mode, 'shared');
    // Gmail cannot open a delegated mailbox, so "shared" means a team alias.
    assert.strictEqual(shared.mailbox.sharedMode, 'delivered_alias');

    const personal = await resolveMailboxIdentity(
        connector({ runAs: 'owner' }),
        { app: APP, deps: deps({ getProviderAuth: async () => ({ accessToken: 'at' }) }) },
    );
    assert.strictEqual(personal.mailbox.address, 'ik@acme.nl', 'discovered from the token');
});

test('an unsupported provider is refused before any credential lookup', async () => {
    await assert.rejects(
        () => resolveMailboxIdentity(connector({ provider: 'imap' }), { app: APP, deps: deps() }),
        (e) => e.code === 'unsupported_provider' && e.status === 400,
    );
});

// ── Contract with the REAL module ───────────────────────────────────────────

test('resolveIntegration really does answer with an object, not a string', () => {
    // This is the test that would have caught the shipped bug. Every other test
    // in this file uses a stub, and a stub can agree with a mistake — so one
    // test has to touch the real thing.
    const { resolveIntegration } = require('../core/integrations/integrationToolMap');

    const hit = resolveIntegration('gmail_search');
    assert.ok(hit, 'gmail_search resolves');
    assert.strictEqual(typeof hit, 'object', 'an object, so === against an id is always false');
    assert.strictEqual(hit.integration, 'gmail');
    assert.notStrictEqual(hit, 'gmail');

    assert.strictEqual(resolveIntegration('not_a_real_tool'), null);
});

test('a viewer whose org DOES offer gmail is accepted (the shipped 403 case)', async () => {
    // Reproduces the report: Gmail enabled org-wide, signed in with Google, and
    // the mailbox still claimed the organisation had not enabled it.
    const { resolveIntegration } = require('../core/integrations/integrationToolMap');

    const identity = await resolveMailboxIdentity(connector(), {
        app: APP,
        viewerId: 'u1',
        deps: deps({
            // The real resolver, against a real Gmail tool name.
            resolveIntegration,
            getIntegrationTools: async () => ({ tools: [{ function: { name: 'gmail_search' } }] }),
            getProviderAuth: async () => ({ accessToken: 'vault-at' }),
        }),
    });

    assert.strictEqual(identity.userId, 'u1');
    assert.strictEqual(identity.tokens.accessToken, 'vault-at');
});

test('a viewer with their OWN connection is accepted via an "own" grant', async () => {
    // resolveConnectionForRun returns mode:'own' first for such a user; only
    // accepting 'delegated' turned a working connection into a 403.
    const identity = await resolveMailboxIdentity(connector(), {
        app: APP,
        viewerId: 'u1',
        deps: deps({
            getIntegrationTools: async () => ({ tools: [] }),   // toolbelt says no…
            resolveConnectionForRun: async () => ({ available: true, mode: 'own', effectiveUserId: 'u1' }),
            getProviderAuth: async (id) => (id === 'u1' ? { accessToken: 'own-at' } : null),
        }),
    });

    assert.strictEqual(identity.userId, 'u1');
    assert.strictEqual(identity.viaGrantFrom, null, 'own is not a delegation — nobody lent anything');
});

test('a delegated grant switches identity AND records who lent it', async () => {
    const identity = await resolveMailboxIdentity(connector(), {
        app: APP,
        viewerId: 'u1',
        deps: deps({
            getIntegrationTools: async () => ({ tools: [] }),
            resolveConnectionForRun: async () => ({ available: true, mode: 'delegated', effectiveUserId: 'grantor9' }),
            getProviderAuth: async (id) => (id === 'grantor9' ? { accessToken: 'lent-at' } : null),
        }),
    });

    assert.strictEqual(identity.userId, 'grantor9');
    assert.strictEqual(identity.viaGrantFrom, 'grantor9', 'the audit trail needs this');
});
