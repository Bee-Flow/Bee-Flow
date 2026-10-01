/**
 * What the feature- and access-toggle bodies accept, and what they say when
 * they refuse (auth/admin/featureAccessRoutes.js).
 *
 * Every route here CLAMPS the list it is given to what the plan, the licence
 * or the org access menu allows, and then reports the clamped list back in the
 * response. That narrowing is deliberate and visible, and it is untouched.
 *
 * What was silent is the KEY. None of these bodies refused one it did not
 * recognise, so `{"grantd":[...]}` on a capability grant was answered 200 with
 * the UNCHANGED list echoed back — which on screen is indistinguishable from a
 * save that worked. What this file pins:
 *
 *   - the 400 NAMES the field (`body.granted`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused toggle grants nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/admin/featureAccessRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
// Mutable fixture for the group-scoped beta tests at the bottom; the defaults
// keep the validation tests above exactly as they were (no capabilities).
const fx = {
    caps: [],
    snap: { ceiling: {}, orgAvailable: {} },
    groups: [{ id: 'finance', organizationId: 'orgA' }],
    betaEveryone: null,
};
const pass = (req, res, next) => next();
const hit = (what) => (...args) => { touched.push({ what, args }); };

const MOCKS = {
    '../permissions': {
        requireAuth: pass, requireAdmin: pass,
        getUserPermissions: async () => ['all'],
        resolveUserOrgIds: async () => new Set(['orgA']),
        invalidateAllPermissionCaches: async () => { touched.push({ what: 'invalidateAllPermissionCaches', args: [] }); },
        GROUP_GRANT_IMPLIED_PERMISSIONS: { meeting_notes: ['use_meeting_notes'] },
    },
    './orgAdminGuards': { requireOrgAdmin: () => pass },
    './integrationCatalog': { ALL_INTEGRATIONS: [{ id: 'gmail' }, { id: 'drive' }] },
    '../../stores/userStore': {
        getUser: async (id) => ({ id, organizationId: 'orgA', orgRole: 'org_admin' }),
        getOrganization: async (id) => ({ id, enabledIntegrations: null }),
        getAllGroups: async () => fx.groups,
        getOrgEnabledBetaFeatures: async () => [],
        setOrgEnabledBetaFeatures: hit('setOrgEnabledBetaFeatures'),
        setOrgEnabledIntegrations: async (...a) => { touched.push({ what: 'setOrgEnabledIntegrations', args: a }); return true; },
        setOrgAvailableCapabilities: hit('setOrgAvailableCapabilities'),
        setOrgGrantedCapabilities: async (...a) => { touched.push({ what: 'setOrgGrantedCapabilities', args: a }); return true; },
        getOrgBetaEveryone: async () => fx.betaEveryone,
        setOrgBetaEveryone: async (...a) => { touched.push({ what: 'setOrgBetaEveryone', args: a }); return true; },
        updateGroup: async (...a) => { touched.push({ what: 'updateGroup', args: a }); return true; },
        logAccessAudit: async () => {},
    },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
    '../../core/entitlements/betaFeatures': {
        BETA_FEATURES: [],
        getOrgBetaFeatures: async () => [],
        setOrgBetaFeatures: async (...a) => { touched.push({ what: 'setOrgBetaFeatures', args: a }); return true; },
        getEffectiveOrgBetaAllowList: async () => [],
    },
    '../../core/entitlements/entitlements': {
        registry: {
            getCapability: (id) => fx.caps.find(c => c.id === id) || null,
            listCapabilities: () => fx.caps,
            list: () => fx.caps,
            refreshMcpIntegrationDescriptors: async () => {},
            refreshModuleCapabilityFilter: async () => {},
        },
        invalidateForOrg: async () => {},
        resolveEntitlements: async () => fx.snap,
        snapshotHas: () => false,
    },
    '../../modules': { listInactiveCapabilityIds: async () => [] },
    '../../license': { getLicense: async () => null },
    '../../services/planEntitlements': { getOrgCaps: async () => ({}) },
    '../../core/customIntegrations/featureFlag': { customIntegrationsEnabled: async () => false },
    '../../core/integrations/ncIntegrationCatalog': { NC_INTEGRATION_IDS: [], NC_INTEGRATION_ID_SET: new Set() },
    '../../stores/orgCustomIntegrationStore': { listForOrg: async () => [] },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:feature-access-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]featureAccessRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./featureAccessRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
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

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a capability grant with a misspelled key is refused, not echoed back unchanged', async () => {
    await refuses({ method: 'PUT', url: '/organizations/orgA/org-access', body: { grantd: ['x'] } }, 'body.granted');
});

test('a body with no granted list is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'PUT', url: '/organizations/orgA/org-access', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'granted must be an array of capability ids');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled integrations key is refused rather than saving the old list', async () => {
    await refuses({ method: 'PUT', url: '/organizations/orgA/active-integrations', body: { enabld: ['gmail'] } }, 'body.enabled');
});

test('a group grant that is a bare string is refused in the same words', async () => {
    const res = await dispatch({ method: 'PUT', url: '/groups/finance/access', body: { granted: 'page_chat' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'granted must be an array of capability ids');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled self-scoped key is refused instead of a no-op 200', async () => {
    await refuses({ method: 'PUT', url: '/me/active-features', body: { betaEnabld: ['x'] } }, 'body');
});

test('the clamping itself is untouched — an id outside the ceiling is still dropped, visibly', async () => {
    // The response carries the clamped list, which is how the caller learns
    // what survived. That is a narrowing the route reports, not a silent one.
    const res = await dispatch({ method: 'PUT', url: '/organizations/orgA/active-integrations', body: { enabled: ['gmail', 'not-a-real-integration'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.enabled, ['gmail']);
});


// ── Group-scoped betas (meeting_notes) ──────────────────────────────────────
// The "All members" toggle of a group-scoped beta is stored in its own list
// (org_beta_everyone) in BOTH modes, and a group may hold the beta on its own.
describe('group-scoped betas in the Access matrix', () => {
    const MEETING = { id: 'meeting_notes', kind: 'beta', name: 'Meeting Notes', userFacing: true, groupTogglable: true, groupScoped: true };
    const WEBPAGES = { id: 'webpages', kind: 'beta', name: 'Webpages', userFacing: true, groupTogglable: true, groupScoped: false };
    const NOTEBOOKS = { id: 'notebooks', kind: 'core', name: 'Notebooks', userFacing: true, groupTogglable: true };
    const snapWith = (mode, betas) => ({
        mode,
        ceiling: { core: ['notebooks'], beta: betas, integration: [] },
        orgAvailable: { core: ['notebooks'], beta: betas, integration: [] },
        orgEnabled: { core: ['notebooks'], beta: betas.filter(b => b !== 'meeting_notes'), integration: [] },
    });
    const stored = (what) => touched.filter(t => t.what === what).map(t => t.args);

    const STATIC_BETAS = MOCKS['../../core/entitlements/betaFeatures'].BETA_FEATURES;
    test.beforeEach(() => {
        STATIC_BETAS.length = 0;
        STATIC_BETAS.push({ id: 'meeting_notes', groupScoped: true }, { id: 'webpages' });
        fx.caps = [MEETING, WEBPAGES, NOTEBOOKS];
        fx.snap = snapWith('cloud', ['meeting_notes', 'webpages']);
        fx.groups = [{ id: 'finance', organizationId: 'orgA', granted_capabilities: [] }];
        fx.betaEveryone = null;
    });
    test.after(() => {
        STATIC_BETAS.length = 0;
        fx.caps = [];
        fx.snap = { ceiling: {}, orgAvailable: {} };
        fx.groups = [{ id: 'finance', organizationId: 'orgA' }];
        fx.betaEveryone = null;
    });

    test('the matrix payload flags the group-scoped beta and reads everyone from the resolver', async () => {
        const res = await dispatch({ method: 'GET', url: '/organizations/orgA/group-access' });
        assert.strictEqual(res.statusCode, 200);
        const meeting = res.body.capabilities.find(c => c.id === 'meeting_notes');
        assert.strictEqual(meeting.groupScoped, true);
        assert.strictEqual(res.body.capabilities.find(c => c.id === 'webpages').groupScoped, false);
        assert.ok(!res.body.everyone.includes('meeting_notes'));
        assert.ok(res.body.everyone.includes('webpages'));
    });

    for (const mode of ['cloud', 'self-hosted']) {
        test(`${mode}: switching it off for All members stores an empty everyone-list`, async () => {
            fx.snap = snapWith(mode, ['meeting_notes', 'webpages']);
            const res = await dispatch({ method: 'PUT', url: '/organizations/orgA/org-access', body: { granted: ['webpages', 'notebooks'] } });
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(stored('setOrgBetaEveryone'), [['orgA', []]]);
        });

        test(`${mode}: switching it on for All members stores it`, async () => {
            fx.snap = snapWith(mode, ['meeting_notes', 'webpages']);
            await dispatch({ method: 'PUT', url: '/organizations/orgA/org-access', body: { granted: ['meeting_notes'] } });
            assert.deepStrictEqual(stored('setOrgBetaEveryone'), [['orgA', ['meeting_notes']]]);
        });
    }

    test('a group-scoped beta outside the org\'s access keeps its stored state', async () => {
        // Not in the menu: the admin cannot see it, so a save must not decide it.
        fx.snap = snapWith('cloud', ['webpages']);
        fx.betaEveryone = null; // never chosen ⇒ everyone
        await dispatch({ method: 'PUT', url: '/organizations/orgA/org-access', body: { granted: ['webpages'] } });
        assert.deepStrictEqual(stored('setOrgBetaEveryone'), [['orgA', ['meeting_notes']]]);

        touched.length = 0;
        fx.betaEveryone = [];
        await dispatch({ method: 'PUT', url: '/organizations/orgA/org-access', body: { granted: ['webpages'] } });
        assert.deepStrictEqual(stored('setOrgBetaEveryone'), [['orgA', []]]);
    });

    test('a save while the Meeting Notes module is inactive keeps its stored state', async () => {
        // listCapabilities() leaves out an inactive module's capabilities, so
        // the matrix did not show it; getCapability still knows it.
        fx.caps = [WEBPAGES, NOTEBOOKS];
        MOCKS['../../core/entitlements/entitlements'].registry.getCapability = (id) => [MEETING, WEBPAGES, NOTEBOOKS].find(c => c.id === id) || null;
        try {
            fx.betaEveryone = null;
            await dispatch({ method: 'PUT', url: '/organizations/orgA/org-access', body: { granted: ['webpages'] } });
            assert.deepStrictEqual(stored('setOrgBetaEveryone'), [['orgA', ['meeting_notes']]]);

            touched.length = 0;
            fx.betaEveryone = [];
            await dispatch({ method: 'PUT', url: '/organizations/orgA/org-access', body: { granted: ['webpages'] } });
            assert.deepStrictEqual(stored('setOrgBetaEveryone'), [['orgA', []]]);
        } finally {
            MOCKS['../../core/entitlements/entitlements'].registry.getCapability = (id) => fx.caps.find(c => c.id === id) || null;
        }
    });

    test('a stored id that is no longer a group-scoped beta is kept', async () => {
        fx.betaEveryone = ['retired_beta'];
        await dispatch({ method: 'PUT', url: '/organizations/orgA/org-access', body: { granted: ['meeting_notes'] } });
        assert.deepStrictEqual(stored('setOrgBetaEveryone'), [['orgA', ['meeting_notes', 'retired_beta']]]);
    });

    test('PUT /groups/:id/access stores the grant and refreshes permission caches', async () => {
        const res = await dispatch({ method: 'PUT', url: '/groups/finance/access', body: { granted: ['meeting_notes', 'not-a-capability'] } });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.granted, ['meeting_notes']);
        assert.deepStrictEqual(stored('updateGroup'), [['finance', { grantedCapabilities: ['meeting_notes'] }]]);
        assert.strictEqual(stored('invalidateAllPermissionCaches').length, 1, 'use_meeting_notes derives from the grant');
    });

    test('a group grant outside the org\'s access is dropped', async () => {
        fx.snap = snapWith('cloud', ['webpages']);
        const res = await dispatch({ method: 'PUT', url: '/groups/finance/access', body: { granted: ['meeting_notes'] } });
        assert.deepStrictEqual(res.body.granted, []);
        assert.strictEqual(stored('invalidateAllPermissionCaches').length, 0, 'nothing implied changed');
    });
});
