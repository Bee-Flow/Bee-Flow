/**
 * nextcloudClient — the session-shape → Nextcloud-access contract.
 *
 * THE regression this file exists to prevent: an org admin of a Nextcloud-
 * connected org logs in at beeflow.nl in a normal browser (or through the
 * x-session-token bridge) and can suddenly not reach their Nextcloud files,
 * because the resolution chain only recognised sessions minted by the
 * connector JWT middleware. The binding is an ORG-LEVEL fact (see
 * auth/ncAudience.js) and must be derivable from the DB row alone.
 *
 * Every real session writer's shape is exercised table-driven below. If you
 * add a new way of establishing a session, add its shape here AND to
 * auth/sessionShapes.contract.test.js — that is the mechanism that keeps this
 * bug class extinct.
 *
 * Also carries the HMAC v2 contract vector shared with the connector repo
 * (nextcloud-connector/test/ncProxy.test.js verifies the same vector with the
 * real verifyHmac): ts\nMETHOD\npath\nncUid\nsha256(body).
 *
 * Fake stores injected into require.cache — no Postgres, no network.
 *
 * Run: node --test server/integrations/nextcloudClient.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');

// ── require.cache fakes (must precede requiring the module under test) ──────

const state = {
    users: new Map(),
    orgs: new Map(),
    appPasswords: new Map(),
    secrets: new Map(),
    updates: [],
};

const userStoreMock = {
    getUser: async (id) => state.users.get(id) || null,
    getOrganization: async (id) => state.orgs.get(id) || null,
    getAppPassword: async (id) => state.appPasswords.get(id) || null,
    updateUser: async (id, updates) => { state.updates.push({ id, updates }); },
};
const configStoreMock = {
    getSecret: async (key) => state.secrets.get(key) || null,
    getConfig: async () => ({}),
};
const permissionsMock = {
    loadConfig: async () => ({}),
    resolveUserOrgIds: async () => null,
};

function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../stores/userStore.js', userStoreMock);
inject('../stores/configStore.js', configStoreMock);
inject('../auth/permissions.js', permissionsMock);
// auth/ncAudience is NOT mocked: the real org-level gate runs against the
// fake userStore, so a change to its NC-org definition is felt here.

const ncClient = require('./nextcloudClient');

const ORG = 'org-nc-1';
const USER = 'user-1';
const NC_UID = 'tom';
const TENANT_KEY = 'a'.repeat(64);

function seedNcOrg(overrides = {}) {
    state.orgs.set(ORG, {
        id: ORG,
        nc_instance_id: 'nc-host:cloud.example.com',
        connector_callback_url: 'https://cloud.example.com/index.php/apps/app_api/proxy/bee_flow',
        ...overrides,
    });
    state.secrets.set(`connector_tenant_key_${ORG}`, TENANT_KEY);
}

function seedBoundUser(row = {}) {
    state.users.set(USER, {
        id: USER,
        email: 'tom@example.com',
        organizationId: ORG,
        nc_uid: NC_UID, // raw column spelling — snake_case, as SELECT * returns it
        ...row,
    });
}

beforeEach(() => {
    state.users.clear();
    state.orgs.clear();
    state.appPasswords.clear();
    state.secrets.clear();
    state.updates.length = 0;
});

// ── The four real session shapes, copied from their writers ─────────────────

// auth/connectorJwt.js:547-607 — the connector-JWT (embedded) session.
const connectorJwtSession = () => ({
    isAuthenticated: true,
    user: {
        id: USER, email: 'tom@example.com', displayName: 'Tom', role: 'user',
        orgRole: 'org_admin', organizationId: ORG, ncUid: NC_UID,
        provider: 'nextcloud_connector',
    },
    connectorOrgId: ORG,
    connectorNcUid: NC_UID,
});

// auth/loginRoutes.js:406-412,478 — the standalone cookie login. No provider,
// no organizationId, no nc_uid: exactly the shape that used to lose NC access.
const standaloneSession = () => ({
    isAuthenticated: true,
    user: { id: USER, displayName: 'Tom', role: 'user', avatar: null, avatarType: null },
    isAdmin: false,
});

// auth/opaqueRoutes.js:337-343 — OPAQUE login; same minimal user shape.
const opaqueSession = () => ({
    isAuthenticated: true,
    user: { id: USER, displayName: 'Tom', role: 'user' },
});

// index.js /api/session-token — the popup→iframe bridge payload after
// Object.assign(req.session, data). Includes the connector extras since the
// bridge started forwarding them.
const bridgedSession = () => ({
    user: { id: USER, displayName: 'Tom', role: 'user' },
    oauthProvider: undefined,
    isAuthenticated: true,
    isAdmin: false,
    connectorOrgId: ORG,
    connectorNcUid: NC_UID,
});

const SHAPES = [
    ['connector-JWT session', connectorJwtSession],
    ['standalone login session', standaloneSession],
    ['opaque login session', opaqueSession],
    ['bridged session', bridgedSession],
];

for (const [name, build] of SHAPES) {
    test(`resolveNcBinding: ${name} of an NC-bound user resolves {orgId, ncUid}`, async () => {
        seedNcOrg();
        seedBoundUser();
        const binding = await ncClient.resolveNcBinding(build(), USER);
        assert.deepEqual(binding, { orgId: ORG, ncUid: NC_UID });
    });

    test(`resolveAuth: ${name} of an NC-bound user yields connector mode`, async () => {
        seedNcOrg();
        seedBoundUser();
        const auth = await ncClient.resolveAuth(build(), USER);
        assert.equal(auth.mode, 'connector');
        assert.equal(auth.uid, NC_UID);
        assert.ok(auth.baseUrl.endsWith('/nc'), `baseUrl should target /nc/*, got ${auth.baseUrl}`);
    });

    test(`isConnected: ${name} of an NC-bound user reports connected`, async () => {
        seedNcOrg();
        seedBoundUser();
        assert.equal(await ncClient.isConnected(build(), USER), true);
    });
}

// ── The snake_case contract (the twice-fixed, once-surviving bug class) ─────

test('resolveNcBinding: a row carrying ONLY nc_uid (raw column) resolves', async () => {
    seedNcOrg();
    state.users.set(USER, { id: USER, organizationId: ORG, nc_uid: NC_UID });
    const binding = await ncClient.resolveNcBinding(standaloneSession(), USER);
    assert.deepEqual(binding, { orgId: ORG, ncUid: NC_UID });
});

test('resolveNcBinding: a row carrying ONLY the camelCase alias also resolves', async () => {
    seedNcOrg();
    state.users.set(USER, { id: USER, organizationId: ORG, ncUid: NC_UID });
    const binding = await ncClient.resolveNcBinding(standaloneSession(), USER);
    assert.deepEqual(binding, { orgId: ORG, ncUid: NC_UID });
});

test('resolveNcBinding: session user nc_uid (raw spelling) is honoured without a DB read', async () => {
    seedNcOrg();
    // No user row at all: if the session carries org + raw-spelled uid, the
    // fast path must not require the row.
    const session = {
        user: { id: USER, organizationId: ORG, nc_uid: NC_UID },
    };
    const binding = await ncClient.resolveNcBinding(session, USER);
    assert.deepEqual(binding, { orgId: ORG, ncUid: NC_UID });
});

// ── Negatives: the gate must not widen access ───────────────────────────────

test('resolveNcBinding: non-NC org is refused even with an nc_uid on the row', async () => {
    state.orgs.set(ORG, { id: ORG }); // no nc_instance_id, no registration_source
    state.secrets.set(`connector_tenant_key_${ORG}`, TENANT_KEY);
    seedBoundUser();
    assert.equal(await ncClient.resolveNcBinding(standaloneSession(), USER), null);
});

test('resolveNcBinding: registration_source=nextcloud_connector qualifies without nc_instance_id', async () => {
    state.orgs.set(ORG, { id: ORG, registration_source: 'nextcloud_connector', connector_callback_url: 'https://nc.example.com/x' });
    state.secrets.set(`connector_tenant_key_${ORG}`, TENANT_KEY);
    seedBoundUser();
    const binding = await ncClient.resolveNcBinding(standaloneSession(), USER);
    assert.deepEqual(binding, { orgId: ORG, ncUid: NC_UID });
});

test('resolveNcBinding: NC org but a row without any nc uid → null', async () => {
    seedNcOrg();
    state.users.set(USER, { id: USER, organizationId: ORG });
    assert.equal(await ncClient.resolveNcBinding(standaloneSession(), USER), null);
});

test('resolveNcBinding: unknown user and bare session → null', async () => {
    seedNcOrg();
    assert.equal(await ncClient.resolveNcBinding(standaloneSession(), USER), null);
    assert.equal(await ncClient.resolveNcBinding(null, null), null);
});

test('resolveAuth: NC org missing connector_callback_url falls through to the credential error', async () => {
    seedNcOrg({ connector_callback_url: null });
    seedBoundUser();
    await assert.rejects(
        () => ncClient.resolveAuth(standaloneSession(), USER),
        /Nextcloud not connected/,
    );
});

test('resolveAuth: missing tenant key falls through to the credential error', async () => {
    seedNcOrg();
    state.secrets.clear();
    seedBoundUser();
    await assert.rejects(
        () => ncClient.resolveAuth(standaloneSession(), USER),
        /Nextcloud not connected/,
    );
});

test('resolveAuth: non-NC user with no credentials still gets the actionable error', async () => {
    state.users.set(USER, { id: USER, organizationId: 'org-plain' });
    state.orgs.set('org-plain', { id: 'org-plain' });
    await assert.rejects(
        () => ncClient.resolveAuth(standaloneSession(), USER),
        /Settings → Connections/,
    );
});

test('resolveAuth: a saved app password still wins over the DB-backed connector fallback', async () => {
    // Priority contract: existing working paths must be untouched — the
    // connector fallback only runs where the call previously threw.
    seedNcOrg();
    seedBoundUser();
    state.appPasswords.set(USER, { username: 'tom', password: 'app-pass', url: 'https://cloud.example.com' });
    const auth = await ncClient.resolveAuth(standaloneSession(), USER);
    assert.equal(auth.mode, 'basic');
    assert.equal(auth.username, 'tom');
});

// ── HMAC v2 contract vector (shared with nextcloud-connector/test) ──────────

test('connector fetch signs the HMAC v2 vector: ts\\nMETHOD\\npath\\nncUid\\nsha256(body)', async () => {
    seedNcOrg();
    seedBoundUser();
    const auth = await ncClient.resolveAuth(connectorJwtSession(), USER);
    assert.equal(auth.mode, 'connector');

    const captured = [];
    const realFetch = global.fetch;
    const realNow = Date.now;
    const FIXED_TS = 1755772800000; // 2026-08-21T10:40:00Z, arbitrary but pinned
    global.fetch = async (url, options) => {
        captured.push({ url, options });
        return { status: 200, ok: true, headers: { get: () => null } };
    };
    Date.now = () => FIXED_TS;
    try {
        await auth.fetch(`${auth.baseUrl}/remote.php/dav/files/${NC_UID}/`, { method: 'PROPFIND' });
    } finally {
        global.fetch = realFetch;
        Date.now = realNow;
    }

    assert.equal(captured.length, 1);
    const { options } = captured[0];
    // WebDAV verbs tunnel as POST + X-HTTP-Method-Override, signed over the REAL method.
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-HTTP-Method-Override'], 'PROPFIND');
    assert.equal(options.headers['X-Beeflow-NC-Uid'], NC_UID);

    const [ts, sig] = String(options.headers['X-Beeflow-Sig']).split('.');
    assert.equal(Number(ts), Math.floor(FIXED_TS / 1000));
    const emptyBodyHash = crypto.createHash('sha256').update('').digest('hex');
    const message = `${ts}\nPROPFIND\n/nc/remote.php/dav/files/${NC_UID}/\n${NC_UID}\n${emptyBodyHash}`;
    const expected = crypto.createHmac('sha256', TENANT_KEY).update(message).digest('hex');
    assert.equal(sig, expected,
        'HMAC v2 signature drifted — if this change is intentional, update the matching vector in nextcloud-connector/test/ncProxy.test.js IN THE SAME CHANGE');
});
