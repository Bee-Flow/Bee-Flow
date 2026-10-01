/**
 * What POST /users and POST /change-password accept, and what they say when
 * they refuse (auth/admin/userRoutes.js).
 *
 * PUT /users/:id has refused unknown keys since a pentest sent
 * {"isAdmin":true} and got 200 {"success":true} with the flag going nowhere —
 * "a report of success for a privilege change that did not happen is exactly
 * how a real escalation gets mistaken for a failed one". CREATE is the same
 * handler shape and never grew the guard, so the identical body made an
 * account and reported the same success. What this file pins:
 *
 *   - the 400 NAMES the field (`body.password`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused create makes no account.
 *
 * PUT /users/:id keeps its own unknown-field refusal: it answers with
 * `code: 'unknown_fields'` and the offending names, which a client can act on
 * more precisely than a generic shape error, and it is already closed.
 *
 * Run: cd server && node --test --test-force-exit auth/admin/userRoutes.validation.test.js
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
const hit = (what) => (...args) => { touched.push({ what, args }); };

const MOCKS = {
    '../permissions': {
        requireAuth: pass, requireAdmin: pass, requireSuperAdmin: pass,
        loadConfig: async () => ({ admin: { username: 'admin' } }),
        getUserPermissions: async () => ['all'],
        invalidatePermissionCache: async () => {},
        resolveUserOrgIds: async () => new Set(['orgA']),
        isOrgAdminRole: () => false,
    },
    './orgAdminGuards': {
        requireOrgAdminForUser: pass, isActiveUserStatus: () => true, wouldOrphanOrg: async () => false,
        orgsAdministeredBy: async () => new Set(['orgA']), repairIfOrphaned: async () => {},
        countOtherOrgAdmins: async () => 2, isOrgAdminForOrg: async () => true,
    },
    '../../stores/userStore': {
        getUser: async (id) => ({ id, username: id, passwordHash: 'h', email: 'u@example.test' }),
        getAllUsers: async () => [],
        getAllOrganizations: async () => [],
        createUserWithSeatCheck: async (u) => { touched.push({ what: 'createUserWithSeatCheck', args: [u] }); return { ok: true }; },
        createUser: hit('createUser'),
        updateUser: hit('updateUser'),
        logAccessAudit: async () => {},
        SeatCapExceededError: class SeatCapExceededError extends Error {},
    },
    '../passwordPolicy': { validatePassword: () => ({ ok: true }) },
    '../encryption': {
        rewrapUserDEKCompat: async () => { touched.push({ what: 'rewrapUserDEKCompat', args: [] }); return { success: true }; },
        adminResetUser: async () => ({}),
    },
    '../../core/entitlements/limits': { checkResourceLimits: async () => null },
    '../../utils/htmlSanitizer': { sanitizePlainTextFields: (o) => o },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    'bcryptjs': { compare: async () => true, hash: async () => 'hash' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:user-routes-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]userRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./userRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'root' }, isAdmin: true, save(cb) { cb(); } }) });

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

test('a create with no password is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/users', body: { username: 'bob' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Username and password required');
    assert.ok(res.body.details.some((d) => d.path === 'body.password'));
    assert.deepStrictEqual(touched, []);
});

test('{"isAdmin":true} on create is refused, as it already was on update', async () => {
    await refuses({
        method: 'POST', url: '/users',
        body: { username: 'bob', password: 'Password123!', isAdmin: true },
    }, 'body');
});

test('a numeric username is refused by name instead of becoming the account id', async () => {
    await refuses({ method: 'POST', url: '/users', body: { username: 42, password: 'Password123!' } }, 'body.username');
});

test('a misspelled new-password key is refused rather than read as absent', async () => {
    await refuses({
        method: 'POST', url: '/change-password',
        body: { oldPassword: 'old', newPasword: 'new' },
    }, 'body');
});

test('a real password change still re-wraps the key', async () => {
    const res = await dispatch({
        method: 'POST', url: '/change-password',
        body: { oldPassword: 'old', newPassword: 'Password123!' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'rewrapUserDEKCompat'));
});
