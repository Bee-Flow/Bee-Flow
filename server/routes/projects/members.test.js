'use strict';

/**
 * routes/projects/members.js on its own: the factory router served with
 * injected fakes behind a real express app and the real terminal error
 * handler. The organisation lookups and the org-admin check are swapped on
 * their own module objects (no module-system mocking). The same routes are
 * covered through the composed router in routes/projects.authz.test.js,
 * projects.principals.test.js and projects.transfer.test.js.
 *
 * Proven:
 *   - one shared mutation budget, built once, sits on every membership write;
 *   - an editor invites only while the project allows it, never over an
 *     existing member, and never across a tenant boundary;
 *   - unsharing a share of another project is a 404 (IDOR);
 *   - the owner cannot leave without handing the project over first;
 *   - a transfer refuses a stale owner and a non-member, and tells the bell;
 *   - an avatar is served only for a person of the project, as image bytes.
 *
 * Run: cd server && node --test routes/projects/members.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { makeSwaps } = require('../../testUtils/swaps');
const { fakeRequireProjectRole } = require('../../testUtils/projectRoleGate');

const ORGS = { alice: 'org1', bob: 'org1', carol: 'org1', mallory: 'org2' };
const swaps = makeSwaps();
swaps.swap(require('../../projects/projectOrg'), 'projectOrgOf', async (project) => project.organizationId || '');
swaps.swap(require('../../projects/projectOrg'), 'belongsToProjectOrg', async (userId, org) => (ORGS[userId] || '') === org);
swaps.swap(require('../../auth/admin/orgAdminGuards'), 'isOrgAdminForOrg', async () => false);
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { makeMembersRouter } = require('./members');
test.after(swaps.restore);

const fx = {};
function reset() {
    fx.project = { id: 'p1', ownerId: 'alice', organizationId: 'org1', editorsCanInvite: false };
    fx.shares = [{ id: 's-bob', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'bob', permission: 'editor' }];
    fx.recorded = [];
    fx.bells = [];
    fx.users = {
        alice: { id: 'alice', displayName: 'Alice', avatar: 'data:image/png;base64,iVBORw0K', avatarType: 'image' },
        bob: { id: 'bob', displayName: 'Bob' },
        carol: { id: 'carol', displayName: 'Carol' },
        mallory: { id: 'mallory', displayName: 'Mallory' },
    };
}
reset();

const limiterCalls = [];
const router = makeMembersRouter({
    requireProjectRole: fakeRequireProjectRole({ p1: { alice: 'owner', bob: 'editor', carol: 'viewer' } }),
    projectStore: {
        getProject: async (id) => (id === fx.project.id ? { ...fx.project } : null),
        getProjectShares: async () => fx.shares.map((s) => ({ ...s })),
        getShareById: async (id) => fx.shares.find((s) => s.id === id) || (id === 's-elsewhere' ? { id, projectId: 'p2' } : null),
        normalizePermission: (p) => p,
        shareProject: async (projectId, type, id, role) => {
            fx.shares.push({ id: `s-${id}`, projectId, sharedWithType: type, sharedWithId: id, permission: role });
            return `s-${id}`;
        },
        unshareProject: async (id) => { fx.shares = fx.shares.filter((s) => s.id !== id); return true; },
        updateMemberRole: async () => true,
        getProjectRole: async (userId) => (userId === 'bob' ? 'editor' : null),
        transferOwner: async ({ toUserId }) => { fx.project.ownerId = toUserId; return { ok: true }; },
    },
    userStore: {
        getUser: async (id) => fx.users[id] || null,
        getGroup: async () => null,
    },
    getUserId: (req) => req.session?.user?.id,
    resolveUserGroups: async () => [],
    recordProjectChange: async (projectId, actorId, action, details) => { fx.recorded.push([action, details]); },
    collabNotifier: new Proxy({}, { get: (_t, name) => async () => { fx.bells.push(name); } }),
    perUserRateLimit: (opts) => {
        limiterCalls.push(opts);
        return function rateLimiter(req, res, next) { next(); };
    },
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    req.session = who ? { user: { id: who, organizationId: 'org1' } } : {};
    next();
});
app.use('/api/projects', router);
app.use(terminalErrorHandler);
const server = http.createServer(app);
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
test.beforeEach(reset);

async function call(method, path, user, body) {
    await ready;
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/projects${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

test('one mutation budget, built once, on every membership write', () => {
    assert.deepStrictEqual(limiterCalls, [{ windowMs: 60_000, max: 30 }]);
    const limited = router.stack
        .filter((l) => l.route && l.route.stack.some((s) => s.name === 'rateLimiter'))
        .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    assert.deepStrictEqual(limited, [
        'POST /:id/share', 'DELETE /:id/share/:shareId', 'PUT /:id/members/:memberId',
        'POST /:id/transfer-owner', 'DELETE /:id/members/:memberId',
    ]);
});

test('an editor invites only while the owner allows it', async () => {
    const refused = await call('POST', '/p1/share', 'bob', { sharedWithType: 'user', sharedWithId: 'carol' });
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.body.code, 'invite_not_allowed');

    fx.project.editorsCanInvite = true;
    const ok = await call('POST', '/p1/share', 'bob', { sharedWithType: 'user', sharedWithId: 'carol' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(fx.recorded, [['member_added', { targetType: 'user', targetId: 'carol', role: 'viewer' }]]);
    assert.deepStrictEqual(fx.bells, ['added']);

    const over = await call('POST', '/p1/share', 'bob', { sharedWithType: 'user', sharedWithId: 'bob', permission: 'viewer' });
    assert.strictEqual(over.status, 403);
    assert.strictEqual(over.body.code, 'owner_only_role_change');
});

test('nobody is shared with across a tenant boundary', async () => {
    const res = await call('POST', '/p1/share', 'alice', { sharedWithType: 'user', sharedWithId: 'mallory' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /does not belong to this project's organisation/);
    assert.strictEqual(fx.shares.length, 1, 'nothing was written');
});

test('a share of another project cannot be removed through this one', async () => {
    const res = await call('DELETE', '/p1/share/s-elsewhere', 'alice');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(fx.recorded, []);
});

test('the owner hands the project over before leaving it', async () => {
    fx.shares.push({ id: 's-alice', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'alice', permission: 'editor' });
    const res = await call('DELETE', '/p1/members/s-alice', 'alice');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'transfer_first');

    const stranger = await call('DELETE', '/p1/members/s-bob', 'carol');
    assert.strictEqual(stranger.status, 403);
});

test('a transfer refuses a stale owner and a non-member, and rings the bell when it goes through', async () => {
    const stale = await call('POST', '/p1/transfer-owner', 'alice', { toUserId: 'bob', expectedOwnerId: 'carol' });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'owner_changed');

    const outsider = await call('POST', '/p1/transfer-owner', 'alice', { toUserId: 'carol' });
    assert.strictEqual(outsider.status, 400);
    assert.strictEqual(outsider.body.code, 'not_a_member');

    const notOwner = await call('POST', '/p1/transfer-owner', 'carol', { toUserId: 'bob' });
    assert.strictEqual(notOwner.status, 403);
    assert.strictEqual(notOwner.body.code, 'owner_only');

    const ok = await call('POST', '/p1/transfer-owner', 'alice', { toUserId: 'bob' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body, { success: true, ownerId: 'bob', keptAs: 'editor' });
    assert.deepStrictEqual(fx.recorded, [['owner_changed', { from: 'alice', to: 'bob', byOrgAdmin: false }]]);
    assert.deepStrictEqual(fx.bells, ['ownerChanged']);
});

test('an uploaded avatar is served for a person of the project only, as image bytes', async () => {
    const res = await call('GET', '/p1/avatars/alice', 'carol');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.type, 'image/png');
    assert.ok(Buffer.isBuffer(res.body) && res.body.length > 0);

    const outsider = await call('GET', '/p1/avatars/mallory', 'carol');
    assert.strictEqual(outsider.status, 404);
    const noPicture = await call('GET', '/p1/avatars/bob', 'carol');
    assert.strictEqual(noPicture.status, 404);
});
