/**
 * routes/projects/chats.js over a real Express app (core/http/routeHarness
 * serve()), with every dependency handed in through makeProjectChatsRouter:
 * the real store over PGlite, the real sealing with an injected project key,
 * and a fake role gate, assistant and feed. No module mocking.
 *
 * Proven:
 *   - the role ladder: no session 401, no role 404, viewer reads only, editor
 *     posts, only the author edits, the chat's creator or the owner deletes a
 *     chat, the author or the owner deletes a message;
 *   - a chat is only reached through its own project;
 *   - titles and bodies are stored sealed; a key that cannot be produced is a
 *     503 with nothing written; a damaged row is served as unreadable, not as
 *     ciphertext and not as an error for the whole chat;
 *   - a title taken from the first message follows it (edit) and goes with
 *     it (delete);
 *   - idempotent posts, member-only mentions, replies within the chat,
 *     archived chats refuse posts, a Solution holds no chats, an agent the
 *     caller may not use is refused;
 *   - the AI trigger rules as the route applies them (off, mention, always,
 *     @ai, askAi, @agent name) and the assistant's own answer passed through;
 *   - the feed and the activity log carry ids, never content;
 *   - closed bodies: a misspelled key is refused and nothing is stored;
 *   - `auto`: a post that does not ask goes to the participation engine (ids
 *     only) and the poster hears nothing more; an explicit ask is answered
 *     and tells the engine; the organisation can forbid `auto` and `always`,
 *     also for chats that already have them (a withdrawn `always` acts as
 *     `mention` and is served as `effectiveAiMode`);
 *     switching to `auto` posts a system notice, leaving it cancels what was
 *     queued; "not helpful" on automatic answers (editor+, automatic answers
 *     only, once per person) pauses `auto` after two, and each reader sees
 *     their own feedback — with the real participation store over PGlite.
 *
 * Run: cd server && node --test routes/projects/chats.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { serve, assertRefused } = require('../../core/http/routeHarness');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { fakeRequireProjectRole, projectUser } = require('../../testUtils/projectRoleGate');
const { makeProjectChatStore, DDL } = require('../../stores/projectChatStore');
const participationStoreModule = require('../../stores/projectAiParticipationStore');
const { makeChatCrypto } = require('../../projects/chatCrypto');
const { makeProjectChatsRouter, titleFromMessage } = require('./chats');

const who = projectUser;
const OWNER = who('olga');
const EDITOR = who('ed');
const EDITOR2 = who('eve');
const VIEWER = who('vic');
const STRANGER = who('sam');

const ROLES = {
    p1: { olga: 'owner', ed: 'editor', eve: 'editor', vic: 'viewer' },
    p2: { olga: 'owner', ed: 'editor' },
    sol: { olga: 'owner', ed: 'editor' },
    nokey: { olga: 'owner', ed: 'editor', vic: 'viewer' },
    strict: { olga: 'owner', ed: 'editor' },
};
const PROJECTS = {
    p1: { id: 'p1', name: 'Launch', organizationId: 'org1', kind: 'workspace' },
    p2: { id: 'p2', name: 'Other', organizationId: 'org1', kind: null },
    sol: { id: 'sol', name: 'Bundle', organizationId: 'org1', kind: 'solution' },
    nokey: { id: 'nokey', name: 'Broken vault', organizationId: 'org1', kind: 'workspace' },
    strict: { id: 'strict', name: 'Careful', organizationId: 'org-strict', kind: 'workspace' },
};
const AGENTS = {
    'agent-shared': { agentId: 'agent-shared', name: 'Sales Coach', users: ['olga', 'ed', 'eve'] },
    'agent-private': { agentId: 'agent-private', name: 'Olga Bot', users: ['olga'] },
};

const KEYS = new Map();
const { pg, db } = pgliteDb();
const store = makeProjectChatStore(db);
const participationStore = participationStoreModule.makeProjectAiParticipationStore(db);
const chatCrypto = makeChatCrypto({
    getProjectKey: async (projectId) => {
        if (projectId === 'nokey') throw new Error('org_root_key could not be decrypted');
        if (!KEYS.has(projectId)) KEYS.set(projectId, crypto.randomBytes(32));
        return KEYS.get(projectId);
    },
});

let events;
let bells;
let activity;
let replies;
let nextReply;
let told;
let cancelled;
let signals;
let taskDrops;
let orgLookupFails = false;
/** Per organisation: what an admin switched off since the chats were set up. */
let withdrawn = {};

const fakeParticipation = {
    async onHumanMessage(args) { told.push(args); return { watched: true }; },
    async cancelContainer(surface, id) { cancelled.push([surface, id]); return 1; },
};
const fakePolicy = {
    async resolveOrgPolicy(orgId) {
        const base = orgId === 'org-strict' ? { autoAllowed: false, alwaysAllowed: false } : { autoAllowed: true, alwaysAllowed: true };
        return { ...base, ...(withdrawn[orgId] || {}) };
    },
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

const fakeAssistant = {
    async requestReply(args) {
        replies.push(args);
        return nextReply;
    },
};

const requireProjectRole = fakeRequireProjectRole(ROLES);

const api = serve('/api/projects', makeProjectChatsRouter({
    requireProjectRole,
    getProjectRole: async (userId, projectId) => ROLES[projectId]?.[userId] || null,
    getProject: async (id) => (PROJECTS[id] ? { ...PROJECTS[id] } : null),
    store,
    chatCrypto,
    assistant: fakeAssistant,
    resolveAgent: async ({ agentId, userId }) => {
        const a = AGENTS[agentId];
        return a && a.users.includes(userId) ? { agentId: a.agentId, name: a.name } : null;
    },
    isChatAgentAllowed: async () => true,
    filedIds: async (_projectId, kind) => (kind === 'meeting' ? new Set(['mt-1']) : new Set()),
    listChatAgents: async () => [],
    resolveOrgs: async () => {
        if (orgLookupFails) throw new Error('db gone');
        return { orgId: 'org1', limitOrgId: 'org1' };
    },
    emit: async (projectId, event) => { events.push({ projectId, ...event }); },
    logActivity: async (projectId, actorId, action, details) => { activity.push({ projectId, actorId, action, details }); },
    postLimiter: function rateLimitMiddleware(req, res, next) { next(); },
    participation: fakeParticipation,
    policy: fakePolicy,
    participationStore,
    signalProjectChanged: (project, reason) => { signals.push({ projectId: project.id, reason }); },
    taskStore: { dropLinksTo: async (...args) => { taskDrops.push(args); return 0; } },
    collabNotifier: { chatMentioned: async (args) => { bells.push(args); } },
}), { user: EDITOR });

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(DDL);
    await pg.exec(participationStoreModule.DDL);
    for (const id of Object.keys(PROJECTS)) await pg.query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [id, 'olga']);
});
after(async () => { await api.close(); await pg.close(); });
beforeEach(() => {
    events = [];
    bells = [];
    activity = [];
    replies = [];
    nextReply = { status: 'queued' };
    told = [];
    cancelled = [];
    signals = [];
    taskDrops = [];
    withdrawn = {};
    orgLookupFails = false;
});

