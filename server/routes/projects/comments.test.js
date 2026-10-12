/**
 * routes/projects/comments.js over a real Express app (core/http/routeHarness
 * serve()), with every dependency handed in through makeProjectCommentsRouter:
 * the real store over PGlite, the real sealing with an injected project key,
 * and a fake role gate, assistant, participation notice and feed. No module
 * mocking.
 *
 * Proven:
 *   - the role ladder: no session 401, no role 404, viewers read only, editors
 *     comment, only the author edits a comment, the author or the owner
 *     deletes one, the thread's creator or the owner deletes a thread;
 *   - a thread is reached only through its own project, and only while its
 *     item is filed there (cross-project and detached items are 404);
 *   - anchors and bodies are stored sealed; a key that cannot be produced is a
 *     503 with nothing written; a damaged row is served as unreadable;
 *   - idempotent threads and replies, member-only mentions, replies inside the
 *     thread, a reply reopens a resolved thread, a Solution holds no threads;
 *   - the AI rules as the route applies them (off, mention, auto, @ai, askAi,
 *     resolved) and the auto hand-off to the participation engine, which
 *     never holds up the comment; the list says what the organisation allows;
 *   - an edit keeps the mentions when none are sent, and an "Ask AI" stays one;
 *   - a long thread in the list: its first and latest comments, and a count
 *     of those left out;
 *   - "not helpful" only on automatic answers, per caller, and two of them
 *     pause the AI joining the thread by itself for a day;
 *   - the feed and the activity log carry ids, never text;
 *   - closed bodies: a misspelled key is refused and nothing is stored.
 *
 * Run: cd server && node --test routes/projects/comments.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { serve } = require('../../core/http/routeHarness');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeProjectCommentStore, DDL } = require('../../stores/projectCommentStore');
const { makeCommentCrypto } = require('../../projects/comments/commentCrypto');
const { makeProjectCommentsRouter } = require('./comments');

const person = (id) => ({ id, organizationId: 'org1', role: 'user', email: `${id}@example.test` });
const [OWNER, EDITOR, EDITOR2, VIEWER, STRANGER] = ['olga', 'ed', 'eve', 'vic', 'sam'].map(person);

// Who holds which role where: [project, user, role]. Nobody else has one.
const GRANTS = [
    ['p1', 'olga', 'owner'], ['p1', 'ed', 'editor'], ['p1', 'eve', 'editor'], ['p1', 'vic', 'viewer'],
    ['p2', 'olga', 'owner'], ['p2', 'ed', 'editor'],
    ['sol', 'olga', 'owner'], ['sol', 'ed', 'editor'],
    ['nokey', 'olga', 'owner'], ['nokey', 'ed', 'editor'], ['nokey', 'vic', 'viewer'],
];
const roleOf = (projectId, userId) => (GRANTS.find(([p, u]) => p === projectId && u === userId) || [])[2] || null;
const PROJECTS = new Map([
    ['p1', { name: 'Launch', kind: 'workspace' }],
    ['p2', { name: 'Other', kind: null }],
    ['sol', { name: 'Bundle', kind: 'solution' }],
    ['nokey', { name: 'Broken vault', kind: 'workspace' }],
].map(([id, rest]) => [id, { id, organizationId: 'org1', ...rest }]));

// One key per project for the whole run; the 'nokey' project's vault is broken.
const KEYS = new Map([...PROJECTS.keys()].filter((id) => id !== 'nokey').map((id) => [id, crypto.randomBytes(32)]));
const { pg, db } = pgliteDb();
const store = makeProjectCommentStore(db);
const commentCrypto = makeCommentCrypto({
    async getProjectKey(projectId) {
        const key = KEYS.get(projectId);
        if (!key) throw new Error('org_root_key could not be decrypted');
        return key;
    },
});

let events, activity, replies, notices, cancels, nextReply, signals, bells, taskBells;
/** What the fake engine does before it takes a notice (hold it up, fail). */
let engineDelay;
const settle = () => new Promise((resolve) => setImmediate(resolve));
// The organisation's AI participation policy (projects/participation/policy):
// may the AI join comment threads by itself?
let orgPolicy = { autoAllowed: true, commentsAutoAllowed: true };
let clock = Date.parse('2026-09-29T12:00:00Z');

// The participation store's feedback half, in memory: one row per (answer, person).
const feedbackRows = new Map();
const participationStore = {
    async recordFeedback(f) {
        feedbackRows.set(`${f.messageId}|${f.userId}`, { ...f, at: clock });
        const notHelpfulRecently = [...feedbackRows.values()]
            .filter((r) => r.containerId === f.containerId && r.helpful === false && clock - r.at < 24 * 3600_000).length;
        return { created: true, notHelpfulRecently };
    },
    async feedbackFor(userId, ids) {
        return new Map(ids.filter((id) => feedbackRows.has(`${id}|${userId}`)).map((id) => [id, feedbackRows.get(`${id}|${userId}`).helpful]));
    },
};

