/**
 * `orgScope` — the one answer to "which organisation is this request for".
 *
 * The four idioms it replaces disagreed, so the cases that used to separate
 * them are asserted here: a member who reaches an org only through a group, a
 * super-admin (no read filter, but still an org to act in), and a store read
 * that failed rather than came back empty.
 *
 * Run: cd server && node --test --test-force-exit auth/orgScope.test.js
 */

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');
const ORG_SCOPE = path.join(SERVER, 'auth', 'orgScope.js');

const fx = {
    user: { id: 'u1', role: 'user', groups: ['g1'], organizationId: 'orgA' },
    groups: [{ id: 'g1', organizationId: 'orgB' }],
    userThrows: false,
    groupsThrow: false,
    userReads: 0,
};

const userStoreStub = {
    getUser: async (id) => {
        fx.userReads += 1;
        if (fx.userThrows) throw new Error('user store unreachable');
        return id === fx.user.id ? fx.user : null;
    },
    getAllGroups: async () => {
        if (fx.groupsThrow) throw new Error('group store unreachable');
        return fx.groups;
    },
};

const STUB_ID = 'mock:org-scope:userStore';
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: userStoreStub };
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]orgScope\.js$/.test(parent.filename) && request === '../stores/userStore') {
        return STUB_ID;
    }
    return originalResolve.call(this, request, parent, ...rest);
};
after(() => { Module._resolveFilename = originalResolve; });

delete require.cache[ORG_SCOPE];
const { orgScope, requireOrgScope } = require(ORG_SCOPE);

const REQ = (session = {}) => ({ session: { user: { id: 'u1', role: 'user' }, ...session } });

beforeEach(() => {
    fx.user = { id: 'u1', role: 'user', groups: ['g1'], organizationId: 'orgA' };
    fx.groups = [{ id: 'g1', organizationId: 'orgB' }];
    fx.userThrows = false;
    fx.groupsThrow = false;
    fx.userReads = 0;
});

test('the ordinary read: the account\'s own org, plus every org a group grants', async () => {
    const scope = await orgScope(REQ());
    assert.deepEqual([...scope.orgIds].sort(), ['orgA', 'orgB']);
    assert.equal(scope.orgId, 'orgA', 'acted in: the org on the account');
    assert.equal(scope.homeOrgId, 'orgA');
    assert.equal(scope.identityError, null);
});

test('a member with no org of their own acts in the first org a group grants', async () => {
    fx.user = { id: 'u1', role: 'user', groups: ['g1'], organizationId: null };
    const scope = await orgScope(REQ());
    assert.equal(scope.orgId, 'orgB');
    assert.equal(scope.homeOrgId, null, 'the group is not a home org — an org-admin role must not travel through it');
});

test('an org-less account holding the EMPTY STRING is not a tenant', async () => {
    fx.user = { id: 'u1', role: 'user', groups: [], organizationId: '' };
    const scope = await orgScope(REQ());
    assert.equal(scope.orgId, null);
    assert.equal(scope.orgIds.size, 0);
});

test('a super-admin gets no read filter, but still an org to act in', async () => {
    const scope = await orgScope(REQ({ isAdmin: true }));
    assert.equal(scope.orgIds, null, 'null is what every list query reads as "no filter"');
    assert.equal(scope.orgId, 'orgA', 'a super-admin who is a member still acts somewhere');
    assert.equal(scope.isSuperAdmin, true);
});

test('an anonymous request reaches no org, and gets its own Set', async () => {
    const a = await orgScope({ session: {} });
    const b = await orgScope({});
    assert.equal(a.orgId, null);
    assert.equal(a.orgIds.size, 0);
    a.orgIds.add('orgA');
    assert.equal(b.orgIds.size, 0, 'one caller narrowing its answer must not narrow the next');
});

test('an unreadable account degrades, and says so', async () => {
    fx.userThrows = true;
    const scope = await orgScope(REQ());
    assert.equal(scope.orgId, null);
    assert.match(scope.identityError, /account could not be read/);
});

test('an unreadable group table leaves the home org standing, and says so', async () => {
    fx.groupsThrow = true;
    const scope = await orgScope(REQ());
    assert.deepEqual([...scope.orgIds], ['orgA']);
    assert.match(scope.identityError, /groups could not be read/);
});

test('`strict` turns an unreadable read into a throw — what the 503 gates need', async () => {
    fx.userThrows = true;
    await assert.rejects(() => orgScope(REQ(), { strict: true }), /user store unreachable/);
    fx.userThrows = false;
    fx.groupsThrow = true;
    await assert.rejects(() => orgScope(REQ(), { strict: true }), /group store unreachable/);
});

test('a degraded read is never memoised, so a later strict caller still refuses', async () => {
    fx.userThrows = true;
    const req = REQ();
    await orgScope(req);
    await assert.rejects(() => orgScope(req, { strict: true }), /user store unreachable/);
});

test('a complete read is memoised: a gate and its handler cost one read', async () => {
    const req = REQ();
    await orgScope(req);
    await orgScope(req);
    assert.equal(fx.userReads, 1);
});

test('requireOrgScope refuses an org-less account by naming the reason', async () => {
    fx.user = { id: 'u1', role: 'user', groups: [], organizationId: null };
    await assert.rejects(() => requireOrgScope(REQ()), (e) => {
        assert.equal(e.status, 403);
        assert.equal(e.code, 'org_scope_required');
        assert.equal(e.expose, true);
        return true;
    });
});

test('requireOrgScope answers 503, not 403, when nobody could check', async () => {
    fx.userThrows = true;
    await assert.rejects(() => requireOrgScope(REQ()), (e) => {
        assert.equal(e.status, 503, 'a degraded lookup must not read as a policy decision');
        assert.equal(e.code, 'org_scope_unavailable');
        return true;
    });
});

test('requireOrgScope passes the scope through when there is an org', async () => {
    const scope = await requireOrgScope(REQ());
    assert.equal(scope.orgId, 'orgA');
});