const call = (method, url, opts = {}) => api.call(method, url, opts);
async function startChat(body = {}, user = EDITOR, projectId = 'p1') {
    const res = await call('POST', `/api/projects/${projectId}/chats`, { body, user });
    assert.strictEqual(res.status, 201, res.text);
    return res.body;
}
async function say(chatId, content, extra = {}, user = EDITOR, projectId = 'p1') {
    return call('POST', `/api/projects/${projectId}/chats/${chatId}/messages`, { body: { content, ...extra }, user });
}
const countRows = async (table) => Number((await pg.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n);

// ── Role ladder ──────────────────────────────────────────────────────────

test('no session is 401, no role on the project is 404 on every route', async () => {
    const { chat } = await startChat({ title: 'Ladder' });
    assert.strictEqual((await call('GET', '/api/projects/p1/chats', { user: null })).status, 401);
    const urls = [
        ['GET', '/api/projects/p1/chats'],
        ['POST', '/api/projects/p1/chats', { title: 'x' }],
        ['GET', `/api/projects/p1/chats/${chat.id}`],
        ['PATCH', `/api/projects/p1/chats/${chat.id}`, { title: 'x' }],
        ['DELETE', `/api/projects/p1/chats/${chat.id}`],
        ['GET', `/api/projects/p1/chats/${chat.id}/messages`],
        ['POST', `/api/projects/p1/chats/${chat.id}/messages`, { content: 'hi' }],
        ['POST', `/api/projects/p1/chats/${chat.id}/read`, { seq: 1 }],
    ];
    for (const [method, url, body] of urls) {
        const res = await call(method, url, { body, user: STRANGER });
        assert.strictEqual(res.status, 404, `${method} ${url} → ${res.status}`);
    }
});

test('a viewer reads but cannot start, post, change or delete', async () => {
    const { chat } = await startChat({ title: 'Read only', message: 'hello team' });
    assert.strictEqual((await call('GET', '/api/projects/p1/chats', { user: VIEWER })).status, 200);
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${chat.id}`, { user: VIEWER })).status, 200);
    const msgs = await call('GET', `/api/projects/p1/chats/${chat.id}/messages`, { user: VIEWER });
    assert.strictEqual(msgs.status, 200);
    assert.strictEqual((await call('POST', `/api/projects/p1/chats/${chat.id}/read`, { body: { seq: 1 }, user: VIEWER })).status, 200);

    assert.strictEqual((await call('POST', '/api/projects/p1/chats', { body: { title: 'x' }, user: VIEWER })).status, 403);
    assert.strictEqual((await say(chat.id, 'me too', {}, VIEWER)).status, 403);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { aiMode: 'off' }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/chats/${chat.id}`, { user: VIEWER })).status, 403);
    const msgId = msgs.body.messages[0].id;
    assert.strictEqual((await call('PATCH', `/api/projects/p1/chats/${chat.id}/messages/${msgId}`, { body: { content: 'x' }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/chats/${chat.id}/messages/${msgId}`, { user: VIEWER })).status, 403);
});

test('only the creator or the owner deletes a chat', async () => {
    const { chat } = await startChat({ title: 'Mine' });
    const other = await call('DELETE', `/api/projects/p1/chats/${chat.id}`, { user: EDITOR2 });
    assert.strictEqual(other.status, 403);
    assert.strictEqual(other.body.code, 'not_chat_creator');
    assert.strictEqual((await call('DELETE', `/api/projects/p1/chats/${chat.id}`, { user: EDITOR })).status, 200);
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${chat.id}`)).status, 404);

    const { chat: second } = await startChat({ title: 'Theirs' }, EDITOR2);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/chats/${second.id}`, { user: OWNER })).status, 200);
    assert.deepStrictEqual(activity.filter((a) => a.action === 'chat.deleted').map((a) => a.details), [
        { targetType: 'project_chat', targetId: chat.id },
        { targetType: 'project_chat', targetId: second.id },
    ]);
    assert.deepStrictEqual(events.filter((e) => e.kind === 'chat.deleted').map((e) => e.payload), [{ chatId: chat.id }, { chatId: second.id }]);
    assert.deepStrictEqual(taskDrops, [['p1', 'chat', chat.id], ['p1', 'chat', second.id]], 'tasks stop linking a deleted chat');
});

test('only the author edits; the author or the owner deletes a message', async () => {
    const { chat, message } = await startChat({ message: 'first draft' });
    const byOther = await call('PATCH', `/api/projects/p1/chats/${chat.id}/messages/${message.id}`, { body: { content: 'hijack' }, user: EDITOR2 });
    assert.strictEqual(byOther.status, 403);
    assert.strictEqual(byOther.body.code, 'not_message_author');
    const byOwner = await call('PATCH', `/api/projects/p1/chats/${chat.id}/messages/${message.id}`, { body: { content: 'owner edit' }, user: OWNER });
    assert.strictEqual(byOwner.status, 403, 'the owner may delete but not rewrite someone else\'s words');

    const edited = await call('PATCH', `/api/projects/p1/chats/${chat.id}/messages/${message.id}`, { body: { content: 'second draft' } });
    assert.strictEqual(edited.status, 200);
    assert.strictEqual(edited.body.message.content, 'second draft');
    assert.ok(edited.body.message.editedAt);
    const updatedEvent = events.find((e) => e.kind === 'chat.message.updated');
    assert.deepStrictEqual(updatedEvent.payload, { chatId: chat.id, messageId: message.id, seq: 1 });

    assert.strictEqual((await call('DELETE', `/api/projects/p1/chats/${chat.id}/messages/${message.id}`, { user: EDITOR2 })).status, 403);
    const del = await call('DELETE', `/api/projects/p1/chats/${chat.id}/messages/${message.id}`, { user: OWNER });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(taskDrops, [['p1', 'thread', message.id]], 'tasks stop linking the thread of a deleted message');
    const again = await call('PATCH', `/api/projects/p1/chats/${chat.id}/messages/${message.id}`, { body: { content: 'too late' } });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, 'message_deleted');

    const list = await call('GET', `/api/projects/p1/chats/${chat.id}/messages`);
    assert.deepStrictEqual(
        list.body.messages.map((m) => ({ seq: m.seq, content: m.content, deleted: m.deleted })),
        [{ seq: 1, content: '', deleted: true }],
    );
    assert.deepStrictEqual(events.find((e) => e.kind === 'chat.message.deleted').payload, { chatId: chat.id, messageId: message.id, seq: 1 });
});

test('a chat is only reached through its own project', async () => {
    const { chat } = await startChat({ title: 'Here only', message: 'hi' });
    // Ed is an editor on p2 as well: the role passes, the chat does not.
    for (const [method, url, body] of [
        ['GET', `/api/projects/p2/chats/${chat.id}`],
        ['GET', `/api/projects/p2/chats/${chat.id}/messages`],
        ['POST', `/api/projects/p2/chats/${chat.id}/messages`, { content: 'sneak' }],
        ['PATCH', `/api/projects/p2/chats/${chat.id}`, { title: 'moved' }],
        ['POST', `/api/projects/p2/chats/${chat.id}/read`, { seq: 1 }],
    ]) {
        const res = await call(method, url, { body });
        assert.strictEqual(res.status, 404, `${method} ${url}`);
        assert.strictEqual(res.body.code, 'chat_not_found');
    }
    assert.strictEqual((await call('DELETE', `/api/projects/p2/chats/${chat.id}`, { user: OWNER })).status, 404);
});

// ── Starting and posting ────────────────────────────────────────────────

test('starting a chat: title from the first message, sealed at rest, ids-only feed', async () => {
    const text = 'Can someone review the Q3 pricing sheet before Friday? It has the confidential margins in it.';
    const out = await startChat({ message: text });
    assert.strictEqual(out.chat.title, titleFromMessage(text));
    assert.ok(out.chat.title.length <= 61 && out.chat.title.endsWith('…'));
    assert.strictEqual(out.chat.aiMode, 'mention');
    assert.strictEqual(out.chat.createdBy, 'ed');
    assert.strictEqual(out.chat.messageCount, 1);
    assert.strictEqual(out.message.content, text);
    assert.strictEqual(out.message.seq, 1);
    assert.strictEqual(out.message.authorUserId, 'ed');
    assert.deepStrictEqual(out.ai, { status: 'skipped', reason: 'not_mentioned' });

    const row = (await pg.query('SELECT title FROM project_chats WHERE id = $1', [out.chat.id])).rows[0];
    const msg = (await pg.query('SELECT content FROM project_chat_messages WHERE id = $1', [out.message.id])).rows[0];
    assert.ok(!row.title.includes('pricing') && JSON.parse(row.title)._bfenc === 1, 'the title is sealed');
    assert.ok(!msg.content.includes('pricing') && JSON.parse(msg.content)._bfenc === 1, 'the body is sealed');

    assert.deepStrictEqual(events.map((e) => e.kind), ['chat.created', 'chat.message.created']);
    assert.deepStrictEqual(events[1].payload, { chatId: out.chat.id, messageId: out.message.id, seq: 1, authorKind: 'user' });
    assert.deepStrictEqual(activity, [{ projectId: 'p1', actorId: 'ed', action: 'chat.created', details: { targetType: 'project_chat', targetId: out.chat.id } }]);
    const everything = JSON.stringify({ events, activity });
    assert.ok(!everything.includes('pricing') && !everything.includes('Q3'), 'no content in the feed or the activity log');
});

test('starting a chat without a message: "New chat", no AI, and a Solution refuses', async () => {
    const out = await startChat({});
    assert.strictEqual(out.chat.title, 'New chat');
    assert.strictEqual(out.message, null);
    assert.deepStrictEqual(out.ai, { status: 'skipped', reason: 'no_message' });
    const named = await startChat({ title: '  Weekly sync  ', aiMode: 'off' });
    assert.strictEqual(named.chat.title, 'Weekly sync');
    assert.strictEqual(named.chat.aiMode, 'off');

    const sol = await call('POST', '/api/projects/sol/chats', { body: { title: 'x' } });
    assert.strictEqual(sol.status, 409);
    assert.strictEqual(sol.body.code, 'SOLUTION_HOLDS_NO_CHATS');
    // A legacy project (kind not set yet) still takes chats.
    assert.strictEqual((await call('POST', '/api/projects/p2/chats', { body: { title: 'legacy' } })).status, 201);
});

test('an agent the caller may not use is refused; one they may use is kept', async () => {
    const refused = await call('POST', '/api/projects/p1/chats', { body: { agentId: 'agent-private' } });
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(refused.body.code, 'agent_unavailable');
    const ok = await startChat({ agentId: 'agent-shared' });
    assert.strictEqual(ok.chat.agentId, 'agent-shared');
    const patch = await call('PATCH', `/api/projects/p1/chats/${ok.chat.id}`, { body: { agentId: 'agent-private' } });
    assert.strictEqual(patch.status, 400);
    const cleared = await call('PATCH', `/api/projects/p1/chats/${ok.chat.id}`, { body: { agentId: null, title: 'Renamed', archived: true } });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.body.chat.agentId, null);
    assert.strictEqual(cleared.body.chat.title, 'Renamed');
    assert.strictEqual(cleared.body.chat.archived, true);
    assert.deepStrictEqual(events.at(-1), { projectId: 'p1', kind: 'chat.updated', actorId: 'ed', targetType: 'project_chat', targetId: ok.chat.id, payload: { chatId: ok.chat.id } });
});

test('a retried post with the same clientMsgId is the same message, answered once', async () => {
    const { chat } = await startChat({ aiMode: 'always' });
    events = [];
    const first = await say(chat.id, 'ping', { clientMsgId: 'c-1' });
    const retry = await say(chat.id, 'ping', { clientMsgId: 'c-1' });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.body.message.id, first.body.message.id);
    assert.strictEqual(retry.body.message.clientMsgId, 'c-1');
    assert.deepStrictEqual(retry.body.ai, { status: 'skipped', reason: 'duplicate' });
    assert.strictEqual(replies.length, 1, 'the assistant was asked once');
    assert.strictEqual(events.filter((e) => e.kind === 'chat.message.created').length, 1);
    const stolen = await say(chat.id, 'other', { clientMsgId: 'c-1' }, EDITOR2);
    assert.strictEqual(stolen.status, 409);
    assert.strictEqual(stolen.body.code, 'client_msg_id_taken');
});

test('mentions keep project members only and raise chat.mention', async () => {
    const { chat } = await startChat({ aiMode: 'off' });
    events = [];
    const res = await say(chat.id, 'Vic and Olga, please look', { mentions: ['vic', 'olga', 'sam', 'vic'] });
    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.body.message.mentions, ['vic', 'olga']);
    const mention = events.find((e) => e.kind === 'chat.mention');
    assert.deepStrictEqual(mention.payload, { chatId: chat.id, messageId: res.body.message.id, mentionedUserIds: ['vic', 'olga'] });
    assert.deepStrictEqual(bells.map((b) => [b.project.id, b.actorId, b.mentionedUserIds, b.chatId]), [['p1', 'ed', ['vic', 'olga'], chat.id]]);
    assert.ok(!JSON.stringify(bells).includes('please look'), 'the bell is not given the message');
});

test('replies stay within the chat; archived chats refuse posts', async () => {
    const { chat, message } = await startChat({ message: 'question', aiMode: 'off' });
    const { message: elsewhere } = await startChat({ message: 'other', aiMode: 'off' });
    const bad = await say(chat.id, 'answer', { replyTo: elsewhere.id });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.code, 'reply_target_not_found');
    const good = await say(chat.id, 'answer', { replyTo: message.id });
    assert.strictEqual(good.body.message.replyTo, message.id);

    await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { archived: true } });
    const archived = await say(chat.id, 'late');
    assert.strictEqual(archived.status, 409);
    assert.strictEqual(archived.body.code, 'chat_archived');
    const open = await call('GET', '/api/projects/p1/chats');
    assert.ok(!open.body.chats.some((c) => c.id === chat.id));
    const done = await call('GET', '/api/projects/p1/chats?archived=1');
    assert.ok(done.body.chats.some((c) => c.id === chat.id));
});

// ── The AI trigger rules ────────────────────────────────────────────────

test('AI off: never asked, not even with askAi or @ai', async () => {
    const { chat } = await startChat({ aiMode: 'off' });
    for (const [content, extra] of [['@ai help', {}], ['help', { askAi: true }]]) {
        const res = await say(chat.id, content, extra);
        assert.deepStrictEqual(res.body.ai, { status: 'skipped', reason: 'ai_off' });
    }
    assert.strictEqual(replies.length, 0);
});

test('AI on mention: @ai, @assistant, askAi and @<agent> ask; plain text and e-mail addresses do not', async () => {
    const { chat } = await startChat({ agentId: 'agent-shared' });
    const cases = [
        ['what do you think?', {}, 'skipped'],
        ['mail me at me@ai.example', {}, 'skipped'],
        ['@ai what do you think?', {}, 'queued'],
        ['thoughts, @Assistant?', {}, 'queued'],
        ['no mention here', { askAi: true }, 'queued'],
        ['@Sales Coach how would you pitch this?', {}, 'queued'],
    ];
    for (const [content, extra, status] of cases) {
        const res = await say(chat.id, content, extra);
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.ai.status, status, content);
    }
    assert.strictEqual(replies.length, 4);
    const r = replies[0];
    assert.strictEqual(r.chat.id, chat.id);
    assert.strictEqual(r.project.id, 'p1');
    assert.strictEqual(r.userId, 'ed');
    assert.strictEqual(r.triggerText, '@ai what do you think?');
    assert.strictEqual(r.orgId, 'org1');
    assert.strictEqual(r.limitOrgId, 'org1');
    assert.ok(r.trigger.id && r.trigger.seq > 0);
    assert.deepStrictEqual(replies.map((x) => x.aiTrigger), ['mention', 'mention', 'ask', 'mention'], 'why the AI answers goes along');
    assert.deepStrictEqual(told, [], 'mention mode never involves the participation engine');
});

test('@<agent name> does not ask when the poster may not use the agent', async () => {
    const { chat } = await startChat({ agentId: 'agent-private' }, OWNER);
    const res = await say(chat.id, '@Olga Bot summarise please', {}, EDITOR);
    assert.deepStrictEqual(res.body.ai, { status: 'skipped', reason: 'not_mentioned' });
    const byOwner = await say(chat.id, '@Olga Bot summarise please', {}, OWNER);
    assert.strictEqual(byOwner.body.ai.status, 'queued');
});

test('AI always: every post asks, and the assistant\'s answer is passed through', async () => {
    const { chat } = await startChat({ aiMode: 'always' });
    assert.strictEqual((await say(chat.id, 'plain')).body.ai.status, 'queued');
    nextReply = { status: 'busy' };
    assert.deepStrictEqual((await say(chat.id, 'again')).body.ai, { status: 'busy' });
    nextReply = { status: 'skipped', reason: 'no_model' };
    assert.deepStrictEqual((await say(chat.id, 'and again')).body.ai, { status: 'skipped', reason: 'no_model' });
    assert.strictEqual(replies.length, 3);
});

test('an organisation that withdraws "always" stops the chats that already have it: only an explicit ask is answered', async () => {
    const { chat } = await startChat({ aiMode: 'always', agentId: 'agent-shared' });
    assert.strictEqual((await say(chat.id, 'before the change')).body.ai.status, 'queued');
    withdrawn.org1 = { alwaysAllowed: false };
    replies = [];

    const plain = await say(chat.id, 'Patient J. Smith needs a follow-up next week');
    assert.strictEqual(plain.status, 201, 'the message itself is stored');
    assert.deepStrictEqual(plain.body.ai, { status: 'skipped', reason: 'ai_mode_not_allowed' });
    assert.strictEqual(replies.length, 0, 'nothing reaches the model');
    assert.strictEqual((await say(chat.id, '@ai summarise please')).body.ai.status, 'queued');
    assert.strictEqual((await say(chat.id, '@Sales Coach your view?')).body.ai.status, 'queued');
    assert.strictEqual((await say(chat.id, 'this one too', { askAi: true })).body.ai.status, 'queued');
    assert.deepStrictEqual(replies.map((r) => r.aiTrigger), ['mention', 'mention', 'ask']);
    await settle();
    assert.deepStrictEqual(told, [], 'no engine for a chat that acts as mention');

    // The chat keeps its stored mode; the screen reads what it does now.
    const detail = await call('GET', `/api/projects/p1/chats/${chat.id}`);
    assert.strictEqual(detail.body.chat.aiMode, 'always');
    assert.strictEqual(detail.body.chat.effectiveAiMode, 'mention');
    const listed = (await call('GET', '/api/projects/p1/chats')).body.chats.find((c) => c.id === chat.id);
    assert.strictEqual(listed.effectiveAiMode, 'mention');
    const renamed = await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { title: 'Still here' } });
    assert.strictEqual(renamed.body.chat.effectiveAiMode, 'mention');

    withdrawn = {};
    assert.strictEqual((await say(chat.id, 'allowed again')).body.ai.status, 'queued', 'allowed again: every post asks again');
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${chat.id}`)).body.chat.effectiveAiMode, 'always');
});

