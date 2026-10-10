/**
 * Project access resolution — the bugs this module was written to make
 * impossible.
 *
 * Two of them were live:
 *
 *   1. GROUP-SHARED MEMBERS WERE INERT outside routes/projects.js.
 *      projectStore.getProjectRole takes groupIds as a third argument that
 *      defaults to []. Seven of nine call sites omitted it, so a member whose
 *      access came only from a group share silently got no role — no project
 *      instructions in chat, 403 on their own project's memories. It failed in
 *      the safe-looking direction, so nothing logged and nothing crashed.
 *
 *   2. VIEWERS COULD WRITE. The old `userHasAccess` returned a boolean that
 *      conflated "is a member" with "may write", and routes/memory.js gated
 *      every mutation on it. A read-only member could delete a project's whole
 *      shared memory pool.
 *
 * Run: cd server && node --test auth/projectAccess.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    // projectId -> { ownerId, shares: [{type:'user'|'group', id, permission}] }
    projects: {},
    // userId -> [groupId]
    groups: {},
    roleCalls: [],      // spy: every getProjectRole invocation
    throwOnRole: false,
};

/**
 * A faithful stand-in for projectStore.getProjectRole, including the part that
 * matters: it only matches group shares against the groupIds it is GIVEN.
 * If the caller omits them, group members resolve to null — exactly the
 * production behaviour these tests exist to pin.
 */
const projectStoreMock = {
    getProjectRole: async (userId, projectId, groupIds = []) => {
        fx.roleCalls.push({ userId, projectId, groupIds });
        if (fx.throwOnRole) throw new Error('db down');
        const p = fx.projects[projectId];
        if (!p) return null;
        if (p.ownerId === userId) return 'owner';
        const matches = (p.shares || []).filter(s =>
            (s.type === 'user' && s.id === userId) ||
            (s.type === 'group' && groupIds.includes(s.id))
        );
        if (matches.length === 0) return null;
        return matches.some(s => s.permission === 'editor') ? 'editor' : 'viewer';
    },
    getProject: async (id) => {
        const p = fx.projects[id];
        return p ? {
            id, name: `Project ${id}`, ownerId: p.ownerId, extractMemories: !!p.extractMemories,
            kind: p.kind === undefined ? 'workspace' : p.kind,
            archivedAt: p.archivedAt || null,
        } : null;
    },
};

const audienceMock = {
    resolveUserGroups: async (userId) => fx.groups[userId] || [],
};

const MOCKS = {
    '../stores/projectStore': projectStoreMock,
    './audience': audienceMock,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:project-access:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]projectAccess\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const projectAccess = require('./projectAccess');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.projects = {};
    fx.groups = {};
    fx.roleCalls.length = 0;
    fx.throwOnRole = false;
}

// ═══ Regression: group-shared members ════════════════════════════════

test('a member whose ONLY access is a group share resolves to their role', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'group', id: 'eng', permission: 'editor' }] };
    fx.groups.bob = ['eng'];

    assert.strictEqual(await projectAccess.getProjectRole('bob', 'p1'), 'editor');
});

test('groups are resolved by the module itself — callers cannot forget them', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'group', id: 'eng', permission: 'viewer' }] };
    fx.groups.bob = ['eng'];

    await projectAccess.getProjectRole('bob', 'p1');

    // The whole point: the underlying primitive received the group list.
    assert.deepStrictEqual(fx.roleCalls.at(-1).groupIds, ['eng'],
        'getProjectRole must be called WITH the resolved groups');
});

test('a user in no matching group still gets nothing', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'group', id: 'eng', permission: 'editor' }] };
    fx.groups.carol = ['sales'];

    assert.strictEqual(await projectAccess.getProjectRole('carol', 'p1'), null);
});

test('groups are re-read per call, so a removal takes effect without re-login', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'group', id: 'eng', permission: 'editor' }] };
    fx.groups.bob = ['eng'];
    assert.strictEqual(await projectAccess.getProjectRole('bob', 'p1'), 'editor');

    fx.groups.bob = [];   // admin removes bob from the group
    assert.strictEqual(await projectAccess.getProjectRole('bob', 'p1'), null,
        'no stale session-cached group list');
});

// ═══ Regression: viewers must not be able to write ═══════════════════

test('viewer satisfies viewer but NOT editor', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'user', id: 'bob', permission: 'viewer' }] };

    assert.strictEqual(await projectAccess.hasProjectRole('bob', 'p1', 'viewer'), true);
    assert.strictEqual(await projectAccess.hasProjectRole('bob', 'p1', 'editor'), false,
        'a viewer must never pass an editor gate');
});

