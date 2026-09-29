/**
 * Nextcloud pairing codes are bearer credentials — only org admins may see them.
 *
 * GET /auth/admin/nc-bindings/pairing-codes returned `code: <plaintext>` for
 * every active code of the caller's org behind `requireAuth` alone, while every
 * sibling endpoint on the same resource required org_admin (the generator
 * checks it inline; approve/deny go through loadAndAuthorize).
 *
 * Why that matters: connectorBootstrap treats the code AS the approval —
 * "whoever holds it gets to bind this NC instance to that specific org". A
 * rank-and-file member who reads an outstanding code can replay it as
 * X-Beeflow-Pairing-Code on POST /auth/connector/bootstrap from an
 * attacker-hosted fake Nextcloud, have ensureOrgAdminUser promote their own
 * account to org_admin, and receive the org's tenantKey — the HMAC key that
 * mints connector JWTs able to authenticate as any user of that org. That is
 * member → full control of the tenant.
 *
 * DELETE /pairing-codes/:id had the same gap. It is org-scoped, so it is not a
 * cross-tenant issue, but it let any member revoke the admin's outstanding code.
 *
 * Run: cd server && node --test auth/ncBindingRoutes.pairingCodes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = { users: [], codes: [], deleted: [], minted: [] };

const mw = (req, res, next) => next();

const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => {
            const u = fx.users.find((x) => x.id === id);
            return u ? { ...u } : null;
        },
        getActivePairingCodesForOrg: async (orgId) => fx.codes.filter((c) => c.orgId === orgId).map((c) => ({ ...c })),
        createOrgPairingCode: async (orgId, opts) => {
            const row = { id: `pc_${fx.minted.length + 1}`, orgId, pairingCode: 'MINTED-CODE', expiresAt: new Date(Date.now() + 900000).toISOString(), ...opts };
            fx.minted.push(row);
            return row;
        },
        deletePairingCode: async (id, orgId) => {
            const idx = fx.codes.findIndex((c) => c.id === id && c.orgId === orgId);
            if (idx === -1) return false;
            fx.deleted.push(id);
            fx.codes.splice(idx, 1);
            return true;
        },
        getPendingNcBinding: async () => null,
        getPendingNcBindingForOrg: async () => null,
        getOrganization: async () => null,
        logAccessAudit: async () => { },
    },
    '../stores/configStore': { deleteConfig: async () => { } },
    // isOrgAdminRole mirrors permissions.ORG_ADMIN_VARIANTS — accounts predating
    // the 'admin' → 'org_admin' rename are org admins too. Stubbing it away made
    // the module unloadable; a stub that cannot express the legacy role also
    // cannot show that such an admin keeps their access.
    './permissions': { requireAuth: mw, isOrgAdminRole: (r) => r === 'org_admin' || r === 'admin' },
    './connectorJwt': { invalidateTenantKeyCache: () => { } },
    './connectorBootstrap': {
        helpers: {
            ensureOrgAdminUser: async () => { },
            bindOrgToNcInstance: async (org) => org,
            getOrMintTenantKey: async () => 'tenant-key',
        },
    },
    '../services/orgHealth': { event: () => { } },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:ncbinding-pairing:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]ncBindingRoutes\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

let router;
let loadError = null;
try {
    router = require('./ncBindingRoutes');
} catch (err) {
    loadError = err;
}
Module._resolveFilename = originalResolve;

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const request = {
            method, url, body, query: {}, params: {}, headers: {},
            session: { save: (cb) => cb && cb(null), ...session },
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

function resetFx() {
    fx.users = [
        { id: 'jan', organizationId: 'orgA', orgRole: 'org_admin', role: 'user' },
        { id: 'eva', organizationId: 'orgA', orgRole: 'member', role: 'user' },
        { id: 'ed', organizationId: 'orgA', orgRole: 'agent_editor', role: 'user' },
        { id: 'solo', organizationId: '', orgRole: '', role: 'user' },
        { id: 'root', organizationId: '', orgRole: '', role: 'admin' },
    ];
    fx.codes = [{ id: 'pc_live', orgId: 'orgA', pairingCode: 'AAAA-BBBB-CCCC', expiresAt: new Date(Date.now() + 900000).toISOString(), createdAt: new Date().toISOString() }];
    fx.deleted = [];
    fx.minted = [];
}

const sess = (id, extra = {}) => ({ isAuthenticated: true, user: { id, role: id === 'root' ? 'admin' : 'user' }, ...extra });

test('the router loaded with its dependencies stubbed', () => {
    assert.strictEqual(loadError, null, loadError && loadError.message);
    assert.strictEqual(typeof router, 'function');
});

// ═══ The disclosure ══════════════════════════════════════════════════

test('a rank-and-file member cannot read the org\'s live pairing code', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/admin/nc-bindings/pairing-codes', session: sess('eva') });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.stringify(res.body).includes('AAAA-BBBB-CCCC'), false, 'the code must never appear in the body');
});

test('an agent_editor is not an org admin either', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/admin/nc-bindings/pairing-codes', session: sess('ed') });
    assert.strictEqual(res.statusCode, 403);
});

test('a member cannot revoke the admin\'s outstanding code', async () => {
    resetFx();
    const res = await dispatch({ method: 'DELETE', url: '/admin/nc-bindings/pairing-codes/pc_live', session: sess('eva') });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.deleted, [], 'the pairing workflow must not be deniable by a member');
});

// ═══ What must keep working ══════════════════════════════════════════

test('the org admin still gets the code', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/admin/nc-bindings/pairing-codes', session: sess('jan') });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.codes.length, 1);
    assert.strictEqual(res.body.codes[0].code, 'AAAA-BBBB-CCCC');
});

test('the org admin can still revoke a code', async () => {
    resetFx();
    const res = await dispatch({ method: 'DELETE', url: '/admin/nc-bindings/pairing-codes/pc_live', session: sess('jan') });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deleted, ['pc_live']);
});

test('a super admin still gets the listing', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/admin/nc-bindings/pairing-codes', session: sess('root', { isAdmin: true }) });
    assert.strictEqual(res.statusCode, 200);
});

test('an account with no organisation still gets an empty list, not a 403', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/admin/nc-bindings/pairing-codes', session: sess('solo') });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.codes, []);
});

test('generating a code is still org-admin only, and still works for the admin', async () => {
    resetFx();
    const denied = await dispatch({ method: 'POST', url: '/admin/nc-bindings/generate-pairing-code', session: sess('eva'), body: {} });
    assert.strictEqual(denied.statusCode, 403);

    const ok = await dispatch({ method: 'POST', url: '/admin/nc-bindings/generate-pairing-code', session: sess('jan'), body: {} });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.code, 'MINTED-CODE');
});

test('an org admin cannot mint a code for another org', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/admin/nc-bindings/generate-pairing-code',
        session: sess('jan'), body: { organizationId: 'orgB' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.minted, []);
});

// ═══ The legacy 'admin' orgRole ══════════════════════════════════════
//
// Two different things are spelled 'admin' in this codebase: users.role
// 'admin' is the platform super-admin, and orgRole 'admin' is the PRE-RENAME
// org admin ('admin' → 'org_admin'). Old orgs still carry the latter, so
// permissions.js keeps both in ORG_ADMIN_VARIANTS and getUserPermissions
// normalises them into the `org_admin` permission — which is exactly what
// OrganisationSection.jsx renders the pairing panel off. A raw
// `orgRole === 'org_admin'` in loadOrgAdmin therefore 403s the very admin the
// SPA just showed the panel to: the panel appears, every call inside it fails,
// and nothing in the UI says why. Hence isOrgAdminRole here.
//
// These accounts are pushed on top of resetFx() instead of into it, so the
// suites above keep running against exactly the fixture they were written for.

// role: 'user' on all three is load-bearing — an account-level 'admin' would
// pass through the super-admin branch and prove nothing about the role test.
const LEGACY_ADMIN_A = { id: 'lex', organizationId: 'orgA', orgRole: 'admin', role: 'user' };
const LEGACY_ADMIN_B = { id: 'bo', organizationId: 'orgB', orgRole: 'admin', role: 'user' };
const ORG_ADMIN_B = { id: 'nora', organizationId: 'orgB', orgRole: 'org_admin', role: 'user' };

function resetFxWithLegacy() {
    resetFx();
    fx.users.push({ ...LEGACY_ADMIN_A }, { ...LEGACY_ADMIN_B }, { ...ORG_ADMIN_B });
}

test('a legacy orgRole \'admin\' of the org can still read the pairing codes', async () => {
    resetFxWithLegacy();
    const res = await dispatch({ method: 'GET', url: '/admin/nc-bindings/pairing-codes', session: sess('lex') });
    assert.strictEqual(res.statusCode, 200, 'pre-rename org admins hold the org_admin permission the panel is gated on');
    assert.strictEqual(res.body.codes.length, 1);
    assert.strictEqual(res.body.codes[0].code, 'AAAA-BBBB-CCCC');
});

test('a legacy orgRole \'admin\' can still revoke a code', async () => {
    resetFxWithLegacy();
    const res = await dispatch({ method: 'DELETE', url: '/admin/nc-bindings/pairing-codes/pc_live', session: sess('lex') });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deleted, ['pc_live'], 'an org admin who can see a stale code must be able to kill it');
});

// Recorded as INTENDED, not discovered later: loadOrgAdmin also gates the
// generator, so routing the role test through isOrgAdminRole widened minting
// to legacy admins as well. The docblock on loadOrgAdmin argues the case —
// 'admin' is an org-admin variant at ~15 other call sites, and "may revoke a
// code but may not issue one" would be the odd rule. If a later change wants
// to split those two verbs it has to delete this test on purpose.
test('a legacy orgRole \'admin\' may also GENERATE a code — deliberate widening', async () => {
    resetFxWithLegacy();
    const res = await dispatch({ method: 'POST', url: '/admin/nc-bindings/generate-pairing-code', session: sess('lex'), body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.code, 'MINTED-CODE');
    assert.strictEqual(fx.minted.length, 1);
    assert.strictEqual(fx.minted[0].orgId, 'orgA', 'minted for the caller\'s own org');
    assert.strictEqual(fx.minted[0].mintedByUserId, 'lex');
});

// ═══ What the widening must NOT have reached ═════════════════════════

// The role test changed; the `freshUser.organizationId === orgId` conjunct next
// to it did not. Dropping it while editing that line would turn any org admin
// into a minter for every tenant — and the code IS the approval, so that hands
// out foreign tenantKeys.
test('a legacy admin of another org still cannot mint for orgA', async () => {
    resetFxWithLegacy();
    const res = await dispatch({
        method: 'POST', url: '/admin/nc-bindings/generate-pairing-code',
        session: sess('bo'), body: { organizationId: 'orgA' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.minted, [], 'a bearer credential for someone else\'s tenant must never be issued');
});

test('an org_admin of another org cannot mint for orgA either', async () => {
    resetFxWithLegacy();
    const res = await dispatch({
        method: 'POST', url: '/admin/nc-bindings/generate-pairing-code',
        session: sess('nora'), body: { organizationId: 'orgA' },
    });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.minted, []);
});

// Revoking has no target-org parameter — a foreign admin passes the role gate
// for their OWN org and is then stopped by deletePairingCode's org filter, so
// the refusal reads 404 ("not your code"), not 403. Pinned at that value so a
// refactor that lifts the filter out of the store cannot quietly let one
// tenant's admin deny another tenant's pairing.
test('an org admin of another org cannot revoke orgA\'s code', async () => {
    resetFxWithLegacy();
    const res = await dispatch({ method: 'DELETE', url: '/admin/nc-bindings/pairing-codes/pc_live', session: sess('nora') });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(fx.deleted, []);
    assert.strictEqual(fx.codes.length, 1, 'orgA\'s outstanding code survives');
});

// isOrgAdminRole is exactly ORG_ADMIN_VARIANTS — two values, not "anything
// admin-ish". The member/agent_editor denials from the top of this file must
// still hold on the write verbs too.
test('members and agent_editors are still refused on every pairing verb', async () => {
    for (const who of ['eva', 'ed']) {
        resetFxWithLegacy();
        const minted = await dispatch({ method: 'POST', url: '/admin/nc-bindings/generate-pairing-code', session: sess(who), body: {} });
        assert.strictEqual(minted.statusCode, 403, `${who} must not mint`);
        assert.deepStrictEqual(fx.minted, []);

        const revoked = await dispatch({ method: 'DELETE', url: '/admin/nc-bindings/pairing-codes/pc_live', session: sess(who) });
        assert.strictEqual(revoked.statusCode, 403, `${who} must not revoke`);
        assert.deepStrictEqual(fx.deleted, []);
    }
});

// The super-admin escape hatch sits in the same `if` as the role test; it has
// to survive the edit. 'root' carries no orgRole at all, so only the
// isSuperAdmin branch can be letting it through here.
test('a super admin with no orgRole can still mint for an org they are not in', async () => {
    resetFxWithLegacy();
    const res = await dispatch({
        method: 'POST', url: '/admin/nc-bindings/generate-pairing-code',
        session: sess('root'), body: { organizationId: 'orgA' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.minted.length, 1);
    assert.strictEqual(fx.minted[0].orgId, 'orgA');
});

// The other half of that branch: req.session.isAdmin, independent of the
// stored user row (eva's orgRole is 'member').
test('a session flagged isAdmin still passes the gate', async () => {
    resetFxWithLegacy();
    const res = await dispatch({ method: 'DELETE', url: '/admin/nc-bindings/pairing-codes/pc_live', session: sess('eva', { isAdmin: true }) });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deleted, ['pc_live']);
});