test('a title taken from the first message follows it: an edit re-derives it, a delete resets it', async () => {
    const text = 'Patient J. Smith, BSN 123456789, needs a follow-up about the scan results';
    const out = await startChat({ message: text });
    const url = `/api/projects/p1/chats/${out.chat.id}`;
    assert.strictEqual(out.chat.title, titleFromMessage(text));

    events = [];
    const edited = await call('PATCH', `${url}/messages/${out.message.id}`, { body: { content: 'Follow-up about the scan' } });
    assert.strictEqual(edited.status, 200);
    assert.strictEqual((await call('GET', url)).body.chat.title, 'Follow-up about the scan');
    assert.deepStrictEqual(events.map((e) => e.kind), ['chat.message.updated', 'chat.updated']);

    events = [];
    assert.strictEqual((await call('DELETE', `${url}/messages/${out.message.id}`)).status, 200);
    assert.strictEqual((await call('GET', url)).body.chat.title, 'New chat');
    const listed = (await call('GET', '/api/projects/p1/chats')).body.chats.find((c) => c.id === out.chat.id);
    assert.strictEqual(listed.title, 'New chat');
    assert.deepStrictEqual(events.map((e) => e.kind), ['chat.message.deleted', 'chat.updated']);
    const row = (await pg.query('SELECT title FROM project_chats WHERE id = $1', [out.chat.id])).rows[0];
    assert.strictEqual(row.title, '', 'no copy of the words is left at rest');

    // A name somebody typed, or chose later, is not the message's.
    const named = await startChat({ title: 'Weekly sync', message: 'hello there, the agenda' });
    await call('DELETE', `/api/projects/p1/chats/${named.chat.id}/messages/${named.message.id}`);
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${named.chat.id}`)).body.chat.title, 'Weekly sync');
    const renamed = await startChat({ message: 'the first words of this chat' });
    await call('PATCH', `/api/projects/p1/chats/${renamed.chat.id}`, { body: { title: 'Chosen' } });
    await call('DELETE', `/api/projects/p1/chats/${renamed.chat.id}/messages/${renamed.message.id}`);
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${renamed.chat.id}`)).body.chat.title, 'Chosen');
});