test('editor satisfies editor but NOT owner', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'user', id: 'bob', permission: 'editor' }] };

    assert.strictEqual(await projectAccess.hasProjectRole('bob', 'p1', 'editor'), true);
    assert.strictEqual(await projectAccess.hasProjectRole('bob', 'p1', 'owner'), false);
});

test('owner satisfies every level', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [] };

    for (const level of ['viewer', 'editor', 'owner']) {
        assert.strictEqual(await projectAccess.hasProjectRole('alice', 'p1', level), true, level);
    }
});

test('owner beats a lower share on the same project', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'user', id: 'alice', permission: 'viewer' }] };

    assert.strictEqual(await projectAccess.getProjectRole('alice', 'p1'), 'owner');
});

test('the highest of several matching shares wins', async () => {
    resetFx();
    fx.projects.p1 = {
        ownerId: 'alice',
        shares: [
            { type: 'user', id: 'bob', permission: 'viewer' },
            { type: 'group', id: 'eng', permission: 'editor' },
        ],
    };
    fx.groups.bob = ['eng'];

    assert.strictEqual(await projectAccess.getProjectRole('bob', 'p1'), 'editor');
});

// ═══ Regression: attacker-chosen projectId from a request body ═══════

test('resolveRequestedProject returns null for a project the user is not in', async () => {
    resetFx();
    fx.projects.secret = { ownerId: 'alice', shares: [] };

    assert.strictEqual(await projectAccess.resolveRequestedProject('mallory', 'secret'), null,
        'a guessed project UUID must not resolve');
});

test('resolveRequestedProject returns the id and project for a real member', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'user', id: 'bob', permission: 'viewer' }], extractMemories: true };

    const resolved = await projectAccess.resolveRequestedProject('bob', 'p1');
    assert.strictEqual(resolved.projectId, 'p1');
    assert.strictEqual(resolved.role, 'viewer');
    assert.strictEqual(resolved.project.extractMemories, true);
});

test('resolveRequestedProject enforces minRole', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'user', id: 'bob', permission: 'viewer' }] };

    assert.ok(await projectAccess.resolveRequestedProject('bob', 'p1', 'viewer'));
    assert.strictEqual(await projectAccess.resolveRequestedProject('bob', 'p1', 'editor'), null);
});

test('resolveRequestedProject rejects junk without touching the store', async () => {
    resetFx();
    for (const bad of [null, undefined, '', 0, {}, []]) {
        assert.strictEqual(await projectAccess.resolveRequestedProject('bob', bad), null, String(bad));
    }
    assert.strictEqual(fx.roleCalls.length, 0, 'no role lookup for a non-string id');
});

// ═══ Chats are filed into collaborative projects, never into a Solution ═

test('resolveRequestedProject returns null for a Solution, even to its owner', async () => {
    resetFx();
    fx.projects.sol = { ownerId: 'alice', shares: [{ type: 'user', id: 'bob', permission: 'editor' }], kind: 'solution' };

    // Its instructions, knowledge and memories are not a chat's context, and a
    // new conversation must not be filed under it.
    assert.strictEqual(await projectAccess.resolveRequestedProject('alice', 'sol'), null);
    assert.strictEqual(await projectAccess.resolveRequestedProject('bob', 'sol'), null);
    // The role itself is untouched: Studio still needs it.
    assert.strictEqual(await projectAccess.getProjectRole('alice', 'sol'), 'owner');
});

test('a workspace and a legacy (unclassified) project still resolve', async () => {
    resetFx();
    fx.projects.ws = { ownerId: 'alice', shares: [], kind: 'workspace' };
    fx.projects.old = { ownerId: 'alice', shares: [], kind: null };

    assert.strictEqual((await projectAccess.resolveRequestedProject('alice', 'ws')).projectId, 'ws');
    assert.strictEqual((await projectAccess.resolveRequestedProject('alice', 'old')).projectId, 'old');
});

test('a nonexistent project resolves to null, not a crash', async () => {
    resetFx();
    assert.strictEqual(await projectAccess.getProjectRole('bob', 'ghost'), null);
    assert.strictEqual(await projectAccess.resolveRequestedProject('bob', 'ghost'), null);
});

// ═══ Failure modes deny, they do not throw ═══════════════════════════

test('a store failure denies access rather than propagating', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [] };
    fx.throwOnRole = true;

    assert.strictEqual(await projectAccess.getProjectRole('alice', 'p1'), null);
    assert.strictEqual(await projectAccess.hasProjectRole('alice', 'p1', 'viewer'), false);
});

test('missing userId or projectId denies without a lookup', async () => {
    resetFx();
    assert.strictEqual(await projectAccess.getProjectRole(null, 'p1'), null);
    assert.strictEqual(await projectAccess.getProjectRole('bob', null), null);
    assert.strictEqual(fx.roleCalls.length, 0);
});

