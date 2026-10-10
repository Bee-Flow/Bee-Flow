/**
 * GET /api/projects/:id/principals: the invite picker's directory.
 *
 * Viewer+, scoped to the project's organisation, id + name (+ avatar) only:
 * never an e-mail address.
 *
 * Run: cd server && node --test routes/projects.principals.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const fx = { role: 'viewer', project: null, members: [], groups: [], counts: new Map(), avatars: [], asked: [] };

const MOCKS = {
    '../stores/projectStore': {
        getProject: async () => fx.project,
        getProjectShares: async () => [],
        normalizePermission: (p) => p,
        listUserProjects: async () => [],
        recordActivityEvent: async () => null,
    },
    '../stores/userStore': {
        getUser: async () => null,
        getGroup: async () => null,
        getAllGroups: async () => fx.groups,
        getOrgMembersForDirectory: async (orgId) => { fx.asked.push(orgId); return fx.members.filter(m => m.organizationId === orgId); },
        getUserAvatarsByIds: async (ids) => fx.avatars.filter(a => ids.includes(a.id)),
    },
    '../stores/automationStore': {
        countGroupMembers: async () => fx.counts,
    },
    '../stores/knowledgeBases': { getKB: async () => null },
    '../support/kbAccess': { partitionAccessibleKBIds: async () => ({ allowed: [], denied: [] }) },
    '../auth': { resolveUserGroups: async () => [] },
    '../auth/projectAccess': {
        requireProjectRole: (minRole) => async (req, res, next) => {
            const order = { viewer: 0, editor: 1, owner: 2 };
            if (!fx.role) return res.status(404).json({ error: 'Not found' });
            if (order[fx.role] < order[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
            req.projectRole = fx.role;
            next();
        },
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    '../projects/collabNotify': { makeCollabNotifier: () => new Proxy({}, { get: () => async () => {} }) },
    '../stores/notificationPrefsStore': { setMuted: async () => {} },
};
// Dependencies are injected by patching the exports the router reads (restored after the run); no module-system hooks.
const patched = [];
function inject(request, overrides) {
    const real = require(request);
    for (const [key, value] of Object.entries(overrides)) {
        patched.push([real, key, real[key]]);
        real[key] = value;
    }
}
for (const [request, exportsObj] of Object.entries(MOCKS)) inject(request, exportsObj);

const router = require('./projects');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
test.after(() => { for (const [mod, key, orig] of patched.reverse()) mod[key] = orig; });

function get(url) {
    return new Promise((resolve, reject) => {
        const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const query = Object.fromEntries(new URLSearchParams(qs));
        const req = { method: 'GET', url, body: {}, headers: {}, session: { user: { id: 'bob', organizationId: 'org1' } }, query, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            set() { return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${url}`));
            return terminalErrorHandler(err, req, res, () => reject(err));
        });
    });
}

function reset() {
    fx.role = 'viewer';
    fx.project = { id: 'p1', name: 'P1', ownerId: 'alice', organizationId: 'org1' };
    fx.members = [
        { id: 'u1', displayName: 'Anna Jansen', username: 'anna', organizationId: 'org1', email: 'anna@example.com', avatarType: 'emoji' },
        { id: 'u2', displayName: 'Daan de Vries', username: 'daan', organizationId: 'org1', email: 'daan@example.com' },
        { id: 'u3', displayName: 'Joanna Smit', username: 'joanna', organizationId: 'org1' },
        { id: 'x1', displayName: 'Anouk Vreemd', username: 'anouk', organizationId: 'org2' },
    ];
    fx.groups = [
        { id: 'g1', name: 'Analysts', organizationId: 'org1' },
        { id: 'g2', name: 'Elsewhere analysts', organizationId: 'org2' },
        { id: 'g3', name: 'Sales', organizationId: 'org1' },
    ];
    fx.counts = new Map([['g1', 4], ['g3', 2]]);
    fx.avatars = [{ id: 'u1', avatarType: 'emoji', avatar: '🐝' }];
    fx.asked.length = 0;
}

test('a viewer gets id and name only, and no e-mail anywhere', async () => {
    reset();
    const res = await get('/p1/principals?q=an');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.users.map(u => u.id).sort(), ['u1', 'u2', 'u3']);
    assert.strictEqual(res.body.users.find(u => u.id === 'u1').name, 'Anna Jansen');
    assert.deepStrictEqual(res.body.users.find(u => u.id === 'u1').avatar, { type: 'emoji', value: '🐝' });
    assert.strictEqual(res.body.users.find(u => u.id === 'u3').avatar, null);
    assert.deepStrictEqual(res.body.groups, [{ id: 'g1', name: 'Analysts', memberCount: 4 }]);
    assert.ok(!/email|@example/i.test(JSON.stringify(res.body)), 'no e-mail address in the answer');
});

test('matching is case-insensitive and on any part of the name', async () => {
    reset();
    const res = await get('/p1/principals?q=VRIES');
    assert.deepStrictEqual(res.body.users.map(u => u.id), ['u2']);
});

test('a member of another organisation never appears', async () => {
    reset();
    const res = await get('/p1/principals?q=an');
    assert.ok(!res.body.users.some(u => u.id === 'x1'));
    assert.ok(!res.body.groups.some(g => g.id === 'g2'));
    assert.deepStrictEqual(fx.asked, ['org1']);
});

test('q shorter than two characters is refused', async () => {
    reset();
    const res = await get('/p1/principals?q=a');
    assert.strictEqual(res.statusCode, 400);
});

test('an unknown query key is refused (closed schema)', async () => {
    reset();
    const res = await get('/p1/principals?q=an&x=1');
    assert.strictEqual(res.statusCode, 400);
});

test('without q the first people and groups are listed, capped at 20 each', async () => {
    reset();
    fx.members = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, displayName: `Person ${i}`, username: `p${i}`, organizationId: 'org1' }));
    fx.groups = Array.from({ length: 30 }, (_, i) => ({ id: `gg${i}`, name: `Group ${i}`, organizationId: 'org1' }));
    const res = await get('/p1/principals');
    assert.strictEqual(res.body.users.length, 20);
    assert.strictEqual(res.body.groups.length, 20);
});

test('a member whose only name is an e-mail address shows as the id, never the address', async () => {
    reset();
    fx.members = [{ id: 'sso1', username: 'x@y.nl', organizationId: 'org1' }];
    const res = await get('/p1/principals');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.users.map(u => u.name), ['sso1']);
    assert.ok(!JSON.stringify(res.body).includes('@'), 'no @ anywhere in the answer');
});

test('a non-member gets 404', async () => {
    reset();
    fx.role = null;
    assert.strictEqual((await get('/p1/principals?q=an')).statusCode, 404);
});