// ── Reading ─────────────────────────────────────────────────────────────

test('messages page ascending; the list shows the last message and unread', async () => {
    const { chat } = await startChat({ aiMode: 'off', message: 'one' });
    await say(chat.id, 'two', {}, EDITOR2);
    await say(chat.id, 'three', {}, EDITOR2);
    const page = await call('GET', `/api/projects/p1/chats/${chat.id}/messages?limit=2`);
    assert.deepStrictEqual(page.body.messages.map((m) => [m.seq, m.content]), [[2, 'two'], [3, 'three']]);
    assert.strictEqual(page.body.hasMore, true);
    const tail = await call('GET', `/api/projects/p1/chats/${chat.id}/messages?after=1`);
    assert.deepStrictEqual(tail.body.messages.map((m) => m.seq), [2, 3]);
    assert.strictEqual(tail.body.hasMore, false);

    const listed = (await call('GET', '/api/projects/p1/chats')).body;
    assert.strictEqual(listed.role, 'editor');
    const row = listed.chats.find((c) => c.id === chat.id);
    assert.deepStrictEqual(row.lastMessage, { authorKind: 'user', authorUserId: 'eve', excerpt: 'three' });
    assert.strictEqual(row.unread, 2);
    assert.strictEqual((await call('POST', `/api/projects/p1/chats/${chat.id}/read`, { body: { seq: 3 } })).status, 200);
    const reread = (await call('GET', '/api/projects/p1/chats')).body.chats.find((c) => c.id === chat.id);
    assert.strictEqual(reread.unread, 0);
});