const LADDER = ['viewer', 'editor', 'owner'];

/** The shared gate's contract: 401 without a session, 404 without a role, 403 below the minimum. */
const fakeRoleGate = (minRole) => function requireProjectRoleMw(req, res, next) {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const held = roleOf(req.params.id, userId);
    if (!held) return res.status(404).json({ error: 'Not found' });
    if (LADDER.indexOf(held) < LADDER.indexOf(minRole)) return res.status(403).json({ error: 'Insufficient permissions' });
    req.projectRole = held;
    return next();
};

const collect = (list, shape) => async (...args) => { list().push(shape(...args)); };

const DEPS = {
    requireProjectRole: fakeRoleGate,
    getProjectRole: async (userId, projectId) => roleOf(projectId, userId),
    getProject: async (id) => (PROJECTS.has(id) ? { ...PROJECTS.get(id) } : null),
    store,
    commentCrypto,
    assistant: { requestReply: async (args) => { replies.push(args); return nextReply; } },
    participation: {
        notify: async (notice) => { if (engineDelay) await engineDelay(notice); notices.push(notice); return true; },
        cancel: async (threadId) => { cancels.push(threadId); return true; },
    },
    resolveOrgs: async () => ({ orgId: 'org1', limitOrgId: 'org1' }),
    emit: collect(() => events, (projectId, event) => ({ projectId, ...event })),
    logActivity: collect(() => activity, (projectId, actorId, action, details) => ({ projectId, actorId, action, details })),
    postLimiter: function rateLimitMiddleware(_req, _res, next) { next(); },
    participationStore,
    policy: { resolveOrgPolicy: async () => ({ ...orgPolicy }) },
    signalProjectChanged: (project, reason) => { signals.push({ projectId: project.id, reason }); },
    collabNotifier: { commentMentioned: async (args) => { bells.push(args); } },
    taskNotifier: { mentioned: async (args) => { taskBells.push(args); } },
    now: () => clock,
};
const api = serve('/api/projects', makeProjectCommentsRouter(DEPS), { user: EDITOR });

