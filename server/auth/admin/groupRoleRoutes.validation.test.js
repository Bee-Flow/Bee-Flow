/**
 * What the group and role bodies accept, and what they say when they refuse
 * (auth/admin/groupRoleRoutes.js).
 *
 * Groups and roles are the objects that DEFINE permissions, and neither body
 * refused a key it did not recognise: `{"permisions":["all"]}` was answered
 * 200 {"success":true} with nothing changed. PUT /users/:id closed exactly
 * this after a pentest — a report of success for a privilege change that did
 * not happen is how a real escalation gets mistaken for a failed one — and the
 * objects the privileges live in were left open. What this file pins:
 *
 *   - the 400 NAMES the field, not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the list-shape refusals keep their exact wording: the schema delegates
 *     to invalidStringArrayField, so "use [] to clear it, not null" is still
 *     the one definition of what a list field may be;
 *   - the store is never reached, so a refused request grants nothing.
 *
 * The permission and role IDS stay unenumerated on purpose — they are
 * installation-defined, and the handlers already refuse any the caller could
 * not grant, which is the check that matters.
 *
 * Run: cd server && node --test --test-force-exit auth/admin/groupRoleRoutes.validation.test.js
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
        requirePrimaryOrgAdmin: () => (req, _res, next) => { req.primaryOrgId = 'orgA'; next(); },
        getUserPermissions: async () => ['all'],
        invalidateAllPermissionCaches: async () => {},
        resolveUserOrgIds: async () => new Set(['orgA']),
        SYSTEM_PERMISSIONS: [],
        getOrgRolePermissions: () => ({ member: [], org_admin: [] }),
    },
    '../orgRolePolicy': {
        setOrgRolePermissions: async (orgId, role, perms) => { touched.push({ what: 'setOrgRolePermissions', args: [orgId, role, perms] }); return perms; },
    },
    '../../stores/userStore': {
        getAllUsers: async () => [],
        getAllGroups: async () => [{ id: 'finance', name: 'Finance', organizationId: 'orgA', permissions: [], roles: [] }],
        getAllRoles: async () => [{ id: 'reader', name: 'Reader', permissions: [] }],
        getAllOrganizations: async () => [],
        getUser: async (id) => ({ id, organizationId: 'orgA' }),
        createGroup: hit('createGroup'),
        updateGroup: async (id, u) => { touched.push({ what: 'updateGroup', args: [id, u] }); return true; },
        createRole: hit('createRole'),
        updateRole: hit('updateRole'),
        logAccessAudit: async () => {},
    },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:group-role-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]groupRoleRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./groupRoleRoutes');
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

test('a group with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/groups', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Group name required');
    assert.ok(res.body.details.some((d) => d.path === 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled permissions key is refused, not answered "saved"', async () => {
    // The whole point: a 200 here reads as "the privilege changed".
    await refuses({ method: 'PUT', url: '/groups/finance', body: { permisions: ['all'] } }, 'body');
});

test('a misspelled roles key on create is refused too', async () => {
    await refuses({ method: 'POST', url: '/groups', body: { name: 'Pwn', rolls: ['admin'] } }, 'body');
});

test('the list-shape refusals keep the wording the helper already owned', async () => {
    const asString = await dispatch({ method: 'PUT', url: '/groups/finance', body: { roles: 'admin' } });
    assert.strictEqual(asString.statusCode, 400);
    assert.match(asString.body.error, /roles must be an array/);
    const asNull = await dispatch({ method: 'PUT', url: '/groups/finance', body: { roles: null } });
    assert.match(asNull.body.error, /use \[\] to clear it, not null/);
    assert.deepStrictEqual(touched, []);
});

test('a role body with a misspelled key is refused rather than half-applied', async () => {
    await refuses({ method: 'POST', url: '/roles', body: { name: 'Support', permisions: ['all'] } }, 'body');
});

test('a member add with a misspelled key is refused, not read as "no user"', async () => {
    await refuses({ method: 'POST', url: '/groups/finance/members', body: { userID: 'u1' } }, 'body');
});

test('org-role permissions still require an array, in the same words', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org-roles/member', body: { permissions: 'page_chat' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'permissions must be an array');
    assert.deepStrictEqual(touched, []);
});

test('a well-formed group edit still reaches the store', async () => {
    const res = await dispatch({ method: 'PUT', url: '/groups/finance', body: { permissions: ['page_chat'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateGroup').args[1].permissions, ['page_chat']);
});