test('a damaged row is served as unreadable, the rest of the chat still reads', async () => {
    const { chat, message } = await startChat({ aiMode: 'off', message: 'intact one' });
    const second = (await say(chat.id, 'will be damaged')).body.message;
    const env = JSON.parse((await pg.query('SELECT content FROM project_chat_messages WHERE id = $1', [second.id])).rows[0].content);
    env.ct = (env.ct[0] === 'a' ? 'b' : 'a') + env.ct.slice(1);
    await pg.query('UPDATE project_chat_messages SET content = $2 WHERE id = $1', [second.id, JSON.stringify(env)]);
    // A plaintext value slipped in by hand is refused the same way.
    const third = (await say(chat.id, 'will be plain')).body.message;
    await pg.query('UPDATE project_chat_messages SET content = $2 WHERE id = $1', [third.id, 'plain text written behind our back']);

    const res = await call('GET', `/api/projects/p1/chats/${chat.id}/messages`);
    assert.strictEqual(res.status, 200);
    const byId = Object.fromEntries(res.body.messages.map((m) => [m.id, m]));
    assert.strictEqual(byId[message.id].content, 'intact one');
    assert.strictEqual(byId[message.id].unreadable, undefined);
    assert.deepStrictEqual([byId[second.id].content, byId[second.id].unreadable], ['', true]);
    assert.deepStrictEqual([byId[third.id].content, byId[third.id].unreadable], ['', true]);
});