before(async () => {
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, organization_id TEXT);
        CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT);
        CREATE TABLE studio_documents (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT,
            kind TEXT NOT NULL DEFAULT 'document', archived BOOLEAN NOT NULL DEFAULT FALSE
        );
    `);
    await pg.exec(DDL);
    for (const id of PROJECTS.keys()) await pg.query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [id, 'olga']);
    await pg.query(`INSERT INTO notebooks (id, name, project_id) VALUES
        ('nb1', 'Research', 'p1'), ('nb2', 'Other research', 'p2'), ('nb-sol', 'Kit', 'sol'),
        ('nb-key', 'Vault', 'nokey'), ('nb-free', 'Private', NULL)`);
    await pg.query(`INSERT INTO studio_documents (id, name, project_id) VALUES ('doc1', 'Proposal', 'p1')`);
});
after(async () => { await api.close(); await pg.close(); });
beforeEach(() => {
    events = [];
    bells = [];
    taskBells = [];
    activity = [];
    replies = [];
    notices = [];
    cancels = [];
    signals = [];
    nextReply = { status: 'queued' };
    engineDelay = null;
});

const call = (method, url, opts = {}) => api.call(method, url, opts);
const ANCHOR = { quote: 'the budget is 40k', prefix: 'We agreed ', suffix: ' for Q3', blockIndex: 3 };

async function startThread(body = {}, user = EDITOR, projectId = 'p1') {
    const res = await call('POST', `/api/projects/${projectId}/comments`, {
        body: { targetType: 'notebook', targetId: 'nb1', anchor: ANCHOR, content: 'Is this still right?', ...body }, user,
    });
    assert.strictEqual(res.status, 201, res.text);
    return res.body;
}
const replyTo = (threadId, content, extra = {}, user = EDITOR, projectId = 'p1') => call('POST',
    `/api/projects/${projectId}/comments/${threadId}/replies`, { body: { content, ...extra }, user });
const list = (query, user = EDITOR, projectId = 'p1') => call('GET', `/api/projects/${projectId}/comments?${new URLSearchParams(query)}`, { user });
const countRows = async (table) => Number((await pg.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n);

// ── Role ladder ──────────────────────────────────────────────────────────

test('no session is 401, no role on the project is 404 on every route', async () => {
    const { thread } = await startThread();
    const routes = [
        ['GET', '/api/projects/p1/comments?targetType=notebook&targetId=nb1'],
        ['POST', '/api/projects/p1/comments', { targetType: 'notebook', targetId: 'nb1', content: 'x' }],
        ['GET', `/api/projects/p1/comments/${thread.id}`],
        ['PATCH', `/api/projects/p1/comments/${thread.id}`, { aiMode: 'off' }],
        ['DELETE', `/api/projects/p1/comments/${thread.id}`],
        ['POST', `/api/projects/p1/comments/${thread.id}/replies`, { content: 'x' }],
        ['PATCH', `/api/projects/p1/comments/${thread.id}/replies/${thread.comments[0].id}`, { content: 'x' }],
        ['DELETE', `/api/projects/p1/comments/${thread.id}/replies/${thread.comments[0].id}`],
        ['POST', `/api/projects/p1/comments/${thread.id}/resolve`],
        ['POST', `/api/projects/p1/comments/${thread.id}/reopen`],
    ];
    for (const [method, url, body] of routes) {
        assert.strictEqual((await call(method, url, { body, user: null })).status, 401, `${method} ${url} without a session`);
        assert.strictEqual((await call(method, url, { body, user: STRANGER })).status, 404, `${method} ${url} for a stranger`);
    }
});

test('a viewer reads threads but cannot comment, reply, resolve or change them', async () => {
    const { thread } = await startThread();
    const read = await list({ targetType: 'notebook', targetId: 'nb1' }, VIEWER);
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body.role, 'viewer');
    assert.ok(read.body.threads.some((t) => t.id === thread.id));
    assert.strictEqual((await call('GET', `/api/projects/p1/comments/${thread.id}`, { user: VIEWER })).status, 200);
    const before = await countRows('project_comments');
    const refused = [
        await call('POST', '/api/projects/p1/comments', { body: { targetType: 'notebook', targetId: 'nb1', content: 'x' }, user: VIEWER }),
        await replyTo(thread.id, 'x', {}, VIEWER),
        await call('POST', `/api/projects/p1/comments/${thread.id}/resolve`, { user: VIEWER }),
        await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'off' }, user: VIEWER }),
        await call('DELETE', `/api/projects/p1/comments/${thread.id}`, { user: VIEWER }),
    ];
    for (const res of refused) assert.strictEqual(res.status, 403);
    assert.strictEqual(await countRows('project_comments'), before, 'nothing was stored');
});

// ── Threads ──────────────────────────────────────────────────────────────

test('an editor starts a thread: sealed at rest, served opened, announced with ids only', async () => {
    const out = await startThread({ mentions: ['eve', 'sam', 'eve'] });
    const t = out.thread;
    assert.strictEqual(t.targetType, 'notebook');
    assert.strictEqual(t.targetId, 'nb1');
    assert.deepStrictEqual(t.anchor, ANCHOR);
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(t.aiMode, 'mention');
    assert.strictEqual(t.createdBy, 'ed');
    assert.strictEqual(t.comments.length, 1);
    assert.strictEqual(t.comments[0].content, 'Is this still right?');
    assert.deepStrictEqual(t.comments[0].mentions, ['eve'], 'mentions only for members, once');
    assert.deepStrictEqual(out.ai, { status: 'skipped', reason: 'not_mentioned' });

    const row = (await pg.query('SELECT anchor FROM project_comment_threads WHERE id = $1', [t.id])).rows[0];
    const body = (await pg.query('SELECT content FROM project_comments WHERE thread_id = $1', [t.id])).rows[0];
    assert.ok(!row.anchor.includes('budget') && JSON.parse(row.anchor)._bfenc === 1, 'the anchor is sealed');
    assert.ok(!body.content.includes('still right') && JSON.parse(body.content)._bfenc === 1, 'the comment is sealed');

    const kinds = events.map((e) => e.kind);
    assert.deepStrictEqual(kinds, ['comment.thread.created', 'comment.mention']);
    const text = JSON.stringify([events, activity]);
    assert.ok(!text.includes('budget') && !text.includes('still right'), 'no text in the feed or the activity log');
    assert.deepStrictEqual(events[0].payload, { threadId: t.id, targetType: 'notebook', targetId: 'nb1', commentId: t.comments[0].id, seq: 1, authorKind: 'user' });
    assert.deepStrictEqual(events[1].payload.mentionedUserIds, ['eve']);
    assert.deepStrictEqual(bells.map((b) => [b.project.id, b.actorId, b.mentionedUserIds, b.targetType, b.targetId]), [['p1', 'ed', ['eve'], 'notebook', 'nb1']]);
    assert.deepStrictEqual(taskBells, [], 'a notebook mention does not go through the task notifier');
    assert.ok(!JSON.stringify(bells).includes('still right'), 'the bell is not given the comment');
    assert.deepStrictEqual(activity.map((a) => a.action), ['comment.thread.created']);
});

test('a comment on the whole item has no anchor; a document can be commented on too', async () => {
    const whole = await startThread({ anchor: null, targetType: 'document', targetId: 'doc1', content: 'Overall: nice.' });
    assert.strictEqual(whole.thread.anchor, null);
    const listed = await list({ targetType: 'document', targetId: 'doc1' });
    assert.ok(listed.body.threads.some((t) => t.id === whole.thread.id && t.anchor === null));
});

test('the item must be filed in this project', async () => {
    for (const [targetType, targetId] of [['notebook', 'nb2'], ['notebook', 'nb-free'], ['notebook', 'nope'], ['document', 'nb1']]) {
        const created = await call('POST', '/api/projects/p1/comments', { body: { targetType, targetId, content: 'x' } });
        assert.strictEqual(created.status, 404, `${targetType} ${targetId}`);
        assert.strictEqual(created.body.code, 'target_not_found');
        assert.strictEqual((await list({ targetType, targetId })).status, 404);
    }
});

test('a thread is reached only through its own project, and only while its item is there', async () => {
    const { thread } = await startThread();
    assert.strictEqual((await call('GET', `/api/projects/p2/comments/${thread.id}`)).status, 404, 'another project');
    assert.strictEqual((await replyTo(thread.id, 'x', {}, EDITOR, 'p2')).status, 404);

    const moved = await startThread({ targetId: 'nb1' });
    await pg.query(`UPDATE notebooks SET project_id = 'p2' WHERE id = 'nb1'`);
    try {
        assert.strictEqual((await call('GET', `/api/projects/p1/comments/${moved.thread.id}`)).status, 404, 'the item left the project');
        assert.strictEqual((await replyTo(moved.thread.id, 'x')).status, 404);
        assert.strictEqual((await list({ targetType: 'notebook', targetId: 'nb1' })).status, 404);
    } finally {
        await pg.query(`UPDATE notebooks SET project_id = 'p1' WHERE id = 'nb1'`);
    }
});

test('a Studio Solution holds no threads, and a missing key stores nothing', async () => {
    const sol = await call('POST', '/api/projects/sol/comments', { body: { targetType: 'notebook', targetId: 'nb-sol', content: 'x' } });
    assert.strictEqual(sol.status, 409);
    assert.strictEqual(sol.body.code, 'SOLUTION_HOLDS_NO_COMMENTS');

    const before = await countRows('project_comment_threads');
    const nokey = await call('POST', '/api/projects/nokey/comments', { body: { targetType: 'notebook', targetId: 'nb-key', content: 'x' } });
    assert.strictEqual(nokey.status, 503);
    assert.strictEqual(nokey.body.code, 'PROJECT_KEY_UNAVAILABLE');
    assert.strictEqual(await countRows('project_comment_threads'), before, 'nothing was written');
    assert.strictEqual((await list({ targetType: 'notebook', targetId: 'nb-key' }, VIEWER, 'nokey')).status, 503);
});

test('a retried clientThreadId answers the same thread without asking the AI again', async () => {
    const first = await startThread({ clientThreadId: 'draft-1', askAi: true });
    assert.strictEqual(replies.length, 1);
    const again = await call('POST', '/api/projects/p1/comments', {
        body: { targetType: 'notebook', targetId: 'nb1', anchor: ANCHOR, content: 'Is this still right?', clientThreadId: 'draft-1', askAi: true },
    });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.thread.id, first.thread.id);
    assert.deepStrictEqual(again.body.ai, { status: 'skipped', reason: 'duplicate' });
    assert.strictEqual(replies.length, 1, 'no second answer');
    const taken = await call('POST', '/api/projects/p1/comments', {
        body: { targetType: 'notebook', targetId: 'nb1', content: 'mine', clientThreadId: 'draft-1' }, user: EDITOR2,
    });
    assert.strictEqual(taken.status, 409);
    assert.strictEqual(taken.body.code, 'client_id_taken');
});

test('closed bodies: a misspelled key is refused and nothing is stored', async () => {
    const before = await countRows('project_comment_threads');
    const misspelled = await call('POST', '/api/projects/p1/comments', { body: { targetType: 'notebook', targetId: 'nb1', content: 'x', askAI: true } });
    assert.strictEqual(misspelled.status, 400);
    assert.match(misspelled.body.error, /askAI/);
    const badAnchor = await call('POST', '/api/projects/p1/comments', { body: { targetType: 'notebook', targetId: 'nb1', content: 'x', anchor: { quote: 'x', color: 'red' } } });
    assert.strictEqual(badAnchor.status, 400);
    const emptyQuote = await call('POST', '/api/projects/p1/comments', { body: { targetType: 'notebook', targetId: 'nb1', content: 'x', anchor: { quote: '  ' } } });
    assert.strictEqual(emptyQuote.status, 400);
    const badMode = await call('POST', '/api/projects/p1/comments', { body: { targetType: 'notebook', targetId: 'nb1', content: 'x', aiMode: 'always' } });
    assert.strictEqual(badMode.status, 400);
    const emptyBody = await call('POST', '/api/projects/p1/comments', { body: { targetType: 'notebook', targetId: 'nb1', content: '   ' } });
    assert.strictEqual(emptyBody.status, 400);
    assert.strictEqual(await countRows('project_comment_threads'), before);
    assert.strictEqual((await list({ targetType: 'meeting', targetId: 'm1' })).status, 400);
});

// ── Replies ──────────────────────────────────────────────────────────────

test('replies are gapless, idempotent, inside the thread, and reopen a resolved thread', async () => {
    const { thread } = await startThread();
    const r1 = await replyTo(thread.id, 'I think so', { clientMsgId: 'r-1' }, EDITOR2);
    assert.strictEqual(r1.status, 201);
    assert.strictEqual(r1.body.comment.seq, 2);
    const retry = await replyTo(thread.id, 'I think so', { clientMsgId: 'r-1' }, EDITOR2);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.body.comment.id, r1.body.comment.id);
    assert.strictEqual((await replyTo(thread.id, 'x', { clientMsgId: 'r-1' })).status, 409);
    const other = await startThread();
    const outside = await replyTo(thread.id, 'x', { replyTo: other.thread.comments[0].id });
    assert.strictEqual(outside.status, 400);
    assert.strictEqual(outside.body.code, 'reply_target_not_found');

    events = [];
    const resolved = await call('POST', `/api/projects/p1/comments/${thread.id}/resolve`, { user: EDITOR2 });
    assert.strictEqual(resolved.status, 200);
    assert.strictEqual(resolved.body.thread.status, 'resolved');
    assert.strictEqual(resolved.body.thread.resolvedBy, 'eve');
    assert.strictEqual(resolved.body.thread.comments.length, 2);
    const again = await call('POST', `/api/projects/p1/comments/${thread.id}/resolve`);
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual(events.map((e) => e.kind), ['comment.resolved'], 'resolving twice announces once');

    events = [];
    const back = await replyTo(thread.id, 'Wait, one more thing');
    assert.strictEqual(back.status, 201);
    assert.deepStrictEqual(back.body.thread, { id: thread.id, status: 'open' });
    assert.deepStrictEqual(events.map((e) => e.kind), ['comment.reopened', 'comment.created']);

    const reopened = await call('POST', `/api/projects/p1/comments/${thread.id}/reopen`);
    assert.strictEqual(reopened.body.thread.status, 'open');
    const listed = await list({ targetType: 'notebook', targetId: 'nb1', status: 'open' });
    assert.ok(listed.body.threads.some((t) => t.id === thread.id));
    const onlyResolved = await list({ targetType: 'notebook', targetId: 'nb1', status: 'resolved' });
    assert.ok(!onlyResolved.body.threads.some((t) => t.id === thread.id));
});

test('only the author edits a comment; the author or the owner deletes it', async () => {
    const { thread } = await startThread();
    const first = thread.comments[0];
    const byOther = await call('PATCH', `/api/projects/p1/comments/${thread.id}/replies/${first.id}`, { body: { content: 'hijack' }, user: EDITOR2 });
    assert.strictEqual(byOther.status, 403);
    const byOwner = await call('PATCH', `/api/projects/p1/comments/${thread.id}/replies/${first.id}`, { body: { content: 'hijack' }, user: OWNER });
    assert.strictEqual(byOwner.status, 403, 'not even the owner edits someone else\'s words');

    events = [];
    const edited = await call('PATCH', `/api/projects/p1/comments/${thread.id}/replies/${first.id}`, { body: { content: 'Is 40k right, @eve?', mentions: ['eve'] } });
    assert.strictEqual(edited.status, 200);
    assert.strictEqual(edited.body.comment.content, 'Is 40k right, @eve?');
    assert.ok(edited.body.comment.editedAt);
    assert.deepStrictEqual(events.map((e) => e.kind), ['comment.updated', 'comment.mention']);

    const reply = await replyTo(thread.id, 'Mine', {}, EDITOR2);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/comments/${thread.id}/replies/${reply.body.comment.id}`)).status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/comments/${thread.id}/replies/${reply.body.comment.id}`, { user: OWNER })).status, 200);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/comments/${thread.id}/replies/${first.id}`)).status, 200);
    const after = await call('GET', `/api/projects/p1/comments/${thread.id}`);
    assert.deepStrictEqual(after.body.thread.comments.map((c) => [c.seq, c.deleted, c.content]), [[1, true, ''], [2, true, '']]);
    const late = await call('PATCH', `/api/projects/p1/comments/${thread.id}/replies/${first.id}`, { body: { content: 'again' } });
    assert.strictEqual(late.status, 409);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/comments/${thread.id}/replies/nope`, { body: { content: 'x' } })).status, 404);
});

test('an edit keeps what the comment asked: its mentions when none are sent, and an "Ask AI" stays one', async () => {
    const { thread } = await startThread({ content: 'Can you check this figure, @eve?', mentions: ['eve'], askAi: true });
    const first = thread.comments[0];
    assert.deepStrictEqual([first.mentions, first.mentionsAi], [['eve'], true]);
    const url = `/api/projects/p1/comments/${thread.id}/replies/${first.id}`;

    const typo = await call('PATCH', url, { body: { content: 'Can you check this figure, @eve? Thanks' } });
    assert.deepStrictEqual([typo.body.comment.mentions, typo.body.comment.mentionsAi], [['eve'], true], 'a typo fix changes neither');
    const narrowed = await call('PATCH', url, { body: { content: 'Can you check this figure?', mentions: [] } });
    assert.deepStrictEqual([narrowed.body.comment.mentions, narrowed.body.comment.mentionsAi], [[], true], 'a list that is sent replaces; the ask stays history');
    const stored = await store.getComment(thread.id, first.id);
    assert.deepStrictEqual([stored.mentions, stored.mentionsAi], [[], true]);
});

test('a long thread in the list shows its first and latest comments and says how many it leaves out', async () => {
    const small = serve('/api/projects', makeProjectCommentsRouter({ ...DEPS, store: makeProjectCommentStore(db, { maxCommentsListed: 1 }) }), { user: EDITOR });
    try {
        const { thread } = await startThread({ targetType: 'document', targetId: 'doc1', content: 'Where does this number come from?' });
        for (let i = 0; i < 11; i++) assert.strictEqual((await replyTo(thread.id, `Reply ${i}`)).status, 201);
        const listed = (await small.call('GET', '/api/projects/p1/comments?targetType=document&targetId=doc1')).body.threads.find((t) => t.id === thread.id);
        assert.deepStrictEqual(listed.comments.map((c) => c.seq), [1, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        assert.strictEqual(listed.comments[0].content, 'Where does this number come from?');
        assert.strictEqual(listed.omittedComments, 2);
        const whole = (await small.call('GET', `/api/projects/p1/comments/${thread.id}`)).body.thread;
        assert.strictEqual(whole.comments.length, 12, 'the thread itself serves all of them');
        assert.strictEqual(whole.omittedComments, undefined);
    } finally {
        await small.close();
    }
});

test('a thread longer than one page is read page by page, each saying how many older comments are left', async () => {
    // Pages of 5 stand in for the 500 a real read serves.
    const paged = serve('/api/projects', makeProjectCommentsRouter({ ...DEPS, store: makeProjectCommentStore(db, { threadPage: 5 }) }), { user: EDITOR });
    try {
        const { thread } = await startThread({ targetType: 'document', targetId: 'doc1', content: 'Long one' });
        for (let i = 0; i < 11; i++) assert.strictEqual((await replyTo(thread.id, `Reply ${i}`)).status, 201);
        const page = async (query = '') => (await paged.call('GET', `/api/projects/p1/comments/${thread.id}${query}`)).body.thread;

        const latest = await page();
        assert.deepStrictEqual(latest.comments.map((c) => c.seq), [8, 9, 10, 11, 12]);
        assert.strictEqual(latest.omittedComments, 7, 'it used to say nothing, and the middle read as complete');
        const middle = await page('?before=8');
        assert.deepStrictEqual([middle.comments.map((c) => c.seq), middle.omittedComments], [[3, 4, 5, 6, 7], 2]);
        const first = await page('?before=3');
        assert.deepStrictEqual([first.comments.map((c) => c.seq), first.omittedComments], [[1, 2], undefined]);
        assert.strictEqual(first.comments[0].content, 'Long one');

        const refused = await paged.call('GET', `/api/projects/p1/comments/${thread.id}?before=first`);
        assert.strictEqual(refused.status, 400);
        assert.match(refused.text, /before is the seq/);
        // A change answered with the thread says what it leaves out too.
        const resolved = await paged.call('POST', `/api/projects/p1/comments/${thread.id}/resolve`);
        assert.deepStrictEqual([resolved.body.thread.comments.length, resolved.body.thread.omittedComments], [5, 7]);
    } finally {
        await paged.close();
    }
});

test('the thread\'s creator or the owner deletes a thread', async () => {
    const { thread } = await startThread();
    assert.strictEqual((await call('DELETE', `/api/projects/p1/comments/${thread.id}`, { user: EDITOR2 })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/comments/${thread.id}`, { user: OWNER })).status, 200);
    assert.strictEqual((await call('GET', `/api/projects/p1/comments/${thread.id}`)).status, 404);
    const mine = await startThread();
    events = [];
    assert.strictEqual((await call('DELETE', `/api/projects/p1/comments/${mine.thread.id}`)).status, 200);
    assert.deepStrictEqual(events.map((e) => e.kind), ['comment.thread.deleted']);
});

