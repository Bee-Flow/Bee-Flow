/**
 * Authorization + response-shape tests for GET /api/compliance/org-users.
 *
 * The endpoint exists because GET /auth/users 403s a pure-DPO caller
 * (its gate wants manage_users/admin_security/org_admin) — the compliance
 * pickers need a member directory a holder of ONLY admin_compliance can read.
 * Pinned here:
 *
 * 1. THE GATE: 401 unauthenticated, 403 without admin_compliance, 200 with
 *    admin_compliance alone (the DPO case) or 'all'.
 * 2. ORG SCOPING: the query is parameterised on the caller's own org and the
 *    SQL carries the hygiene constraints (email present, system admin row
 *    excluded) — the projection never selects key material at all.
 * 3. THE SHAPE: exactly {id, displayName, email, phone, orgRole}; even if the
 *    db layer returned envelope-encryption fields they must not reach the
 *    client (same leak-regression stance as adminRoutes.users.authz.test.js).
 *
 * Run: cd server && node --test routes/compliance.orgUsers.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    users: [],       // rows the db mock serves (org-users SQL emulated below)
    perms: [],       // what the requirePermission mock grants the caller
    sqlSeen: [],     // { sql, params } per getAll call
};

const KEY_FIELDS = ['passwordHash', 'masterWrappedDEK', 'wrappedDEK', 'kekSalt', 'recoverySalt', 'recoveryWrappedDEK'];

// Keys are the require strings exactly as written in the module that issues
// them: the sub-routers under routes/compliance/ sit one level deeper than the
// facade, so they say '../../…'; only the check auto-registration is required
// by routes/compliance.js itself.
const userStoreDouble = {
    getUser: async (id) => fx.users.find((u) => u.id === id) || null,
    getAllGroups: async () => [],
};

const MOCKS = {
    '../../stores/complianceStore': {},
    '../../stores/dpiaStore': {},
    '../../stores/incidentStore': {},
    '../../stores/soaStore': {},
    '../../stores/ismsDocStore': {},
    '../../compliance/iso/controls': { CONTROLS: [], THEMES: {}, byRef: () => null, byTheme: () => [] },
    '../../compliance/runner': { runAll: async () => ({}), runOne: async () => ({}) },
    '../../compliance/registry': { getAll: () => [], get: () => null },
    '../../compliance/score': { SEVERITY_WEIGHT: {}, computeScore: () => 100 },
    '../compliance/checks': {},
    '../../stores/configStore': { getConfig: async () => ({}) },
    '../../stores/userStore': userStoreDouble,
    // The same double under the spelling auth/orgScope.js uses: ./shared's
    // resolveOrgId reads the org there, and a stub keyed on one spelling lets
    // the real store load for the other.
    '../stores/userStore': userStoreDouble,
    '../../db': {
        // Emulates the org-users SELECT: org filter, email present, no system
        // admin row, ordered by lower(displayName → username).
        getAll: async (sql, params) => {
            fx.sqlSeen.push({ sql, params });
            const orgId = params[0];
            return fx.users
                .filter((u) => u.organizationId === orgId)
                .filter((u) => u.email && u.email !== '')
                .filter((u) => u.id !== 'admin')
                .sort((a, b) => String(a.displayName || a.username || '').toLowerCase()
                    .localeCompare(String(b.displayName || b.username || '').toLowerCase()))
                .map((u) => ({ ...u }));
        },
    },
    '../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.isAuthenticated ? next() : res.status(401).json({ error: 'unauthenticated' })),
        requirePermission: (perm) => (req, res, next) =>
            (fx.perms.includes(perm) || fx.perms.includes('all') ? next() : res.status(403).json({ error: 'forbidden' })),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:compliance-orgusers:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // auth/orgScope.js too: ./shared's resolveOrgId reads the org there now,
    // and a parent filter that misses it loads the real user store in silence.
    if (parent && /(routes[\\/]compliance(\.js|[\\/][^\\/]+\.js)|auth[\\/]orgScope\.js)$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

let router;
let loadError = null;
try {
    router = require('./compliance');
} catch (err) {
    loadError = err;
}
Module._resolveFilename = originalResolve;

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const request = {
            method,
            url,
            body,
            query: {},
            params: {},
            headers: {},
            session,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

// ── Fixtures ─────────────────────────────────────────────────────────
const withKeys = (u) => ({
    ...u,
    passwordHash: 'pw-hash',
    masterWrappedDEK: 'mwd-secret',
    wrappedDEK: 'wd-secret',
    kekSalt: 'kek-salt',
    recoverySalt: 'rec-salt',
    recoveryWrappedDEK: 'rwd-secret',
});

function resetFx() {
    fx.users = [
        { id: 'jan', username: 'jan', displayName: 'Jan Janssen', firstName: 'Jan', lastName: 'Janssen', email: 'jan@acme.nl', phone: '0611111111', orgRole: 'org_admin', organizationId: 'orgA' },
        { id: 'zoe', username: 'zoe', displayName: '', firstName: 'Zoë', lastName: 'de Vries', email: 'zoe@acme.nl', phone: null, orgRole: 'dpo', organizationId: 'orgA' },
        { id: 'ano', username: 'ano', displayName: '', firstName: '', lastName: '', email: 'ano@acme.nl', phone: '', orgRole: null, organizationId: 'orgA' },
        { id: 'nomail', username: 'nomail', displayName: 'No Mail', email: '', orgRole: 'member', organizationId: 'orgA' },
        { id: 'admin', username: 'admin', displayName: 'System', email: 'root@system', orgRole: null, organizationId: 'orgA' },
        { id: 'bob', username: 'bob', displayName: 'Bob', email: 'bob@beta.nl', orgRole: 'member', organizationId: 'orgB' },
    ];
    fx.perms = [];
    fx.sqlSeen.length = 0;
}

const JAN = { isAuthenticated: true, user: { id: 'jan', email: 'jan@acme.nl' } };

test('the router loaded with its dependencies stubbed', () => {
    assert.strictEqual(loadError, null, loadError && loadError.message);
    assert.strictEqual(typeof router, 'function');
});

// ═══ The gate ═══════════════════════════════════════════════════════

test('an unauthenticated caller gets 401', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/org-users', session: {} });
    assert.strictEqual(res.statusCode, 401);
});

test('a caller without admin_compliance is denied', async () => {
    resetFx();
    fx.perms = ['page_chat'];
    const res = await dispatch({ method: 'GET', url: '/org-users', session: JAN });
    assert.strictEqual(res.statusCode, 403);
});

for (const perm of ['admin_compliance', 'all']) {
    test(`'${perm}' alone is enough to list org members`, async () => {
        resetFx();
        fx.perms = [perm];
        const res = await dispatch({ method: 'GET', url: '/org-users', session: JAN });
        assert.strictEqual(res.statusCode, 200);
        assert.ok(Array.isArray(res.body));
    });
}

// ═══ Org scoping + SQL hygiene ══════════════════════════════════════

test('the query is scoped to the caller\'s own org', async () => {
    resetFx();
    fx.perms = ['admin_compliance'];
    const res = await dispatch({ method: 'GET', url: '/org-users', session: JAN });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.sqlSeen.length, 1);
    assert.deepEqual(fx.sqlSeen[0].params, ['orgA']);
    assert.ok(!res.body.some((u) => u.id === 'bob'), 'orgB members must not appear');
});

test('the SQL itself carries the hygiene constraints', async () => {
    resetFx();
    fx.perms = ['admin_compliance'];
    await dispatch({ method: 'GET', url: '/org-users', session: JAN });
    const { sql } = fx.sqlSeen[0];
    assert.match(sql, /"organizationId" = \$1/);
    assert.match(sql, /email IS NOT NULL AND email <> ''/);
    assert.match(sql, /id <> 'admin'/);
    assert.match(sql, /ORDER BY LOWER\(COALESCE\(NULLIF\("displayName", ''\), username\)\)/);
    // The projection never touches key material.
    for (const field of KEY_FIELDS) {
        assert.ok(!sql.includes(field), `the SELECT must not project ${field}`);
    }
});

test('system admin row and email-less rows are absent, order follows the SQL', async () => {
    resetFx();
    fx.perms = ['admin_compliance'];
    const res = await dispatch({ method: 'GET', url: '/org-users', session: JAN });
    assert.deepEqual(res.body.map((u) => u.id), ['ano', 'jan', 'zoe']);
});

// ═══ The shape ══════════════════════════════════════════════════════

test('rows carry exactly {id, displayName, email, phone, orgRole}', async () => {
    resetFx();
    fx.perms = ['admin_compliance'];
    const res = await dispatch({ method: 'GET', url: '/org-users', session: JAN });
    for (const row of res.body) {
        assert.deepEqual(Object.keys(row).sort(), ['displayName', 'email', 'id', 'orgRole', 'phone']);
    }
    const jan = res.body.find((u) => u.id === 'jan');
    assert.deepEqual(jan, { id: 'jan', displayName: 'Jan Janssen', email: 'jan@acme.nl', phone: '0611111111', orgRole: 'org_admin' });
});

test('displayName falls back to firstName+lastName, then username', async () => {
    resetFx();
    fx.perms = ['admin_compliance'];
    const res = await dispatch({ method: 'GET', url: '/org-users', session: JAN });
    assert.strictEqual(res.body.find((u) => u.id === 'zoe').displayName, 'Zoë de Vries');
    assert.strictEqual(res.body.find((u) => u.id === 'ano').displayName, 'ano');
    // Empty phone normalises to null.
    assert.strictEqual(res.body.find((u) => u.id === 'ano').phone, null);
});

test('even a leaky db row never reaches the client with key material', async () => {
    resetFx();
    fx.perms = ['admin_compliance'];
    fx.users = fx.users.map(withKeys);
    const res = await dispatch({ method: 'GET', url: '/org-users', session: JAN });
    assert.strictEqual(res.statusCode, 200);
    const serialised = JSON.stringify(res.body);
    for (const field of KEY_FIELDS) {
        assert.ok(!serialised.includes(field), `GET /org-users must not expose ${field}`);
    }
    for (const secret of ['pw-hash', 'mwd-secret', 'wd-secret', 'kek-salt', 'rec-salt', 'rwd-secret']) {
        assert.ok(!serialised.includes(secret), `GET /org-users leaked the value ${secret}`);
    }
});