test('a project key that cannot be produced is a 503 and nothing is written', async () => {
    const before = await countRows('project_chats');
    const res = await call('POST', '/api/projects/nokey/chats', { body: { message: 'secret plan' } });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.code, 'PROJECT_KEY_UNAVAILABLE');
    assert.doesNotMatch(res.body.error, /org_root_key/);
    assert.strictEqual(await countRows('project_chats'), before);
    assert.strictEqual((await call('GET', '/api/projects/nokey/chats', { user: VIEWER })).status, 503);
    assert.deepStrictEqual(events, []);
});

// ── Closed bodies ───────────────────────────────────────────────────────

test('misspelled or out-of-range input is refused by name and nothing is stored', async () => {
    const { chat } = await startChat({ aiMode: 'off' });
    const msgsBefore = await countRows('project_chat_messages');
    const chatsBefore = await countRows('project_chats');
    assertRefused(assert, await say(chat.id, 'hi', { askAI: true }), 'body', /does not take "askAI"/);
    assertRefused(assert, await say(chat.id, '   '), 'body.content', /content is the message text/);
    assertRefused(assert, await say(chat.id, 'x'.repeat(20001)), 'body.content', /20000/);
    assertRefused(assert, await say(chat.id, 'hi', { mentions: 'vic' }), 'body.mentions', /mentions is a list/);
    assertRefused(assert, await call('POST', '/api/projects/p1/chats', { body: { aiMode: 'loud' } }), 'body.aiMode', /aiMode is off, mention, auto or always/);
    assertRefused(assert, await call('POST', '/api/projects/p1/chats', { body: { title: 'x'.repeat(201) } }), 'body.title', /200/);
    assertRefused(assert, await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { title: '  ' } }), 'body.title', /1 to 200/);
    assertRefused(assert, await call('GET', `/api/projects/p1/chats/${chat.id}/messages?limit=500`), 'query.limit', /1 to 200/);
    assertRefused(assert, await call('GET', '/api/projects/p1/chats?archived=yes'), 'query.archived', /archived is 1/);
    assertRefused(assert, await call('POST', `/api/projects/p1/chats/${chat.id}/read`, { body: {} }), 'body.seq', /seq is the seq/);
    assert.strictEqual(await countRows('project_chat_messages'), msgsBefore);
    assert.strictEqual(await countRows('project_chats'), chatsBefore);
    assert.strictEqual(replies.length, 0);
});

// ── The AI that joins on its own ────────────────────────────────────────

test('auto: a post that does not ask goes to the engine, ids only; an explicit ask is answered and tells it', async () => {
    const { chat } = await startChat({ aiMode: 'auto', agentId: 'agent-shared' });
    events = [];
    const plain = await say(chat.id, 'Does anyone know the refund policy for annual plans?');
    assert.strictEqual(plain.status, 201);
    assert.deepStrictEqual(plain.body.ai, { status: 'skipped', reason: 'auto' }, 'the poster hears nothing more');
    await settle();
    assert.deepStrictEqual(told, [{
        surface: 'chat', containerId: chat.id, messageId: plain.body.message.id, authorUserId: 'ed', projectId: 'p1', orgId: 'org1', limitOrgId: 'org1',
    }]);
    assert.strictEqual(replies.length, 0);

    told = [];
    const asked = await say(chat.id, '@Sales Coach what do you think?');
    assert.strictEqual(asked.body.ai.status, 'queued');
    assert.strictEqual(replies[0].aiTrigger, 'mention');
    await settle();
    assert.strictEqual(told.length, 1);
    assert.strictEqual(told[0].explicit, true, 'the engine cancels what it queued');
    assert.ok(!JSON.stringify(told).includes('refund') && !JSON.stringify(told).includes('Sales'), 'no content goes to the engine');
});

test('the organisation decides whether auto and always may be chosen', async () => {
    const refused = await call('POST', '/api/projects/strict/chats', { body: { aiMode: 'auto' } });
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.body.code, 'ai_mode_not_allowed');
    assert.match(refused.body.error, /does not let the AI join chats by itself/);
    assert.strictEqual((await call('POST', '/api/projects/strict/chats', { body: { aiMode: 'always' } })).status, 403);
    const { chat } = await startChat({ aiMode: 'mention' }, EDITOR, 'strict');
    const toAuto = await call('PATCH', `/api/projects/strict/chats/${chat.id}`, { body: { aiMode: 'auto' } });
    assert.strictEqual(toAuto.status, 403);
    assert.strictEqual((await call('PATCH', `/api/projects/strict/chats/${chat.id}`, { body: { title: 'Renamed', aiMode: 'mention' } })).status, 200,
        'the mode it has is fine');
    const listed = await call('GET', '/api/projects/strict/chats');
    assert.deepStrictEqual(listed.body.aiPolicy, { autoAllowed: false, alwaysAllowed: false });
    const detail = await call('GET', `/api/projects/p1/chats/${(await startChat({})).chat.id}`);
    assert.deepStrictEqual(detail.body.aiPolicy, { autoAllowed: true, alwaysAllowed: true });
});