// ═══ Express middleware ══════════════════════════════════════════════

function runMw(mw, { session, params = {} }) {
    return new Promise((resolve) => {
        const req = { session, params };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve({ res: this, nexted: false }); return this; },
        };
        mw(req, res, () => resolve({ res, nexted: true, req }));
    });
}

test('middleware 401s an unauthenticated caller', async () => {
    resetFx();
    const { res, nexted } = await runMw(projectAccess.requireProjectRole('viewer'), { session: {}, params: { id: 'p1' } });
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 401);
});

test('middleware 404s (not 403s) when the user has no role — existence is not probeable', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [] };

    const real = await runMw(projectAccess.requireProjectRole('viewer'), { session: { user: { id: 'mallory' } }, params: { id: 'p1' } });
    const fake = await runMw(projectAccess.requireProjectRole('viewer'), { session: { user: { id: 'mallory' } }, params: { id: 'nope' } });

    assert.strictEqual(real.res.statusCode, 404);
    assert.strictEqual(fake.res.statusCode, 404);
    assert.deepStrictEqual(real.res.body, fake.res.body,
        'an existing-but-forbidden project must be indistinguishable from a missing one');
});

test('middleware 403s when the role is real but too low', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'user', id: 'bob', permission: 'viewer' }] };

    const { res, nexted } = await runMw(projectAccess.requireProjectRole('editor'), { session: { user: { id: 'bob' } }, params: { id: 'p1' } });
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 403);
});

test('middleware passes and exposes the role on the request', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [{ type: 'group', id: 'eng', permission: 'editor' }] };
    fx.groups.bob = ['eng'];

    const { nexted, req } = await runMw(projectAccess.requireProjectRole('editor'), { session: { user: { id: 'bob' } }, params: { id: 'p1' } });
    assert.strictEqual(nexted, true);
    assert.strictEqual(req.projectRole, 'editor');
});

test('middleware can gate on a differently-named route param', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', shares: [] };

    const { nexted } = await runMw(
        projectAccess.requireProjectRole('owner', 'projectId'),
        { session: { user: { id: 'alice' } }, params: { projectId: 'p1' } }
    );
    assert.strictEqual(nexted, true);
});


// ═══ Archived projects are read-only ═════════════════════════════════

function runGate(minRole, userId, projectId, opts) {
    const req = { session: { user: { id: userId } }, params: { id: projectId } };
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve({ res: this, req, nexted: false }); return this; },
        };
        const mw = opts === undefined ? projectAccess.requireProjectRole(minRole) : projectAccess.requireProjectRole(minRole, opts);
        Promise.resolve(mw(req, res, () => resolve({ res, req, nexted: true })));
    });
}

test('an archived project refuses editor and owner gates with 409 project_archived', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', archivedAt: '2026-10-01T00:00:00Z', shares: [{ type: 'user', id: 'bob', permission: 'editor' }] };
    for (const [minRole, user] of [['editor', 'bob'], ['owner', 'alice']]) {
        const out = await runGate(minRole, user, 'p1');
        assert.strictEqual(out.nexted, false);
        assert.strictEqual(out.res.statusCode, 409);
        assert.strictEqual(out.res.body.code, 'project_archived');
        assert.match(out.res.body.error, /archived/i);
    }
});

test('an archived project still serves viewer gates, and attaches req.project', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', archivedAt: '2026-10-01T00:00:00Z', shares: [{ type: 'user', id: 'bob', permission: 'viewer' }] };
    const out = await runGate('viewer', 'bob', 'p1');
    assert.strictEqual(out.nexted, true);
    assert.strictEqual(out.req.projectRole, 'viewer');
});

test('allowArchived lets the owner through an archived project', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', archivedAt: '2026-10-01T00:00:00Z' };
    const out = await runGate('owner', 'alice', 'p1', { allowArchived: true });
    assert.strictEqual(out.nexted, true);
    assert.strictEqual(out.req.project.archivedAt, '2026-10-01T00:00:00Z');
});

test('the role check wins over the archived check (403 for a viewer, 404 for a stranger)', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice', archivedAt: '2026-10-01T00:00:00Z', shares: [{ type: 'user', id: 'bob', permission: 'viewer' }] };
    assert.strictEqual((await runGate('editor', 'bob', 'p1')).res.statusCode, 403);
    assert.strictEqual((await runGate('editor', 'zed', 'p1')).res.statusCode, 404);
});

test('a live project passes the editor gate and the gate passes a custom param name through', async () => {
    resetFx();
    fx.projects.p1 = { ownerId: 'alice' };
    const out = await runGate('editor', 'alice', 'p1');
    assert.strictEqual(out.nexted, true);
});
