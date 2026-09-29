/**
 * DB-free tests for the support staff gate (H6 — new shared home for the
 * admin_support permission check + acting-org resolution).
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');

const fx = {
    superAdmin: false,
    perms: [],
    permsThrow: null,
    orgIds: new Set(),
    permCalls: [],
};

const restore = installResolveStub({
    '../auth/permissions': {
        isSuperAdmin: () => fx.superAdmin,
        getUserPermissions: async (userId, session) => {
            fx.permCalls.push([userId, session]);
            if (fx.permsThrow) throw fx.permsThrow;
            return fx.perms;
        },
        resolveUserOrgIds: async () => fx.orgIds,
    },
});

const { hasSupportPerms, hasAdminSupport, actingOrgId } = require('./staffAccess');

test.after(() => restore());
test.beforeEach(() => {
    fx.superAdmin = false;
    fx.perms = [];
    fx.permsThrow = null;
    fx.orgIds = new Set();
    fx.permCalls = [];
});

test('hasSupportPerms: array + Set shapes, all-wildcard, garbage', () => {
    assert.strictEqual(hasSupportPerms(['admin_support']), true);
    assert.strictEqual(hasSupportPerms(['all']), true);
    assert.strictEqual(hasSupportPerms(['other']), false);
    assert.strictEqual(hasSupportPerms(new Set(['admin_support'])), true);
    assert.strictEqual(hasSupportPerms(new Set(['all'])), true);
    assert.strictEqual(hasSupportPerms(new Set(['x'])), false);
    assert.strictEqual(hasSupportPerms(null), false);
    assert.strictEqual(hasSupportPerms('admin_support'), false);
});

test('hasAdminSupport: super-admin short-circuits without a permission lookup', async () => {
    fx.superAdmin = true;
    assert.strictEqual(await hasAdminSupport({ session: {} }, null), true);
    assert.deepStrictEqual(fx.permCalls, []);
});

test('hasAdminSupport: no userId → false without lookup', async () => {
    assert.strictEqual(await hasAdminSupport({ session: {} }, null), false);
    assert.deepStrictEqual(fx.permCalls, []);
});

test('hasAdminSupport: permission path passes userId + session through', async () => {
    fx.perms = ['admin_support'];
    const req = { session: { user: { id: 'u1' } } };
    assert.strictEqual(await hasAdminSupport(req, 'u1'), true);
    assert.deepStrictEqual(fx.permCalls, [['u1', req.session]]);

    fx.perms = ['something_else'];
    assert.strictEqual(await hasAdminSupport(req, 'u1'), false);
});

test('hasAdminSupport: lookup failure warns and fails closed', async () => {
    fx.permsThrow = new Error('perm store down');
    assert.strictEqual(await hasAdminSupport({ session: {} }, 'u1'), false);
});

test('actingOrgId: super-admin and null orgIds resolve to null (system scope)', async () => {
    fx.superAdmin = true;
    assert.strictEqual(await actingOrgId({ session: {} }), null);

    fx.superAdmin = false;
    fx.orgIds = null;
    assert.strictEqual(await actingOrgId({ session: {} }), null);
});

test('actingOrgId: first org of the set; empty set → null', async () => {
    fx.orgIds = new Set(['org-a', 'org-b']);
    assert.strictEqual(await actingOrgId({ session: {} }), 'org-a');

    fx.orgIds = new Set();
    assert.strictEqual(await actingOrgId({ session: {} }), null);
});