test('switching to auto posts one system notice; leaving auto cancels what was queued', async () => {
    const { chat } = await startChat({ aiMode: 'mention', message: 'hello team' });
    events = [];
    const on = await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { aiMode: 'auto' }, user: EDITOR2 });
    assert.strictEqual(on.status, 200);
    assert.strictEqual(on.body.chat.aiMode, 'auto');
    const again = await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { aiMode: 'auto' } });
    assert.strictEqual(again.status, 200);

    const page = (await call('GET', `/api/projects/p1/chats/${chat.id}/messages`)).body.messages;
    const notices = page.filter((m) => m.authorKind === 'system');
    assert.strictEqual(notices.length, 1, 'one notice per switch, not per save');
    assert.deepStrictEqual(
        { authorUserId: notices[0].authorUserId, notice: notices[0].notice, content: notices[0].content, aiTrigger: notices[0].aiTrigger },
        { authorUserId: 'eve', notice: 'ai_auto_on', content: '', aiTrigger: null },
    );
    const created = events.filter((e) => e.kind === 'chat.message.created');
    assert.deepStrictEqual(created.map((e) => e.payload.authorKind), ['system']);
    const row = (await call('GET', '/api/projects/p1/chats')).body.chats.find((c) => c.id === chat.id);
    assert.deepStrictEqual(row.lastMessage, { authorKind: 'system', authorUserId: 'eve', excerpt: '', notice: 'ai_auto_on' });
    assert.strictEqual(row.unread, 1, 'the notice is news for the others');

    assert.deepStrictEqual(cancelled, []);
    await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { aiMode: 'mention' } });
    assert.deepStrictEqual(cancelled, [['chat', chat.id]]);

    const born = await startChat({ aiMode: 'auto', message: 'first question?' });
    const firstPage = (await call('GET', `/api/projects/p1/chats/${born.chat.id}/messages`)).body.messages;
    assert.deepStrictEqual(firstPage.map((m) => m.authorKind), ['system', 'user'], 'a chat started in auto says so first');
});

async function autoAnswer(chatId, trigger = 'auto_quiet') {
    const box = await chatCrypto.forProject(PROJECTS.p1);
    const id = `answer-${Math.random().toString(36).slice(2)}`;
    const saved = await store.appendMessage({
        id, projectId: 'p1', chatId, authorKind: 'assistant', content: box.sealContent(chatId, id, 'Annual plans are refundable within 30 days.'),
        aiTrigger: trigger, aiReason: 'open_question_answerable',
    });
    return saved.message;
}

