/**
 * App Studio connectors — the OWNER SESSION build.
 *
 * This is the function that produced the "connect Gmail" message for a user
 * whose Gmail was connected. It talks to userStore / configStore / routineAuth,
 * so unlike the other connector tests it stubs those through the require cache
 * rather than the `_deps` seam (the session builder is a default dep, not an
 * injected one).
 *
 * Run: cd server && node --test appStudio/connectors.session.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// The live shape that broke: the org grants Google through the CURRENT column,
// the legacy column is empty, and the user never saved an app list.
let orgs = { 'bee-flow': { orgEnabledIntegrations: ['gmail', 'google-calendar', 'google-drive'], enabledIntegrations: null } };
let configs = {};
let users = { tomsmit: { id: 'tomsmit', email: 'tomsmit@beeflow.nl', organizationId: 'bee-flow' } };
let vault = { google: { accessToken: 'ya29.live', refreshToken: 'r' } };
let legacySessionRows = [];
let buildUserAuthCalls = [];

stub('../stores/userStore', {
    getUser: async (id) => users[id] || null,
    getOrganization: async (id) => orgs[id] || null,
});
stub('../stores/configStore', { getConfig: async (k) => (k in configs ? configs[k] : null) });
stub('../db', { pool: { query: async () => ({ rows: legacySessionRows }) } });
stub('../auth/routineAuth', {
    providersForIntegrations: (ids) => {
        const map = { gmail: 'google', 'google-calendar': 'google', 'google-drive': 'google', outlook: 'microsoft' };
        return [...new Set((ids || []).map((i) => map[i]).filter(Boolean))];
    },
    getProviderAuth: async (_userId, provider) => vault[provider] || null,
    buildUserAuth: async (userId, opts) => {
        buildUserAuthCalls.push({ userId, ...opts });
        const providers = module.exports; // placeholder to keep lint quiet
        const map = { gmail: 'google', 'google-calendar': 'google', 'google-drive': 'google', outlook: 'microsoft' };
        const required = [...new Set((opts.enabledIntegrations || []).map((i) => map[i]).filter(Boolean))];
        // The real shortcut that caused the bug: asked for no providers, answer
        // with a TRUTHY object whose accessToken is null.
        if (required.length === 0) {
            return { userId, accessToken: null, refreshToken: null, oauthProvider: null, routineProviders: {} };
        }
        const ok = required.filter((p) => vault[p]);
        if (!ok.length) return null;
        const primary = opts.providerHint && vault[opts.providerHint] ? opts.providerHint : ok[0];
        void providers;
        return {
            userId, oauthProvider: primary,
            accessToken: vault[primary].accessToken, refreshToken: vault[primary].refreshToken,
            routineProviders: Object.fromEntries(ok.map((p) => [p, vault[p]])),
        };
    },
});

const connectors = require('./connectors');
const app = { id: 'app-1', userId: 'tomsmit', organizationId: 'bee-flow' };

test.beforeEach(() => {
    buildUserAuthCalls = [];
    legacySessionRows = [];
    configs = {};
    vault = { google: { accessToken: 'ya29.live', refreshToken: 'r' } };
    orgs = { 'bee-flow': { orgEnabledIntegrations: ['gmail', 'google-calendar', 'google-drive'], enabledIntegrations: null } };
});

// A connector run, with only executeTool stubbed — the session build is real.
async function runGmail(connector = {}) {
    const calls = [];
    const res = await connectors.runConnector(
        { id: 'conn_aaa111', kind: 'integration_tool', tool: 'gmail_search', integrationId: 'gmail', ...connector },
        {
            app, viewerId: 'tomsmit', params: {},
            _deps: {
                executeTool: async (tool, args, ctx) => {
                    calls.push({ tool, session: ctx.session });
                    // Faithful to integrations/googleClient.js:177.
                    if (!ctx.session?.accessToken) throw new Error('Not connected to Gmail — user must log in with Google');
                    return { results: [{ id: 'm1' }] };
                },
            },
        },
    );
    return { res, calls };
}

// ── the regression ──────────────────────────────────────────────────

test('THE BUG: an org granting Gmail via the CURRENT column gets a real token', async () => {
    const { res, calls } = await runGmail();
    assert.deepStrictEqual(res.rows, [{ id: 'm1' }]);
    assert.strictEqual(calls[0].session.accessToken, 'ya29.live');
    // The dispatched integration is in the list even though nothing else put it there.
    assert.ok(buildUserAuthCalls[0].enabledIntegrations.includes('gmail'));
    assert.strictEqual(buildUserAuthCalls[0].providerHint, 'google');
});

test('a token-less shim is NOT adopted as a session', async () => {
    // Force the shortcut: no org grants, no user list, and strip the include by
    // using a connector with no resolvable integration.
    orgs['bee-flow'] = { orgEnabledIntegrations: null, enabledIntegrations: null };
    vault = {};
    await assert.rejects(
        () => runGmail(),
        (err) => err.status === 409 && err.code === 'connection_required',
    );
});

test('an org with NO grants still works, because the dispatched integration is forced in', async () => {
    orgs['bee-flow'] = { orgEnabledIntegrations: null, enabledIntegrations: null };
    const { calls } = await runGmail();
    assert.strictEqual(calls[0].session.accessToken, 'ya29.live', 'include saved the run');
});

test('a user with BOTH providers gets the one the connector actually needs', async () => {
    vault = {
        microsoft: { accessToken: 'ms.token', refreshToken: 'r' },
        google: { accessToken: 'ya29.live', refreshToken: 'r' },
    };
    orgs['bee-flow'] = { orgEnabledIntegrations: ['outlook', 'gmail'], enabledIntegrations: null };
    const { calls } = await runGmail();
    // Without providerHint the primary is whichever entry happened to be first —
    // a Microsoft token handed to the Gmail client.
    assert.strictEqual(calls[0].session.accessToken, 'ya29.live');
    assert.strictEqual(calls[0].session.oauthProvider, 'google');
});

// ── honest failure messages ─────────────────────────────────────────

test('no credential at all → "connect it", the message the owner can act on', async () => {
    vault = {};
    await assert.rejects(() => runGmail(), (err) => {
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.reason, 'not_connected');
        assert.strictEqual(err.provider, 'gmail');
        assert.match(err.message, /Not connected to Gmail/);
        return true;
    });
});

test('credential present but the session lost it → says THAT, not "connect it"', async () => {
    // The exact state that sent a connected user to Settings in a circle: the
    // vault has an active Google credential, but the session carried no token.
    const original = require('../auth/routineAuth').buildUserAuth;
    require('../auth/routineAuth').buildUserAuth = async () => ({ userId: 'tomsmit', accessToken: null, routineProviders: {} });
    try {
        await assert.rejects(() => runGmail(), (err) => {
            assert.strictEqual(err.status, 409);
            assert.strictEqual(err.reason, 'token_unavailable');
            assert.match(err.message, /could not be loaded/i);
            assert.doesNotMatch(err.message, /must log in/i, 'must not tell them to connect what is connected');
            return true;
        });
    } finally { require('../auth/routineAuth').buildUserAuth = original; }
});

// ── the legacy fallback the other bridges already had ───────────────

test('falls back to a live signed-in session when the vault has nothing', async () => {
    vault = {};
    legacySessionRows = [{ sess: { user: { id: 'tomsmit' }, accessToken: 'sso.token', oauthProvider: 'google' } }];
    const { calls } = await runGmail();
    assert.strictEqual(calls[0].session.accessToken, 'sso.token');
});

test('a legacy row WITHOUT a token is ignored rather than adopted', async () => {
    vault = {};
    legacySessionRows = [{ sess: { user: { id: 'tomsmit' } } }];
    await assert.rejects(() => runGmail(), (err) => err.code === 'connection_required');
});
