/**
 * Session-shape contract — every way a session gets established, in one place.
 *
 * THE INVARIANT: Nextcloud access must be derivable from the user's DB row
 * alone. No session extra (connectorOrgId, provider, ncUid, …) may be
 * load-bearing for whether an NC-org user can reach their Nextcloud — those
 * extras are a fast path, nothing more. This is the contract that broke when
 * org admins logged in at beeflow.nl directly and lost file access: the
 * standalone login writes a minimal session user and nothing else, and the
 * old resolution chain only recognised connector-minted sessions.
 *
 * ADDING A SESSION WRITER? Register its canonical shape in REGISTRY below
 * (copy the literal shape your writer produces — do not idealise it) and keep
 * the invariant tests passing. The tripwire test at the bottom fails the
 * build when a new auth file starts calling establishSession without being
 * registered here.
 *
 * Run: node --test server/auth/sessionShapes.contract.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// ── require.cache fakes (see integrations/nextcloudClient.test.js) ──────────

const state = { users: new Map(), orgs: new Map(), secrets: new Map() };

function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../stores/userStore.js', {
    getUser: async (id) => state.users.get(id) || null,
    getOrganization: async (id) => state.orgs.get(id) || null,
    getAppPassword: async () => null,
    updateUser: async () => {},
});
inject('../stores/configStore.js', {
    getSecret: async (key) => state.secrets.get(key) || null,
    getConfig: async () => ({}),
});
inject('./permissions.js', {
    loadConfig: async () => ({}),
    resolveUserOrgIds: async () => null,
});

const { resolveNcBinding } = require('../integrations/nextcloudClient');

const ORG = 'org-nc';
const USER = 'u-1';
const NC_UID = 'tom';

beforeEach(() => {
    state.users.clear();
    state.orgs.clear();
    state.secrets.clear();
    state.orgs.set(ORG, {
        id: ORG,
        nc_instance_id: 'nc-host:cloud.example.com',
        connector_callback_url: 'https://cloud.example.com/index.php/apps/app_api/proxy/bee_flow',
    });
    state.secrets.set(`connector_tenant_key_${ORG}`, 'k'.repeat(64));
    // Raw row: snake_case nc_uid, as SELECT * returns it.
    state.users.set(USER, { id: USER, email: 'tom@example.com', organizationId: ORG, nc_uid: NC_UID });
});

/**
 * writerFile: the auth-dir file that establishes this session (tripwire key).
 * build(): the literal session shape that writer produces.
 */
const REGISTRY = [
    {
        name: 'connector JWT (embedded iframe)',
        writerFile: 'connectorJwt.js',
        build: () => ({
            isAuthenticated: true,
            user: {
                id: USER, email: 'tom@example.com', displayName: 'Tom', role: 'user',
                orgRole: 'org_admin', organizationId: ORG, ncUid: NC_UID,
                provider: 'nextcloud_connector',
            },
            connectorOrgId: ORG,
            connectorNcUid: NC_UID,
        }),
    },
    {
        name: 'password login (bcrypt path)',
        writerFile: 'login/finalizeLogin.js',
        build: () => ({
            isAuthenticated: true,
            user: { id: USER, displayName: 'Tom', role: 'user', avatar: null, avatarType: null },
            isAdmin: false,
        }),
    },
    {
        name: 'password signup (auto-login)',
        writerFile: 'login/signupRoutes.js',
        build: () => ({
            isAuthenticated: true,
            user: {
                id: USER, displayName: 'Tom', role: 'user', isAdmin: false,
                avatar: null, avatarType: null, organizationId: ORG, orgRole: '',
            },
            isAdmin: false,
        }),
    },
    {
        name: 'OPAQUE login',
        writerFile: 'opaqueRoutes.js',
        build: () => ({
            isAuthenticated: true,
            user: { id: USER, displayName: 'Tom', role: 'user' },
        }),
    },
    {
        name: 'OAuth login (Google/Microsoft/Nextcloud OAuth)',
        writerFile: 'oauth/providerCallbackRoutes.js',
        build: () => ({
            isAuthenticated: true,
            user: { id: USER, displayName: 'Tom', role: 'user' },
            oauthProvider: 'google',
            accessToken: 'ya29.fake',
        }),
    },
    {
        // The pre-multi-provider Nextcloud URIs (/auth/login, /auth/callback):
        // session.user is the raw OCS payload and the uid rides alongside it.
        name: 'legacy Nextcloud OAuth login',
        writerFile: 'oauth/nextcloudLegacyRoutes.js',
        build: () => ({
            isAuthenticated: true,
            user: { id: USER, 'display-name': 'Tom', email: 'tom@example.com' },
            oauthProvider: 'nextcloud',
            accessToken: 'nc.fake',
            nextcloudUid: NC_UID,
        }),
    },
    {
        // Not an establishSession caller — index.js Object.assigns the bridge
        // payload — but it is a session writer all the same.
        name: 'x-session-token bridge (popup→iframe)',
        writerFile: null,
        build: () => ({
            user: { id: USER, displayName: 'Tom', role: 'user' },
            isAuthenticated: true,
            isAdmin: false,
            connectorOrgId: ORG,
            connectorNcUid: NC_UID,
        }),
    },
];

for (const entry of REGISTRY) {
    test(`invariant: ${entry.name} — NC binding resolves for an NC-bound row`, async () => {
        const binding = await resolveNcBinding(entry.build(), USER);
        assert.deepEqual(binding, { orgId: ORG, ncUid: NC_UID },
            `session shape from ${entry.writerFile || 'index.js bridge'} lost NC access`);
    });

    test(`invariant: ${entry.name} — no session extra is load-bearing (row alone suffices)`, async () => {
        const stripped = { user: { id: USER } };
        const binding = await resolveNcBinding(stripped, USER);
        assert.deepEqual(binding, { orgId: ORG, ncUid: NC_UID });
    });
}

test('invariant: non-NC org never resolves a binding, whatever the session shape', async () => {
    state.orgs.set(ORG, { id: ORG }); // strip the NC markers
    for (const entry of REGISTRY) {
        assert.equal(await resolveNcBinding(entry.build(), USER), null,
            `${entry.name} resolved a binding for a non-NC org`);
    }
});

// ── Tripwire: a new session writer must register here ───────────────────────

test('tripwire: every auth file that establishes sessions is registered above', () => {
    const registered = new Set(REGISTRY.map(e => e.writerFile).filter(Boolean));
    // A session writer either goes through establishSession (cookie flows)
    // or establishes in-memory + suppresses persistence (header-auth flows
    // like the connector JWT — see suppressSessionPersistence).
    const WRITER_MARK = /establishSession\(req|suppressSessionPersistence\(req/;
    // One level down too: the big routers are split per flow into auth/login/
    // and auth/admin/, so the writer now sits in a subdirectory.
    const candidates = [];
    for (const e of fs.readdirSync(__dirname, { withFileTypes: true })) {
        if (e.isDirectory()) {
            for (const f of fs.readdirSync(path.join(__dirname, e.name))) candidates.push(`${e.name}/${f}`);
        } else {
            candidates.push(e.name);
        }
    }
    const writers = candidates
        .filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'establishSession.js')
        .filter(f => WRITER_MARK.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
    for (const file of writers) {
        assert.ok(registered.has(file),
            `${file} establishes sessions but has no shape registered in sessionShapes.contract.test.js — `
            + 'add its canonical session shape to REGISTRY so the NC-binding invariant covers it.');
    }
    // And the registry must not go stale the other way.
    for (const file of registered) {
        assert.ok(writers.includes(file), `${file} is registered but no longer establishes sessions — update REGISTRY.`);
    }
});
