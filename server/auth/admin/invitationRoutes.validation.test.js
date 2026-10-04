/**
 * What POST /invitations accepts, and what it says when it refuses
 * (auth/admin/invitationRoutes.js).
 *
 * `role` was stored as `role || 'user'` with no check at all, so an invitation
 * could carry a role this installation does not define. That role is what the
 * invitee is SHOWN on the invite screen and what the e-mail names, so an
 * unknown value is a promise to a person that nothing can keep. What this file
 * pins:
 *
 *   - the 400 NAMES the field (`body.email`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - an unknown role is refused by name;
 *   - the store is never reached, so a refused invite sends no mail.
 *
 * Run: cd server && node --test --test-force-exit auth/admin/invitationRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../permissions': {
        requireAuth: pass,
        getOrgRolePermissions: () => ({ org_admin: [], agent_admin: [], member: [] }),
    },
    './orgAdminGuards': { isOrgAdminForOrg: async () => true },
    '../../stores/userStore': {
        getUser: async (id) => ({ id, organizationId: 'orgA', displayName: 'Root' }),
        getUserByEmail: async () => null,
        getOrganization: async () => ({ id: 'orgA', name: 'Acme' }),
        getEffectiveLimits: async () => ({ max_users: -1 }),
        getActiveSeatCount: async () => 1,
        logAccessAudit: async () => {},
    },
    '../../stores/invitationStore': {
        createInvitation: async (inv) => { touched.push({ what: 'createInvitation', args: [inv] }); return { id: 'i1', token: 't', expiresAt: 'later' }; },
        getInvitationsForOrg: async () => [],
        getInvitationById: async () => null,
        deleteInvitation: async () => true,
    },
    '../../utils/emailService': { sendInvitationEmail: async () => ({ success: true }) },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:invitation-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]invitationRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./invitationRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'root' }, isAdmin: true }) });

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

test('an invitation with no address is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/invitations', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Email is required');
    assert.ok(res.body.details.some((d) => d.path === 'body.email'));
    assert.deepStrictEqual(touched, []);
});

test('a role this installation does not define is refused by name', async () => {
    const res = await dispatch({
        method: 'POST', url: '/invitations',
        body: { email: 'new@acme.test', role: 'org_admn' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'unknown_role');
    assert.deepStrictEqual(touched, [], 'no invitation may be created for a role nobody has');
});

test('a misspelled key is refused rather than dropped from the invitation', async () => {
    await refuses({ method: 'POST', url: '/invitations', body: { email: 'new@acme.test', rol: 'member' } }, 'body');
});

test('a role the installation does define still travels to the invitee', async () => {
    const res = await dispatch({
        method: 'POST', url: '/invitations',
        body: { email: ' new@acme.test ', role: 'agent_admin' },
    });
    assert.strictEqual(res.statusCode, 200);
    const created = touched.find((t) => t.what === 'createInvitation').args[0];
    assert.strictEqual(created.role, 'agent_admin');
    assert.strictEqual(created.email, 'new@acme.test', 'trimmed once, by the schema');
});
