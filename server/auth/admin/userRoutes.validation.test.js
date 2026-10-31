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
    '../passwordHash': { verify: async () => true, hash: async () => 'hash', needsRehash: () => false },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:user-routes-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]user(Routes|SupportRoutes)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./userRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../testUtils/routeHarness');

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

// ── The avatar upload, through a real multipart request ─────────────
// The stored extension is the file TYPE's (read from the bytes by
// middleware/uploadedImage.js), never the client's file name's, and the
// response shape is the one the Hub reads: { success, avatar, avatarType }.

test('POST /users/:id/avatar stores a PNG named x.html as .png and answers the same shape', async () => {
    const http = require('node:http');
    const fs = require('node:fs');
    const path = require('node:path');
    const express = require('express');
    const app = express();
    app.use('/auth', router);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    let storedFile = null;
    try {
        const form = new FormData();
        form.append('avatar', new Blob([png], { type: 'image/png' }), 'x.html');
        const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/users/u1/avatar`, { method: 'POST', body: form });
        const body = await res.json();
        assert.strictEqual(res.status, 200, JSON.stringify(body));
        assert.match(body.avatar, /^\/uploads\/user-avatar-u1-\d+\.png$/);
        assert.deepStrictEqual(body, { success: true, avatar: body.avatar, avatarType: 'image' });
        storedFile = path.join(__dirname, '..', '..', 'data', 'uploads', path.basename(body.avatar));
        assert.deepStrictEqual(fs.readFileSync(storedFile), png);
        assert.deepStrictEqual(touched.find((t) => t.what === 'updateUser').args, ['u1', { avatar: body.avatar, avatarType: 'image' }]);
    } finally {
        if (storedFile) fs.rmSync(storedFile, { force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});
