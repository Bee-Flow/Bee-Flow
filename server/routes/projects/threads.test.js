'use strict';

/**
 * Shared AI chats in a project, and taking one's own chat back out
 * (routes/projects/threads.js), served with injected fakes behind a real
 * express app and the real terminal error handler — no module mocking.
 *
 * The case this file exists for: Bob shared his chat into project P, then
 * was removed from P (or left). Only Bob can unshare it (it is re-encrypted
 * under his key), P's owner cannot, and while it stays shared P cannot be
 * deleted. Before, Bob got a 404 from the role gate and a 500 from the
 * self-detach route, so nobody could.
 *
 * Proven:
 *   - a chat's owner unshares it with or without a project role, only when
 *     it is filed in the project in the path, with their own session's key;
 *   - nobody else can: the project owner, a member, a stranger all get the
 *     404 a non-member gets, and nothing is re-encrypted;
 *   - self-detach unshares a shared chat first, then detaches it; a private
 *     one is just detached; somebody else's is a 404;
 *   - the store's deliberate refusals are answered in words (409 owner key,
 *     503 project key), and a failed unshare detaches nothing;
 *   - sharing stays editor + owner, and never into a Studio Solution.
 *
 * Run: cd server && node --test routes/projects/threads.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { makeThreadsRouter } = require('./threads');

const ALICE = { id: 'alice', organizationId: 'org1' };   // owns project P
const BOB = { id: 'bob', organizationId: 'org1' };       // was an editor of P, since removed
const CAROL = { id: 'carol', organizationId: 'org1' };   // an editor of P
const ORDER = { viewer: 0, editor: 1, owner: 2 };

const fx = {};
function reset() {
    fx.roles = { P: { alice: 'owner', carol: 'editor' }, Q: { bob: 'editor', alice: 'viewer' } };
    fx.projects = {
        P: { id: 'P', kind: 'workspace', organizationId: 'org1' },
        Q: { id: 'Q', kind: 'workspace', organizationId: 'org1' },
        S: { id: 'S', kind: 'solution', organizationId: 'org1' },
    };
    // conversation id -> { owner, table, projectId, shared }
    fx.convs = {
        'bob-shared': { owner: 'bob', table: 'direct_conversations', projectId: 'P', shared: true },
        'bob-agent': { owner: 'bob', table: 'agent_conversations', projectId: 'P', shared: true },
        'bob-private': { owner: 'bob', table: 'direct_conversations', projectId: 'P', shared: false },
        'bob-in-q': { owner: 'bob', table: 'direct_conversations', projectId: 'Q', shared: true },
        'carol-shared': { owner: 'carol', table: 'direct_conversations', projectId: 'P', shared: true },
    };
    fx.unshared = [];
    fx.sharedCalls = [];
    fx.unassigned = [];
    fx.recorded = [];
    fx.unshareFails = null;
}

const store = {
    async getProject(id) { return fx.projects[id] ? { ...fx.projects[id] } : null; },
    async getOwnConversationFiling(id, userId, table) {
        const c = fx.convs[id];
        if (!c || c.owner !== userId || c.table !== table) return null;
        return { projectId: c.projectId, shared: c.shared };
    },
    async unassignConversation(id, userId, table) {
        const c = fx.convs[id];
        if (!c || c.owner !== userId || c.table !== table) return false;
        // The schema's CHECK: a shared chat keeps its project.
        if (c.shared) throw Object.assign(new Error('violates check constraint'), { code: '23514' });
        fx.unassigned.push([id, userId]);
        c.projectId = null;
        return true;
    },
};

const shared = {
    async unshareConversation(args) {
        if (fx.unshareFails) throw Object.assign(new Error(fx.unshareFails.message), { code: fx.unshareFails.code });
        const c = fx.convs[args.conversationId];
        if (!c || c.owner !== args.ownerId) throw Object.assign(new Error('Conversation not found'), { code: 'NOT_FOUND' });
        fx.unshared.push(args);
        c.shared = false;
        return { shared: false, rekeyed: 3 };
    },
    async shareConversationToProject(args) {
        fx.sharedCalls.push(args);
        return { shared: true, rekeyed: 2 };
    },
    async listProjectThreads(projectId, opts) { return [{ id: 'carol-shared', ownerId: 'carol', projectId, opts }]; },
};

const router = makeThreadsRouter({
    requireProjectRole: (minRole) => function requireProjectRoleMw(req, res, next) {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const role = fx.roles[req.params.id]?.[userId];
        if (!role) return res.status(404).json({ error: 'Not found' });
        if (ORDER[role] < ORDER[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
        req.projectRole = role;
        return next();
    },
    store,
    shared,
    recordProjectChange: async (projectId, actorId, action, details) => { fx.recorded.push([projectId, actorId, action, details]); },
    log: { info() {}, warn() {}, error() {} },
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    const user = who && who !== 'none' ? JSON.parse(who) : null;
    req.session = user ? { user, encryptionKey: `key-of-${user.id}` } : {};
    next();
});
app.use('/api/projects', router);
app.use(terminalErrorHandler);
const server = http.createServer(app);
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
test.beforeEach(reset);

async function call(method, url, { user, body } = {}) {
    await ready;
    const headers = { 'x-test-user': user ? JSON.stringify(user) : 'none' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Unsharing: the chat's owner, member or not ────────────────────────

test('a removed member unshares their own chat: re-encrypted under their key, and announced', async () => {
    // Bob has no role on P any more.
    const res = await call('DELETE', '/api/projects/P/threads/bob-shared', { user: BOB });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { shared: false, rekeyed: 3 });
    assert.deepStrictEqual(fx.unshared, [{
        conversationId: 'bob-shared', type: 'direct', ownerId: 'bob', orgId: 'org1', encryptionKey: 'key-of-bob',
    }]);
    assert.deepStrictEqual(fx.recorded, [['P', 'bob', 'thread_unshared', { targetType: 'conversation', targetId: 'bob-shared' }]]);

    const agent = await call('DELETE', '/api/projects/P/threads/bob-agent?type=agent', { user: BOB });
    assert.strictEqual(agent.status, 200);
    assert.strictEqual(fx.unshared[1].type, 'agent');
});

test('nobody but the chat\'s owner can unshare it: the project owner, a member, a stranger all get a 404', async () => {
    for (const user of [ALICE, CAROL, { id: 'mallory', organizationId: 'org2' }]) {
        const res = await call('DELETE', '/api/projects/P/threads/bob-shared', { user });
        assert.strictEqual(res.status, 404, user.id);
    }
    assert.strictEqual((await call('DELETE', '/api/projects/P/threads/bob-shared', {})).status, 401);
    assert.deepStrictEqual(fx.unshared, [], 'nothing was re-encrypted');
    assert.deepStrictEqual(fx.recorded, []);
});

test('the unshare is scoped to the project in the path', async () => {
    // Bob's chat is shared in Q, where he is still an editor; not through P.
    const res = await call('DELETE', '/api/projects/P/threads/bob-in-q', { user: BOB });
    assert.strictEqual(res.status, 404);
    assert.strictEqual((await call('DELETE', '/api/projects/P/threads/bob-shared?type=agent', { user: BOB })).status, 404, 'wrong table');
    assert.deepStrictEqual(fx.unshared, []);
});

test('a chat filed here but not shared: nothing to re-encrypt, nothing announced', async () => {
    const res = await call('DELETE', '/api/projects/P/threads/bob-private', { user: BOB });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { shared: false, rekeyed: 0 });
    assert.deepStrictEqual(fx.unshared, []);
    assert.deepStrictEqual(fx.recorded, []);
});

test('the store\'s refusals are answered in words, and nothing is announced', async () => {
    fx.unshareFails = { code: 'OWNER_KEY_REQUIRED', message: 'Cannot unshare: the owner must be signed in.' };
    const owner = await call('DELETE', '/api/projects/P/threads/bob-shared', { user: BOB });
    assert.strictEqual(owner.status, 409);
    assert.strictEqual(owner.body.code, 'OWNER_KEY_REQUIRED');

    fx.unshareFails = { code: 'PROJECT_KEY_UNAVAILABLE', message: 'no project key' };
    const key = await call('DELETE', '/api/projects/P/threads/bob-shared', { user: BOB });
    assert.strictEqual(key.status, 503);
    assert.strictEqual(key.body.code, 'PROJECT_KEY_UNAVAILABLE');
    assert.ok(!/no project key/.test(key.body.error), 'the internal message stays in the log');
    assert.deepStrictEqual(fx.recorded, []);
});

// ── Self-detach ───────────────────────────────────────────────────────

test('self-detach of a SHARED chat unshares it first, then takes it out (it used to be a 500)', async () => {
    const res = await call('DELETE', '/api/projects/conversations/bob-shared', { user: BOB });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { success: true });
    assert.strictEqual(fx.unshared.length, 1);
    assert.strictEqual(fx.unshared[0].encryptionKey, 'key-of-bob');
    assert.deepStrictEqual(fx.unassigned, [['bob-shared', 'bob']]);
    assert.deepStrictEqual(fx.recorded.map((r) => [r[0], r[2]]), [['P', 'thread_unshared']]);
});

test('self-detach of a private chat only takes it out; somebody else\'s is a 404', async () => {
    const own = await call('DELETE', '/api/projects/conversations/bob-private', { user: BOB });
    assert.strictEqual(own.status, 200);
    assert.deepStrictEqual(fx.unshared, []);
    assert.deepStrictEqual(fx.unassigned, [['bob-private', 'bob']]);

    const other = await call('DELETE', '/api/projects/conversations/carol-shared', { user: BOB });
    assert.strictEqual(other.status, 404);
    assert.strictEqual((await call('DELETE', '/api/projects/conversations/bob-private', {})).status, 401);
    assert.deepStrictEqual(fx.unassigned, [['bob-private', 'bob']]);
});

test('a self-detach whose unshare is refused detaches nothing', async () => {
    fx.unshareFails = { code: 'OWNER_KEY_REQUIRED', message: 'Cannot unshare: the owner must be signed in.' };
    const res = await call('DELETE', '/api/projects/conversations/bob-shared', { user: BOB });
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(fx.unassigned, []);
    assert.strictEqual(fx.convs['bob-shared'].projectId, 'P');
});

// ── Sharing and listing ───────────────────────────────────────────────

test('sharing is editor + owner, into a workspace, never into a Solution', async () => {
    fx.roles.S = { carol: 'editor' };
    const into = await call('POST', '/api/projects/P/threads', { user: CAROL, body: { conversationId: 'carol-new' } });
    assert.strictEqual(into.status, 200);
    assert.deepStrictEqual(fx.sharedCalls, [{
        conversationId: 'carol-new', type: 'direct', projectId: 'P', ownerId: 'carol', orgId: 'org1', encryptionKey: 'key-of-carol',
    }]);
    assert.deepStrictEqual(fx.recorded, [['P', 'carol', 'thread_shared', {
        targetType: 'conversation', targetId: 'carol-new', conversationType: 'direct',
    }]]);

    const sol = await call('POST', '/api/projects/S/threads', { user: CAROL, body: { conversationId: 'carol-new' } });
    assert.strictEqual(sol.status, 409);
    assert.strictEqual(sol.body.code, 'SOLUTION_HOLDS_NO_CHATS');

    fx.roles.P.bob = 'viewer';
    assert.strictEqual((await call('POST', '/api/projects/P/threads', { user: BOB, body: { conversationId: 'bob-private' } })).status, 403);
    assert.strictEqual((await call('POST', '/api/projects/P/threads', { user: CAROL, body: {} })).status, 400);
    assert.strictEqual(fx.sharedCalls.length, 1);
});

test('the shared chats are listed to members only', async () => {
    const res = await call('GET', '/api/projects/P/threads?limit=10', { user: ALICE });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.role, 'owner');
    assert.deepStrictEqual(res.body.threads[0].opts, { limit: 10, offset: 0 });
    assert.strictEqual((await call('GET', '/api/projects/P/threads', { user: BOB })).status, 404);
});
