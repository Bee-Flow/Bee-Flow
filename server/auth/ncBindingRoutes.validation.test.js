/**
 * What the pairing-code route accepts, and what it says when it refuses
 * (auth/ncBindingRoutes.js).
 *
 * `organizationId` is optional — absent means "my own organisation" — and a
 * mis-spelled key meant the same thing SILENTLY, so an admin minting a pairing
 * code for another tenant got one for their own instead, and the two codes
 * look identical. What this file pins:
 *
 *   - the 400 NAMES the field, not just "invalid request";
 *   - the message is a sentence;
 *   - no code is minted for a request that was not understood.
 *
 * And what removing a binding leaves on the organisation row: the binding
 * fields are cleared, and with them what says "the sync mode is chosen"
 * (services/ncSyncStart.mts), so the next Nextcloud this organisation is bound
 * to is asked who gets an account before anything is mirrored.
 *
 * Run: cd server && node --test --test-force-exit auth/ncBindingRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
/** Extra fields of the organisation row the store stub returns (the binding tests set them). */
let boundOrg = {};
const pass = (req, res, next) => next();

const MOCKS = {
    './permissions': { requireAuth: pass, isOrgAdminRole: () => true },
    '../stores/userStore': {
        getUser: async (id) => ({ id, organizationId: 'orgA', orgRole: 'org_admin', role: 'admin' }),
        getOrganization: async (id) => ({ id, name: 'Acme', ...boundOrg }),
        updateOrganization: async (id, updates) => { touched.push({ what: 'updateOrganization', args: [id, updates] }); return true; },
        createOrgPairingCode: async (orgId) => { touched.push({ what: 'createOrgPairingCode', args: [orgId] }); return { code: 'ABC', expiresAt: 'later' }; },
        listOrgPairingCodes: async () => [],
        logAccessAudit: async () => {},
    },
    '../stores/configStore': { getConfig: async () => null, setConfig: async () => {}, deleteConfig: async (key) => { touched.push({ what: 'deleteConfig', args: [key] }); } },
    './connectorJwt': { invalidateTenantKeyCache: () => {} },
    './connectorBootstrap': { helpers: { ensureOrgAdminUser: async () => {}, bindOrgToNcInstance: async () => {}, getOrMintTenantKey: async () => 'k' } },
    '../services/orgHealth': { event: async () => {}, emit: () => {} },
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:nc-binding-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]ncBindingRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./ncBindingRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: session || { user: { id: 'root' }, isAdmin: true }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; boundOrg = {}; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.ok(res.body.details ? res.body.details.some((d) => d.path === field) : true,
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a misspelled organisation key is refused, not read as "my own org"', async () => {
    await refuses({
        method: 'POST', url: '/admin/nc-bindings/generate-pairing-code',
        body: { organisationId: 'orgB' },
    }, 'body');
});

test('a numeric organisation id is refused by name', async () => {
    await refuses({
        method: 'POST', url: '/admin/nc-bindings/generate-pairing-code',
        body: { organizationId: 42 },
    }, 'body.organizationId');
});

test('an empty body still means "my own organisation"', async () => {
    const res = await dispatch({ method: 'POST', url: '/admin/nc-bindings/generate-pairing-code', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'createOrgPairingCode').args[0], 'orgA');
});

// ── Removing a binding ──────────────────────────────────────────────────────

const { chosenByRow, syncModeChosen } = require('../services/ncSyncStart.mts');

test('removing a binding clears it, puts the sync mode back to the column default and forgets the last sync', async () => {
    boundOrg = {
        authMethod: 'nextcloud_connector', nc_instance_id: 'inst-1', nc_base_url: 'https://cloud.example.org', nc_admin_uid: 'root',
        nc_provisioned_at: '2026-01-05T09:00:00Z', nc_onboarding_completed_at: '2026-01-05T10:00:00Z',
        nc_sync_mode: 'selective_groups', nc_last_sync_at: '2026-11-09T06:00:00Z',
    };
    const res = await dispatch({ method: 'DELETE', url: '/admin/nc-bindings/org/orgB' });
    assert.strictEqual(res.statusCode, 200);
    const updates = touched.filter((t) => t.what === 'updateOrganization');
    assert.deepStrictEqual(updates, [{ what: 'updateOrganization', args: ['orgB', {
        ncInstanceId: null, ncBaseUrl: null, ncAdminUid: null, ncProvisionedAt: null,
        connectorCallbackUrl: null, ncOnboardingCompletedAt: null,
        ncSyncMode: 'mirror_all', ncLastSyncAt: null, authMethod: null,
    }] }]);
    assert.deepStrictEqual(touched.filter((t) => t.what === 'deleteConfig').map((t) => t.args[0]), ['connector_tenant_key_orgB']);

    // The row as it is after a new binding: the sync mode does not count as chosen,
    // and the users of the earlier binding are asked for by the day of the new one.
    const u = updates[0].args[1];
    const boundAgain = {
        id: 'orgB', nc_instance_id: 'inst-2', nc_provisioned_at: '2026-11-10T09:00:00Z',
        nc_onboarding_completed_at: u.ncOnboardingCompletedAt, nc_sync_mode: u.ncSyncMode, nc_last_sync_at: u.ncLastSyncAt,
    };
    assert.strictEqual(chosenByRow(boundAgain), false);
    const asked = [];
    assert.strictEqual(await syncModeChosen(boundAgain, async (id, afterDay) => { asked.push([id, afterDay]); return false; }), false);
    assert.deepStrictEqual(asked, [['orgB', '2026-11-10']]);
});

test('an organisation without a binding answers 409 and is left as it is', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/admin/nc-bindings/org/orgB' });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(touched, []);
});

test('approving or denying a pending binding takes no fields: one sent is refused by name', async () => {
    for (const action of ['approve', 'deny']) {
        await refuses({ method: 'POST', url: `/admin/nc-bindings/pb1/${action}`, body: { orgId: 'orgB' } }, 'body');
    }
});
