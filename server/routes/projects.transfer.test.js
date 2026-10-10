/**
 * POST /api/projects/:id/transfer-owner, and the owner's refusal to leave.
 *
 * The owner hands the project over and chooses what they stay as; an org admin who is not the owner may
 * rescue a project (the absent owner keeps no seat); anyone else is refused. A stale owner is a 409
 * owner_changed with nothing written; the target must be a member of the project and of its organisation.
 *
 * Run: cd server && node --test routes/projects.transfer.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const fx = { project: null, roles: {}, admin: false, inOrg: true, transfer: null, calls: [], told: [], activity: [], share: null };

const MOCKS = {
    '../stores/projectStore': {
        getProject: async () => fx.project,
        getProjectShares: async () => [],
        getProjectRole: async (userId) => fx.roles[userId] || null,
        getShareById: async () => fx.share,
        unshareProject: async () => true,
        transferOwner: async (args) => {
            fx.calls.push(args);
            if (fx.transfer instanceof Error) throw fx.transfer;
            return fx.transfer || { ok: true };
        },
        normalizePermission: (p) => p,
        listUserProjects: async () => [],
        recordActivityEvent: async (projectId, entry) => { fx.activity.push(entry); return null; },
    },
    '../stores/userStore': { getUser: async () => null, getGroup: async () => null, getAllGroups: async () => [] },
    '../stores/automationStore': { countGroupMembers: async () => new Map() },
    '../stores/knowledgeBases': { getKB: async () => null },
    '../support/kbAccess': { partitionAccessibleKBIds: async () => ({ allowed: [], denied: [] }) },
    '../auth': { resolveUserGroups: async () => [] },
    '../auth/admin/orgAdminGuards': { isOrgAdminForOrg: async () => fx.admin },
    '../auth/projectAccess': {
        requireProjectRole: () => async (req, res, next) => { req.projectRole = 'viewer'; next(); },
    },
    '../projects/projectOrg': {
        projectOrgOf: async (p) => p.organizationId || '',
        belongsToProjectOrg: async () => fx.inOrg,
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    '../projects/collabNotify': {
        makeCollabNotifier: () => ({ ownerChanged: async (a) => { fx.told.push(a); } }),
    },
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

function call(method, url, body, userId) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body: body || {}, headers: { 'content-type': 'application/json' }, session: { user: { id: userId, organizationId: 'org1' } }, query: {}, get() { return undefined; } };
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
const transfer = (body, userId) => call('POST', '/p1/transfer-owner', body, userId);

function reset() {
    fx.project = { id: 'p1', name: 'P1', ownerId: 'alice', organizationId: 'org1' };
    fx.roles = { bob: 'editor' };
    fx.admin = false;
    fx.inOrg = true;
    fx.transfer = null;
    fx.share = null;
    fx.calls.length = 0;
    fx.told.length = 0;
    fx.activity.length = 0;
}

test('the owner transfers to a member and stays as editor', async () => {
    reset();
    const res = await transfer({ toUserId: 'bob', keepMeAs: 'editor', expectedOwnerId: 'alice' }, 'alice');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.calls, [{ projectId: 'p1', fromUserId: 'alice', toUserId: 'bob', keepFromAs: 'editor' }]);
    assert.strictEqual(fx.activity.length, 1);
    assert.strictEqual(fx.activity[0].action, 'owner_changed');
    assert.deepStrictEqual(fx.told, [{ project: fx.project, actorId: 'alice', fromUserId: 'alice', toUserId: 'bob' }]);
});

test('keepMeAs none and viewer are passed on as given', async () => {
    reset();
    await transfer({ toUserId: 'bob', keepMeAs: 'none' }, 'alice');
    await transfer({ toUserId: 'bob', keepMeAs: 'viewer' }, 'alice');
    assert.deepStrictEqual(fx.calls.map(c => c.keepFromAs), ['none', 'viewer']);
});

test('a stale expectedOwnerId is 409 owner_changed and nothing is written', async () => {
    reset();
    const res = await transfer({ toUserId: 'bob', keepMeAs: 'editor', expectedOwnerId: 'carol' }, 'alice');
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'owner_changed');
    assert.strictEqual(fx.calls.length, 0);
    assert.strictEqual(fx.told.length, 0);
});

test('an owner changed under the write (the store says so) is 409 owner_changed, nobody told', async () => {
    reset();
    fx.transfer = { ok: false, reason: 'owner_changed' };
    const res = await transfer({ toUserId: 'bob', keepMeAs: 'editor', expectedOwnerId: 'alice' }, 'alice');
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'owner_changed');
    assert.strictEqual(fx.activity.length, 0);
    assert.strictEqual(fx.told.length, 0);
});

test('a target who is not a member is 400 not_a_member', async () => {
    reset();
    const res = await transfer({ toUserId: 'zed', keepMeAs: 'editor' }, 'alice');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'not_a_member');
    assert.strictEqual(fx.calls.length, 0);
});

test('a target outside the organisation is 400', async () => {
    reset();
    fx.inOrg = false;
    const res = await transfer({ toUserId: 'bob', keepMeAs: 'editor' }, 'alice');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'not_in_organisation');
    assert.strictEqual(fx.calls.length, 0);
});

test('handing the project to its owner is 400 already_owner', async () => {
    reset();
    const res = await transfer({ toUserId: 'alice', keepMeAs: 'editor' }, 'alice');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'already_owner');
});

test('an org admin rescues an orphaned project: keepMeAs is ignored, byOrgAdmin recorded', async () => {
    reset();
    fx.project.ownerId = 'deleted-user';
    fx.admin = true;
    const res = await transfer({ toUserId: 'bob', keepMeAs: 'editor' }, 'admin1');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.calls, [{ projectId: 'p1', fromUserId: 'deleted-user', toUserId: 'bob', keepFromAs: 'none' }]);
    assert.strictEqual(fx.activity[0].details.byOrgAdmin, true);
    assert.strictEqual(fx.told[0].actorId, 'admin1');
});

test('the owner is not recorded as byOrgAdmin even when they are an admin', async () => {
    reset();
    fx.admin = true;
    await transfer({ toUserId: 'bob', keepMeAs: 'editor' }, 'alice');
    assert.strictEqual(fx.activity[0].details.byOrgAdmin, false);
    assert.strictEqual(fx.calls[0].keepFromAs, 'editor');
});

test('a plain editor is 403', async () => {
    reset();
    const res = await transfer({ toUserId: 'bob', keepMeAs: 'editor' }, 'bob');
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(fx.calls.length, 0);
});

test('a stage-bound project (the store refuses) is 409', async () => {
    reset();
    fx.transfer = Object.assign(new Error('This project is a stage of a Solution.'), { status: 409, code: 'stage_project', expose: true });
    const res = await transfer({ toUserId: 'bob', keepMeAs: 'editor' }, 'alice');
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'stage_project');
    assert.strictEqual(fx.told.length, 0);
});

test('an unknown key in the body is refused', async () => {
    reset();
    const res = await transfer({ toUserId: 'bob', keepMeAs: 'editor', extra: 1 }, 'alice');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(fx.calls.length, 0);
});

test('the owner cannot remove themselves as a member: 409 transfer_first', async () => {
    reset();
    fx.share = { id: 's1', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'alice', permission: 'editor' };
    const res = await call('DELETE', '/p1/members/s1', {}, 'alice');
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'transfer_first');
});