test('a comment that will not open is served as unreadable, not as ciphertext', async () => {
    const { thread } = await startThread();
    await pg.query(`UPDATE project_comments SET content = 'not an envelope' WHERE thread_id = $1`, [thread.id]);
    await pg.query(`UPDATE project_comment_threads SET anchor = 'broken' WHERE id = $1`, [thread.id]);
    const res = await call('GET', `/api/projects/p1/comments/${thread.id}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.thread.anchor, null);
    assert.strictEqual(res.body.thread.anchorUnreadable, true);
    assert.strictEqual(res.body.thread.comments[0].content, '');
    assert.strictEqual(res.body.thread.comments[0].unreadable, true);
});

// ── The AI ───────────────────────────────────────────────────────────────

test('the AI answers when asked, never when off, and never on a plain comment in mention mode', async () => {
    const asked = await startThread({ content: 'What does 40k cover? @ai' });
    assert.deepStrictEqual(asked.ai, { status: 'queued' });
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].aiTrigger, 'mention');
    assert.strictEqual(replies[0].triggerText, 'What does 40k cover? @ai');
    assert.strictEqual(replies[0].thread.id, asked.thread.id);
    assert.strictEqual(replies[0].trigger.id, asked.thread.comments[0].id);
    assert.strictEqual(replies[0].orgId, 'org1');
    assert.strictEqual(asked.thread.comments[0].mentionsAi, true);

    nextReply = { status: 'busy' };
    const button = await replyTo(asked.thread.id, 'And the rest?', { askAi: true });
    assert.deepStrictEqual(button.body.ai, { status: 'busy' });
    assert.strictEqual(replies.at(-1).aiTrigger, 'ask');

    const plain = await replyTo(asked.thread.id, 'Thanks!');
    assert.deepStrictEqual(plain.body.ai, { status: 'skipped', reason: 'not_mentioned' });

    const quiet = await startThread({ aiMode: 'off', content: '@ai are you there?' });
    assert.deepStrictEqual(quiet.ai, { status: 'skipped', reason: 'ai_off' });
    assert.strictEqual(replies.length, 2);
    assert.deepStrictEqual(notices, []);
});

test('in auto mode every comment goes to the participation engine, and an explicit request is also answered at once', async () => {
    const { thread, ai } = await startThread({ aiMode: 'auto', content: 'Does anyone know where 40k comes from?' });
    assert.deepStrictEqual(ai, { status: 'skipped', reason: 'auto_pending' });
    assert.strictEqual(replies.length, 0);
    await settle();
    assert.deepStrictEqual(notices, [{
        threadId: thread.id, commentId: thread.comments[0].id, authorUserId: 'ed', projectId: 'p1', orgId: 'org1', limitOrgId: 'org1', explicit: false,
    }]);
    const direct = await replyTo(thread.id, '@assistant please check', {}, EDITOR2);
    assert.deepStrictEqual(direct.body.ai, { status: 'queued' });
    assert.strictEqual(replies.length, 1);
    await settle();
    assert.strictEqual(notices.length, 2);
    assert.strictEqual(notices[1].explicit, true, 'the engine learns the AI is answering anyway');
    assert.strictEqual(notices[1].authorUserId, 'eve');
    assert.strictEqual(JSON.stringify(notices).includes('40k'), false, 'the notice carries ids only');

    await call('POST', `/api/projects/p1/comments/${thread.id}/resolve`);
    assert.deepStrictEqual(cancels, [thread.id], 'a resolved thread leaves nothing queued');
    const mention = await startThread({ content: 'plain words' });
    await settle();
    assert.strictEqual(notices.length, 2, 'a mention-mode thread never reaches the engine');
    await call('POST', `/api/projects/p1/comments/${mention.thread.id}/resolve`);
    assert.deepStrictEqual(cancels, [thread.id]);
});

test('the engine is told after the comment is answered for, never in its way: a slow or failing engine holds nothing up', async () => {
    let release;
    engineDelay = () => new Promise((resolve) => { release = resolve; });
    const started = await startThread({ aiMode: 'auto', content: 'Does anyone know where 40k comes from?' });
    assert.deepStrictEqual(started.ai, { status: 'skipped', reason: 'auto_pending' }, 'the poster has the answer while the engine still reads');
    assert.deepStrictEqual(notices, []);
    release();
    await settle();
    assert.strictEqual(notices.length, 1, 'and the engine is told all the same');

    engineDelay = async () => { throw new Error('engine down'); };
    const reply = await replyTo(started.thread.id, 'Anyone?');
    assert.strictEqual(reply.status, 201, 'a failing engine never fails the comment');
    await settle();
});

test('leaving auto mode or deleting an auto thread withdraws it from the engine', async () => {
    const { thread } = await startThread({ aiMode: 'auto' });
    await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'mention' } });
    assert.deepStrictEqual(cancels, [thread.id]);
    await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'off' } });
    assert.deepStrictEqual(cancels, [thread.id], 'only the step away from auto');
    const other = await startThread({ aiMode: 'auto' });
    await call('DELETE', `/api/projects/p1/comments/${other.thread.id}`);
    assert.deepStrictEqual(cancels, [thread.id, other.thread.id]);
});

test('changing the AI mode is for editors and announced once', async () => {
    const { thread } = await startThread();
    const changed = await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'auto' } });
    assert.strictEqual(changed.status, 200);
    assert.strictEqual(changed.body.thread.aiMode, 'auto');
    const same = await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'auto' } });
    assert.strictEqual(same.status, 200);
    assert.deepStrictEqual(events.filter((e) => e.kind === 'comment.thread.updated').map((e) => e.payload.aiMode), ['auto']);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'loud' } })).status, 400);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: {} })).status, 400);
});

// ── "Not helpful" ────────────────────────────────────────────────────────

/** An answer the AI wrote into a thread, the way the participation surface stores it. */
async function aiAnswer(threadId, aiTrigger) {
    const box = await commentCrypto.forProject(PROJECTS.get('p1'));
    const id = `ai-${Math.random().toString(36).slice(2)}`;
    const out = await store.appendComment('p1', threadId, {
        id, authorKind: 'assistant', authorUserId: null, content: box.sealContent(threadId, id, 'An answer'), aiTrigger,
    });
    return out.comment;
}

test('"not helpful" is for automatic answers only, shows as the caller\'s own choice, and two pause auto for a day', async () => {
    const { thread } = await startThread({ aiMode: 'auto' });
    const first = await aiAnswer(thread.id, 'auto_quiet');
    const second = await aiAnswer(thread.id, 'auto_unanswered');
    const asked = await aiAnswer(thread.id, 'mention');
    const feedback = (commentId, helpful, user = EDITOR) => call('POST',
        `/api/projects/p1/comments/${thread.id}/replies/${commentId}/feedback`, { body: { helpful }, user });

    const refused = await feedback(asked.id, false);
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.body.code, 'not_automatic_answer');
    assert.strictEqual((await feedback(thread.comments[0].id, false)).status, 409, 'not on a person\'s comment');
    assert.strictEqual((await feedback(first.id, false, VIEWER)).status, 403);
    assert.strictEqual((await feedback(first.id, 'nope')).status, 400);

    const one = await feedback(first.id, false);
    assert.deepStrictEqual(one.body, { ok: true, helpful: false, autoPausedUntil: null });
    const listed = await call('GET', `/api/projects/p1/comments/${thread.id}`);
    const byId = new Map(listed.body.thread.comments.map((c) => [c.id, c]));
    assert.strictEqual(byId.get(first.id).feedback, false, 'the caller sees their own choice');
    assert.strictEqual(byId.get(second.id).feedback, null);
    assert.strictEqual('feedback' in byId.get(asked.id), false, 'an answer that was asked for has no feedback slot');

    events = [];
    const two = await feedback(second.id, false, EDITOR2);
    assert.strictEqual(two.body.autoPausedUntil, new Date(clock + 24 * 3600_000).toISOString());
    assert.deepStrictEqual(cancels, [thread.id], 'nothing stays queued while paused');
    assert.deepStrictEqual(events.map((e) => [e.kind, e.payload.autoPaused]), [['comment.thread.updated', true]]);
    const paused = await call('GET', `/api/projects/p1/comments/${thread.id}`);
    assert.strictEqual(paused.body.thread.autoPausedUntil, two.body.autoPausedUntil);

    await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'mention' } });
    const again = await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'auto' } });
    assert.strictEqual(again.body.thread.autoPausedUntil, null, 'choosing "AI decides" again lifts the pause');
});

test('"AI decides" on a thread only where the organisation allows it; off and mention always', async () => {
    const allowed = await list({ targetType: 'notebook', targetId: 'nb1' });
    assert.deepStrictEqual(allowed.body.aiPolicy, { autoAllowed: true }, 'the panel knows before anyone picks');
    try {
        orgPolicy = { autoAllowed: true, commentsAutoAllowed: false };
        assert.deepStrictEqual((await list({ targetType: 'notebook', targetId: 'nb1' }, VIEWER)).body.aiPolicy, { autoAllowed: false });
        const refused = await call('POST', '/api/projects/p1/comments', {
            body: { targetType: 'notebook', targetId: 'nb1', anchor: ANCHOR, content: 'Where does 40k come from?', aiMode: 'auto' },
        });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.body.code, 'ai_mode_not_allowed');
        const { thread } = await startThread({ aiMode: 'mention' });
        const change = await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'auto' } });
        assert.strictEqual(change.status, 403);
        assert.strictEqual((await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'off' } })).status, 200);
    } finally {
        orgPolicy = { autoAllowed: true, commentsAutoAllowed: true };
    }
});

test('a change of AI mode tells the compliance checks (ids only)', async () => {
    const { thread } = await startThread();
    assert.deepStrictEqual(signals, []);
    await call('PATCH', `/api/projects/p1/comments/${thread.id}`, { body: { aiMode: 'auto' } });
    assert.deepStrictEqual(signals, [{ projectId: 'p1', reason: 'ai_mode' }]);
    await call('DELETE', `/api/projects/p1/comments/${thread.id}`);
    assert.strictEqual(signals.length, 2, 'deleting a thread the AI could join by itself is a change too');
});