test('"Not helpful": editors only, automatic answers only, once per person, two pause auto for a day', async () => {
    const { chat } = await startChat({ aiMode: 'auto' });
    const a1 = await autoAnswer(chat.id);
    const a2 = await autoAnswer(chat.id, 'auto_unanswered');
    const asked = await autoAnswer(chat.id, 'ask');
    const url = (id) => `/api/projects/p1/chats/${chat.id}/messages/${id}/feedback`;

    assert.strictEqual((await call('POST', url(a1.id), { body: { helpful: false }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('POST', url(a1.id), { body: { helpful: false }, user: STRANGER })).status, 404);
    const notAuto = await call('POST', url(asked.id), { body: { helpful: false } });
    assert.strictEqual(notAuto.status, 409);
    assert.strictEqual(notAuto.body.code, 'not_automatic_answer');
    assert.strictEqual((await call('POST', url('nope'), { body: { helpful: false } })).status, 404);
    assertRefused(assert, await call('POST', url(a1.id), { body: { helpful: false, reason: 'meh' } }), 'body', /does not take "reason"/);
    assertRefused(assert, await call('POST', url(a1.id), { body: {} }), 'body.helpful', /helpful is false/);

    events = [];
    const first = await call('POST', url(a1.id), { body: { helpful: false } });
    assert.deepStrictEqual(first.body, { ok: true, helpful: false, autoPausedUntil: null });
    const repeat = await call('POST', url(a1.id), { body: { helpful: false } });
    assert.strictEqual(repeat.body.autoPausedUntil, null, 'the same person twice is one dismissal');
    assert.deepStrictEqual(cancelled, []);

    const second = await call('POST', url(a2.id), { body: { helpful: false }, user: EDITOR2 });
    assert.strictEqual(second.status, 200);
    const until = Date.parse(second.body.autoPausedUntil);
    assert.ok(until > Date.now() + 23 * 3600_000 && until < Date.now() + 25 * 3600_000, 'paused for 24 hours');
    assert.deepStrictEqual(cancelled, [['chat', chat.id]]);
    assert.deepStrictEqual(events.map((e) => e.kind), ['chat.updated']);
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${chat.id}`)).body.chat.autoPausedUntil, second.body.autoPausedUntil);

    const mine = (await call('GET', `/api/projects/p1/chats/${chat.id}/messages`)).body.messages;
    const byId = Object.fromEntries(mine.map((m) => [m.id, m]));
    assert.strictEqual(byId[a1.id].myFeedback, 'not_helpful');
    assert.strictEqual(byId[a2.id].myFeedback, null, 'another person\'s feedback is theirs');
    assert.strictEqual(byId[a1.id].aiTrigger, 'auto_quiet');
    assert.strictEqual(byId[a1.id].aiReason, 'open_question_answerable');
    assert.strictEqual(byId[asked.id].myFeedback, undefined, 'only automatic answers carry feedback');
    const rows = (await pg.query('SELECT * FROM project_ai_feedback WHERE container_id = $1', [chat.id])).rows;
    assert.strictEqual(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes('refundable'), 'feedback holds no content');
});

test('deleting an auto chat or archiving it cancels what was queued', async () => {
    const { chat } = await startChat({ aiMode: 'auto' });
    await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { archived: true } });
    assert.deepStrictEqual(cancelled, [['chat', chat.id]]);
    const { chat: other } = await startChat({ aiMode: 'auto' });
    await call('DELETE', `/api/projects/p1/chats/${other.id}`);
    assert.deepStrictEqual(cancelled.at(-1), ['chat', other.id]);
});

test('a change of AI mode tells the compliance checks (ids only); other edits do not', async () => {
    const { chat } = await startChat({ aiMode: 'off' });
    assert.deepStrictEqual(signals, [], 'a chat without the AI joining by itself changes nothing they read');
    await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { title: 'Renamed' } });
    assert.deepStrictEqual(signals, []);
    await call('PATCH', `/api/projects/p1/chats/${chat.id}`, { body: { aiMode: 'always' } });
    assert.deepStrictEqual(signals, [{ projectId: 'p1', reason: 'ai_mode' }]);
    await call('DELETE', `/api/projects/p1/chats/${chat.id}`);
    assert.deepStrictEqual(signals.length, 2, 'deleting a chat the AI answered in by itself is a change too');
});

// ── Threads, tagged items, response depth ────────────────────────────────

test('a reply in a thread is stored with its thread and served with it; a reply cannot start a thread', async () => {
    const { chat } = await startChat({ title: 'Threads' });
    const root = (await say(chat.id, 'root')).body.message;
    const reply = await say(chat.id, 'inside', { threadId: root.id });
    assert.strictEqual(reply.status, 201, reply.text);
    assert.strictEqual(reply.body.message.threadId, root.id);
    const listed = (await call('GET', `/api/projects/p1/chats/${chat.id}/messages`)).body.messages;
    assert.strictEqual(listed.find((m) => m.id === reply.body.message.id).threadId, root.id);
    const nested = await say(chat.id, 'deeper', { threadId: reply.body.message.id });
    assert.strictEqual(nested.status, 400);
    assert.strictEqual(nested.body.code, 'thread_not_found');
});

test('tagged documents and notebooks must be filed in the project, and are served as kind and id', async () => {
    const { chat } = await startChat({ title: 'Tags' });
    const refused = await say(chat.id, 'see this', { refs: [{ kind: 'document', id: 'not-filed' }] });
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(refused.body.code, 'ref_not_in_project');
    assert.strictEqual((await say(chat.id, 'see this', { refs: [{ kind: 'chat', id: 'x' }] })).status, 400, 'only documents, notebooks and meetings');
    const meeting = await say(chat.id, 'as discussed in the weekly', { refs: [{ kind: 'meeting', id: 'mt-1' }] });
    assert.strictEqual(meeting.status, 201, meeting.text);
    assert.deepStrictEqual(meeting.body.message.refs, [{ kind: 'meeting', id: 'mt-1' }]);
    const other = await say(chat.id, 'that one', { refs: [{ kind: 'meeting', id: 'mt-elsewhere' }] });
    assert.strictEqual(other.body.code, 'ref_not_in_project', 'a meeting that is not filed in this project');
});

test('the asked response depth reaches the assistant, and an answer is served with how it was made', async () => {
    const { chat } = await startChat({ title: 'Depth', aiMode: 'always' });
    await say(chat.id, 'think hard', { modelTier: 'pro' });
    assert.strictEqual(replies[0].modelTier, 'pro');
    await say(chat.id, 'quick');
    assert.strictEqual(replies[1].modelTier, null);
});

test('how an answer was made is served to readers, sealed at rest, and only while there is something to show', async () => {
    const { chat } = await startChat({ title: 'Trace' });
    const asked = (await say(chat.id, 'my mail is ann@example.test')).body.message;
    const box = await chatCrypto.forProject({ id: 'p1', organizationId: 'org1' });
    const id = crypto.randomUUID();
    const { answerRecord } = require('../../projects/chatTrace');
    const { aiMeta, aiTrace } = answerRecord({
        model: { tier: 'fast', requestedTier: 'fast', modelId: 'm1' }, outbound: { tokenMap: { '[email_1]': 'ann@example.test' }, categories: ['EMAIL'] },
        triggerText: 'my mail is ann@example.test', rawAnswer: 'Noted, [email_1].', box, chatId: chat.id, messageId: id,
    });
    await store.appendMessage({ id, projectId: 'p1', chatId: chat.id, authorKind: 'assistant', content: box.sealContent(chat.id, id, 'Noted, ann@example.test.'), replyTo: asked.id, aiMeta, aiTrace });
    const listed = (await call('GET', `/api/projects/p1/chats/${chat.id}/messages`, { user: VIEWER })).body.messages.find((m) => m.id === id);
    assert.deepStrictEqual(listed.aiMeta, { tier: 'fast', requestedTier: 'fast', redacted: 1, categories: ['EMAIL'], trace: true });
    assert.ok(!JSON.stringify(listed).includes('[email_1]'), 'the list carries no trace');
    const stored = (await pg.query('SELECT ai_trace FROM project_chat_messages WHERE id = $1', [id])).rows[0].ai_trace;
    assert.ok(!stored.includes('ann@example.test'), 'sealed at rest');
    const viewer = await call('GET', `/api/projects/p1/chats/${chat.id}/messages/${id}/trace`, { user: VIEWER });
    assert.strictEqual(viewer.status, 200, viewer.text);
    assert.deepStrictEqual(viewer.body.trace, {
        model: 'm1', tier: 'fast', categories: ['EMAIL'], original: 'my mail is ann@example.test', sent: 'my mail is [email_1]',
        tokenMap: { '[email_1]': 'ann@example.test' }, returned: 'Noted, [email_1].',
    });
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${chat.id}/messages/${id}/trace`, { user: STRANGER })).status, 404);
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${chat.id}/messages/${asked.id}/trace`)).status, 404, 'a message with no trace');
    await call('DELETE', `/api/projects/p1/chats/${chat.id}/messages/${asked.id}`);
    assert.strictEqual((await call('GET', `/api/projects/p1/chats/${chat.id}/messages/${id}/trace`)).status, 404, 'the message it answered was deleted');
});

test('a post that is stored but whose AI step fails is still a 201, and a retry is the same message', async () => {
    const { chat } = await startChat({ title: 'Flaky', aiMode: 'always' });
    orgLookupFails = true;
    const first = await say(chat.id, 'what is the plan?', { clientMsgId: 'cm-flaky' });
    assert.strictEqual(first.status, 201, first.text);
    assert.deepStrictEqual(first.body.ai, { status: 'skipped', reason: 'unavailable' });
    assert.strictEqual(first.body.message.content, 'what is the plan?');
    assert.strictEqual(replies.length, 0);

    orgLookupFails = false;
    const retry = await say(chat.id, 'what is the plan?', { clientMsgId: 'cm-flaky' });
    assert.strictEqual(retry.body.message.id, first.body.message.id, 'the retry finds the stored message');
    assert.deepStrictEqual(retry.body.ai, { status: 'skipped', reason: 'duplicate' });
});

test('a chat started with a first message that cannot be stored is taken back, not left as an empty orphan', async () => {
    const before = await countRows('project_chats');
    const real = store.appendMessage;
    store.appendMessage = async () => { throw new Error('db gone'); };
    events.length = 0;
    try {
        const res = await call('POST', '/api/projects/p1/chats', { body: { message: 'Budget review Q3?' }, user: EDITOR });
        assert.strictEqual(res.status, 500);
    } finally {
        store.appendMessage = real;
    }
    assert.strictEqual(await countRows('project_chats'), before, 'no orphan chat is left');
    assert.deepStrictEqual(events.map((e) => e.kind), ['chat.created', 'chat.deleted'], 'the team is told it is gone again');
});
