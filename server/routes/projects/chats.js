// @typecheck
/**
 * Team chats inside a project — people talking to each other, with the AI
 * answering when asked, or joining on its own in `auto` mode. Mounted under
 * /api/projects (the mount carries requireAuthedUser and the
 * module/capability/feature gates).
 *
 * GET    /:id/chats?archived=0|1                              viewer   list with unread + last message
 * POST   /:id/chats                                           editor   start a chat (optionally with a first message)
 * GET    /:id/chats/:chatId                                   viewer
 * PATCH  /:id/chats/:chatId                                   editor   title, AI mode, agent, archived
 * DELETE /:id/chats/:chatId                                   editor   the person who started it, or the project owner
 * GET    /:id/chats/:chatId/messages?after=&before=&limit=    viewer   ascending by seq
 * POST   /:id/chats/:chatId/messages                          editor   idempotent on clientMsgId; `threadId` posts into the thread of a message, `refs` tags documents and notebooks of the project
 * PATCH  /:id/chats/:chatId/messages/:messageId               editor   the author only
 * DELETE /:id/chats/:chatId/messages/:messageId               editor   the author, or the project owner (soft)
 * POST   /:id/chats/:chatId/read                              viewer   move my read marker
 * POST   /:id/chats/:chatId/messages/:messageId/feedback      editor   "not helpful" on an automatic answer
 * GET    /:id/chats/:chatId/messages/:messageId/trace         viewer   how an answer was made when the Privacy Shield replaced values (sealed; 404 otherwise)
 *
 * Every route starts with the shared role gate (auth/projectAccess): 404 for
 * someone with no role on the project, 403 for a role that is too low. A chat
 * is only ever looked up THROUGH its project, so a chat id from another
 * project is a 404 too.
 *
 * Titles and message bodies are sealed with the project key before they are
 * stored and opened after they are read (projects/chatCrypto.js). A key that
 * cannot be produced is a 503 PROJECT_KEY_UNAVAILABLE; nothing is ever stored
 * or served in plaintext instead. A single message that will not open is
 * served as `content: ''` with `unreadable: true` (and logged), so one damaged
 * row cannot take the whole chat down. A title taken from the first message
 * follows that message: editing it re-derives the title, deleting it (or
 * erasing its author) resets the title to "New chat" (stores/projectChatStore).
 *
 * Threads: a message with `threadId` set is a reply in the thread of that
 * (main-conversation) message and is shown only there; `replyTo` stays the
 * quote. The AI answers a thread message inside the same thread and reads the
 * thread, not the main conversation. `refs` are `{kind, id}` pairs of
 * documents and notebooks filed in the project (400 `ref_not_in_project`
 * otherwise); the AI is handed what the asker may read of them.
 *
 * Live feed (core/projectFeed, durable): chat.created, chat.updated,
 * chat.deleted, chat.message.created, chat.message.updated,
 * chat.message.deleted — payload `{chatId, messageId?, seq?, authorKind?}` —
 * and chat.mention `{chatId, messageId, mentionedUserIds}`. Never content.
 * The activity log records chat.created and chat.deleted only. The AI's own
 * events come from projects/chatAssistant.js.
 *
 * ── The AI that joins on its own (`auto`) ──────────────────────────────────
 *
 * The organisation decides whether `auto` and `always` may be chosen
 * (projects/participation/policy.js; 403 `ai_mode_not_allowed` otherwise, and
 * the list and detail answers carry `aiPolicy` so the screen can say so).
 * Withdrawing a mode also reaches the chats that already have it: each chat
 * is served with its `effectiveAiMode`, and a withdrawn `always` is checked
 * on every post and acts as `mention` (a post that does not ask hears
 * `ai: {status:'skipped', reason:'ai_mode_not_allowed'}`); a withdrawn `auto`
 * is refused by the participation engine's own check.
 * Switching a chat to `auto` posts a system notice for every member (a
 * `system` message with a notice code and no text); leaving `auto` cancels
 * whatever the engine had queued. In `auto`, a post that does not ask the AI
 * is handed to the participation engine AFTER it is stored and announced, and
 * the poster hears `ai: {status:'skipped', reason:'auto'}` — the AI may or may
 * not join later, silently. Two "not helpful" on automatic answers in 24 hours
 * pause `auto` in that chat for 24 hours (`autoPausedUntil`).
 *
 * Built by a factory so the test hands in the store, the key, the role gate
 * and the assistant; the default instance uses the real ones, required lazily.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { projectAccessDeps } = require('./roleGate');
const { badRequest, forbidden, notFound, conflict } = require('../../core/http/errors');
const S = require('./chatSchemas');

const DEFAULT_TITLE = 'New chat';
const AUTO_TRIGGERS = Object.freeze(['auto_quiet', 'auto_unanswered']);
/** "Not helpful" twice in a chat within the window pauses `auto` there for PAUSE_MS. */
const BACKOFF_DISMISSALS = 2;
const PAUSE_MS = 24 * 60 * 60_000;
const TITLE_FROM_MESSAGE = 60;
const EXCERPT_CHARS = 140;

/** "The first ~60 characters of the message", on one line. */
function titleFromMessage(message) {
    const line = String(message || '').replace(/\s+/g, ' ').trim();
    if (!line) return '';
    return line.length > TITLE_FROM_MESSAGE ? `${line.slice(0, TITLE_FROM_MESSAGE).trimEnd()}…` : line;
}

function excerptOf(text) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS).trimEnd()}…` : line;
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => Express middleware (auth/projectAccess)
 * @param {Function} [deps.getProjectRole]      (userId, projectId) => role|null, for mentions
 * @param {Function} [deps.getProject]          (id) => project row
 * @param {object}   [deps.store]               stores/projectChatStore surface
 * @param {object}   [deps.chatCrypto]          { forProject(project) }
 * @param {object}   [deps.assistant]           { requestReply(...) } (projects/chatAssistant)
 * @param {Function} [deps.isChatAgentAllowed]  (project, {agentId, userId}) => boolean: an agent every member may use
 * @param {Function} [deps.listChatAgents]      (project, {userId}) => the agents a chat here may answer as
 * @param {object}   [deps.taskStore]          stores/projectTaskStore surface (drops task links to a deleted chat or thread)
 * @param {Function} [deps.filedIds]            (projectId, kind) => Set of ids of documents, notebooks or meeting notes filed in the project
 * @param {Function} [deps.resolveAgent]        ({agentId, userId}) => { agentId, name } | null
 * @param {Function} [deps.resolveOrgs]         (req) => { orgId, limitOrgId }
 * @param {Function} [deps.emit]                (projectId, event) => durable event
 * @param {Function} [deps.logActivity]         (projectId, actorId, action, details) => activity row
 * @param {Function} [deps.postLimiter]         Express middleware on posting
 * @param {object}   [deps.participation]       { onHumanMessage, cancelContainer } (projects/participation)
 * @param {object}   [deps.policy]              { resolveOrgPolicy } (projects/participation/policy)
 * @param {object}   [deps.participationStore]  { recordFeedback, feedbackFor } (stores/projectAiParticipationStore)
 * @param {Function} [deps.signalProjectChanged]  (project, reason) => void (routes/projects/complianceSignal)
 * @param {Function} [deps.now]
 * @param {Function} [deps.newId]
 */
function makeProjectChatsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });

    // The shared gate, bound on first use so requiring this file (the default
    // instance below) loads no store. Same name as the gate itself, which is
    // what the project route-table baseline records.
    const { requireRole, getProjectRole, getProject } = projectAccessDeps(deps);
    // A chat's AI mode is something the project compliance checks read.
    const aiModeChanged = (project) => (deps.signalProjectChanged || require('./complianceSignal').signalProjectChanged)(project, 'ai_mode');
    const store = () => deps.store || require('../../stores/projectChatStore');
    const taskStore = () => deps.taskStore || require('../../stores/projectTaskStore');
    /** What a task linked to (a chat, or the thread of a message) is gone: the link goes, the task stays. Best effort. */
    async function dropTaskLinks(projectId, kind, id) {
        try {
            await taskStore().dropLinksTo(projectId, kind, id);
        } catch (err) {
            log.warn(`[ProjectChat] task links to ${kind} ${id} not dropped: ${err && err.message}`);
        }
    }
    const chatCrypto = () => deps.chatCrypto || require('../../projects/chatCrypto');
    let defaultAssistant = null;
    const assistant = () => deps.assistant
        || (defaultAssistant || (defaultAssistant = require('../../projects/chatAssistant').makeChatAssistant()));
    const resolveAgent = deps.resolveAgent
        || ((args) => require('../../projects/chatAssistant').resolveUsableAgent(args));
    const isChatAgentAllowed = deps.isChatAgentAllowed
        || ((project, args) => require('../../projects/chatAssistant').isChatAgentAllowed(project, args));
    const listChatAgents = deps.listChatAgents
        || ((project, args) => require('../../projects/chatAssistant').listChatAgents(project, args));
    // The ids of what is filed in the project, per kind, for validating `refs`.
    const filedIds = deps.filedIds || (async (projectId, kind) => {
        const entry = require('../../projects/membership').getKind(kind);
        const rows = entry ? await entry.list(projectId) : [];
        return new Set((rows || []).map((r) => r.id));
    });
    const resolveOrgs = deps.resolveOrgs || (async (req) => {
        const userId = req.session.user.id;
        const orgId = await require('../../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId });
        const limitOrgId = await require('../../core/entitlements/limits').resolveOrgId(req);
        return { orgId: orgId || null, limitOrgId: limitOrgId || null };
    });
    const emit = deps.emit
        || ((projectId, event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectChat' }));
    const logActivity = deps.logActivity
        || ((projectId, actorId, action, details) => require('../../stores/projectStore').logActivity(projectId, actorId, action, details));
    // One budget for starting chats and posting, per member: generous for a
    // conversation, a wall for a runaway client.
    let defaultLimiter = null;
    const postLimiter = deps.postLimiter || function rateLimitMiddleware(req, res, next) {
        if (!defaultLimiter) {
            defaultLimiter = require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 120, name: 'project-chat-post' });
        }
        return defaultLimiter(req, res, next);
    };
    const participation = () => deps.participation || require('../../projects/participation');
    const policy = () => deps.policy || require('../../projects/participation/policy').defaultPolicy();
    const participationStore = () => deps.participationStore || require('../../stores/projectAiParticipationStore');
    const now = deps.now || (() => Date.now());
    const newId = deps.newId || (() => crypto.randomUUID());

    const userIdOf = (req) => req.session.user.id;

    /** What the organisation lets a chat choose. Never throws (the policy narrows on failure). */
    async function aiPolicyFor(project) {
        const p = await policy().resolveOrgPolicy(project.organizationId || null);
        return { autoAllowed: !!p.autoAllowed, alwaysAllowed: !!p.alwaysAllowed };
    }

    /**
     * The mode a chat acts in right now. A mode the organisation withdrew
     * after the chat chose it acts as `mention`: an explicit ask is still
     * answered, nothing else reaches the model. The chat keeps its stored
     * mode, so it comes back when the organisation allows it again.
     *
     * @param {string} aiMode
     * @param {{ autoAllowed: boolean, alwaysAllowed: boolean }} allowed
     */
    function effectiveAiMode(aiMode, allowed) {
        if (aiMode === 'always' && !allowed.alwaysAllowed) return 'mention';
        if (aiMode === 'auto' && !allowed.autoAllowed) return 'mention';
        return aiMode;
    }

    /** Refuse a mode the organisation does not allow. */
    async function assertModeAllowed(project, aiMode) {
        if (aiMode !== 'auto' && aiMode !== 'always') return;
        const allowed = await aiPolicyFor(project);
        if (aiMode === 'auto' && !allowed.autoAllowed) {
            throw forbidden('ai_mode_not_allowed', 'Your organisation does not let the AI join chats by itself. Choose another AI mode.');
        }
        if (aiMode === 'always' && !allowed.alwaysAllowed) {
            throw forbidden('ai_mode_not_allowed', 'Your organisation does not let the AI answer every message. Choose another AI mode.');
        }
    }

    /**
     * "The AI now joins on its own": a system message every member sees once.
     * Best-effort: the mode change stands even when the notice does not land.
     */
    async function postAutoNotice(project, chat, userId) {
        try {
            const saved = await store().appendMessage({
                id: newId(), projectId: project.id, chatId: chat.id, authorKind: 'system', authorUserId: userId, content: '', notice: 'ai_auto_on',
            });
            if (saved && !saved.stale && saved.created) {
                await emit(project.id, chatEvent('chat.message.created', userId, chat.id, { messageId: saved.message.id, seq: saved.message.seq, authorKind: 'system' }));
            }
        } catch (err) {
            log.warn(`[ProjectChat] auto notice not posted in chat ${chat.id}: ${err && err.message}`);
        }
    }

    /** Undo a chat that was created together with a first message that failed to store. */
    async function rollBackNewChat(project, chat, userId) {
        try {
            if (!(await store().deleteChat(project.id, chat.id))) return;
            await emit(project.id, chatEvent('chat.deleted', userId, chat.id));
            if (chat.aiMode === 'auto') await participation().cancelContainer('chat', chat.id);
            if (chat.aiMode === 'auto' || chat.aiMode === 'always') aiModeChanged(project);
        } catch (err) {
            log.warn(`[ProjectChat] chat ${chat.id} could not be rolled back after its first message failed: ${err && err.message}`);
        }
    }

    /** Hand a stored post to the participation engine without holding up the answer. */
    function tellParticipation(args) {
        Promise.resolve()
            .then(() => participation().onHumanMessage({ surface: 'chat', ...args }))
            .catch((err) => log.warn(`[ProjectChat] participation not told about message ${args.messageId}: ${err && err.message}`));
    }

    async function loadProject(req) {
        const project = await getProject(req.params.id);
        // Deleted between the role check and here.
        if (!project) throw notFound('not_found', 'Not found');
        return project;
    }

    async function loadChat(project, chatId) {
        const chat = await store().getChat(project.id, chatId);
        if (!chat) throw notFound('chat_not_found', 'This chat does not exist in this project.');
        return chat;
    }

    /** Only the audit trail; a failure there must not undo what was done. */
    async function audit(projectId, actorId, action, chatId) {
        try {
            await logActivity(projectId, actorId, action, { targetType: 'project_chat', targetId: chatId });
        } catch (err) {
            log.warn(`[ProjectChat] activity not recorded (${action}): ${err && err.message}`);
        }
    }

    const chatEvent = (kind, actorId, chatId, payload = {}) => ({
        kind, actorId, targetType: 'project_chat', targetId: chatId, payload: { chatId, ...payload },
    });

    /** Open a sealed field, or report it unreadable without taking the request down. */
    function tryOpen(open, what) {
        try {
            return { text: open(), ok: true };
        } catch (err) {
            log.error(`[ProjectChat] ${what} could not be decrypted: ${err && err.code}`);
            return { text: '', ok: false };
        }
    }

    /**
     * @param {any} box
     * @param {any} chat
     * @param {{ autoAllowed: boolean, alwaysAllowed: boolean }} allowed  what the organisation allows now
     */
    function presentChat(box, chat, allowed) {
        // A title reset after its source message was deleted is stored empty
        // (the store holds no key to seal the default with).
        const title = chat.title === ''
            ? { text: DEFAULT_TITLE, ok: true }
            : tryOpen(() => box.openTitle(chat.id, chat.title), `title of chat ${chat.id}`);
        return {
            id: chat.id,
            title: title.text,
            ...(title.ok ? {} : { unreadable: true }),
            aiMode: chat.aiMode,
            effectiveAiMode: effectiveAiMode(chat.aiMode, allowed),
            autoPausedUntil: chat.autoPausedUntil || null,
            agentId: chat.agentId,
            createdBy: chat.createdBy,
            archived: chat.archived,
            messageCount: chat.messageCount,
            lastMessageAt: chat.lastMessageAt,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
        };
    }

    /**
     * @param {any} box
     * @param {any} m
     * @param {string} [plaintext]
     * @param {Map<string, boolean>} [feedback]  the caller's own feedback, by message id
     */
    function presentMessage(box, m, plaintext, feedback) {
        const out = {
            id: m.id,
            seq: m.seq,
            authorKind: m.authorKind,
            authorUserId: m.authorUserId,
            agentId: m.agentId,
            content: '',
            mentions: m.mentions,
            replyTo: m.replyTo,
            threadId: m.threadId || null,
            refs: m.refs || [],
            aiMeta: m.aiMeta ? { ...m.aiMeta, trace: !!m.aiTrace } : null,
            clientMsgId: m.clientMsgId,
            aiTrigger: m.aiTrigger || null,
            aiReason: m.aiReason || null,
            notice: m.notice || null,
            createdAt: m.createdAt,
            editedAt: m.editedAt,
            deleted: !!m.deletedAt,
        };
        if (m.authorKind === 'assistant' && AUTO_TRIGGERS.includes(m.aiTrigger)) {
            out.myFeedback = feedback && feedback.has(m.id) ? (feedback.get(m.id) ? 'helpful' : 'not_helpful') : null;
        }
        // A notice has no text to open.
        if (m.deletedAt || m.authorKind === 'system') return out;
        if (typeof plaintext === 'string') { out.content = plaintext; return out; }
        const opened = tryOpen(() => box.openContent(m.chatId, m.id, m.content), `message ${m.id} in chat ${m.chatId}`);
        out.content = opened.text;
        if (!opened.ok) out.unreadable = true;
        return out;
    }

    /** Mentions are kept only for people who are on the project right now. */
    async function memberMentions(projectId, ids) {
        const unique = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
        const kept = [];
        for (const id of unique) {
            try {
                if (await getProjectRole(id, projectId)) kept.push(id);
            } catch (_) { /* unknown is not a member */ }
        }
        return kept;
    }

    /** Tagged items must belong to this project; anything else is a 400. */
    async function checkedRefs(projectId, refs) {
        const unique = [];
        for (const r of refs || []) if (!unique.some((u) => u.kind === r.kind && u.id === r.id)) unique.push({ kind: r.kind, id: r.id });
        for (const kind of new Set(unique.map((r) => r.kind))) {
            if (kind === 'task') {
                for (const r of unique.filter(item => item.kind === 'task')) {
                    if (!(await taskStore().getTask(projectId, r.id))) throw badRequest('ref_not_in_project', 'You can only tag tasks in this project.');
                }
                continue;
            }
            const filed = await filedIds(projectId, kind);
            if (unique.some((r) => r.kind === kind && !filed.has(r.id))) {
                throw badRequest('ref_not_in_project', 'You can only tag documents, notebooks and meeting notes that are filed in this project.');
            }
        }
        return unique;
    }

    /**
     * Store one human message, announce it, and ask the assistant when the
     * chat's rule says so. Shared by "start a chat with a first message" and
     * "post a message".
     */
    async function postMessage(req, { project, chat, box, content, clientMsgId = null, replyTo = null, threadId = null, refs = [], mentions = [], askAi = false, modelTier = null, messageId = newId() }) {
        const userId = userIdOf(req);
        const kept = await memberMentions(project.id, mentions);
        const keptRefs = await checkedRefs(project.id, refs);
        let result;
        try {
            result = await store().appendMessage({
                id: messageId,
                projectId: project.id,
                chatId: chat.id,
                authorKind: 'user',
                authorUserId: userId,
                content: box.sealContent(chat.id, messageId, content),
                mentions: kept,
                replyTo,
                threadId,
                refs: keptRefs,
                clientMsgId,
            });
        } catch (err) {
            if (err?.code === 'THREAD_NOT_FOUND') throw badRequest('thread_not_found', 'threadId must be a message in this chat that is not itself a reply in a thread.');
            if (err?.code === 'REPLY_TARGET_NOT_FOUND') throw badRequest('reply_target_not_found', 'replyTo must be a message in this chat.');
            if (err?.code === 'CLIENT_MSG_ID_TAKEN') throw conflict('client_msg_id_taken', 'This clientMsgId was already used for another message in this chat. Send a new id.');
            throw err;
        }
        if (!result) throw notFound('chat_not_found', 'This chat does not exist in this project.');
        if (!result.created) {
            // A retry of a post that already landed: the same message, and no
            // second AI answer.
            return { created: false, message: presentMessage(box, result.message), ai: { status: 'skipped', reason: 'duplicate' } };
        }

        const stored = result.message;
        /** @type {{ status: string, reason?: string }} */
        let ai;
        // The message is stored and visible: whatever fails from here on must not turn
        // the post into an error, or a retry would hit `duplicate` and never be answered.
        try {
            await emit(project.id, chatEvent('chat.message.created', userId, chat.id, { messageId: stored.id, seq: stored.seq, authorKind: 'user' }));
            if (kept.length > 0) {
                await emit(project.id, chatEvent('chat.mention', userId, chat.id, { messageId: stored.id, mentionedUserIds: kept }));
            }

            const { decideAiTrigger, mentionsAssistant } = require('../../projects/chatAssistant');
            // `always` sends every post to the model, so it is re-checked against
            // the organisation on every post: a withdrawn `always` acts as
            // `mention`. (`auto` is re-checked by the participation engine itself.)
            const aiMode = chat.aiMode === 'always' ? effectiveAiMode(chat.aiMode, await aiPolicyFor(project)) : chat.aiMode;
            let agentName = null;
            // The agent's name only matters for "@<agent name>" in mention and
            // auto mode, and only an agent the poster may use can be addressed by them.
            if ((aiMode === 'mention' || aiMode === 'auto') && !askAi && chat.agentId && content.includes('@') && !mentionsAssistant(content)) {
                try {
                    agentName = (await resolveAgent({ agentId: chat.agentId, userId }))?.name || null;
                } catch (err) {
                    log.warn(`[ProjectChat] agent lookup failed for chat ${chat.id}: ${err && err.message}`);
                }
            }
            const decision = decideAiTrigger({ aiMode, content, askAi, agentName });
            const notice = { containerId: chat.id, messageId: stored.id, authorUserId: userId, projectId: project.id };
            if (decision.trigger === false && decision.reason === 'auto_pending' && threadId) {
                // The AI joins the main conversation on its own, not a thread; asked outright it answers there too.
                ai = { status: 'skipped', reason: 'auto' };
            } else if (decision.trigger === false && decision.reason === 'auto_pending') {
                // The engine decides later, quietly; the poster is told nothing more.
                const { orgId, limitOrgId } = await resolveOrgs(req);
                tellParticipation({ ...notice, orgId, limitOrgId });
                ai = { status: 'skipped', reason: 'auto' };
            } else if (decision.trigger === false) {
                ai = { status: 'skipped', reason: aiMode !== chat.aiMode ? 'ai_mode_not_allowed' : decision.reason };
            } else {
                const { orgId, limitOrgId } = await resolveOrgs(req);
                // Asked outright in an auto chat: whatever the engine had queued is moot.
                if (chat.aiMode === 'auto') tellParticipation({ ...notice, orgId, limitOrgId, explicit: true });
                const reply = await assistant().requestReply({
                    project, chat, trigger: stored, triggerText: content, userId, orgId, limitOrgId, session: req.session, aiTrigger: decision.kind, modelTier,
                });
                ai = reply.reason ? { status: reply.status, reason: reply.reason } : { status: reply.status };
            }
        } catch (err) {
            log.warn(`[ProjectChat] message ${stored.id} in chat ${chat.id} stored, but the AI step failed: ${err && err.message}`);
            ai = { status: 'skipped', reason: 'unavailable' };
        }
        return { created: true, message: presentMessage(box, stored, content), ai };
    }

    // ── Chats ─────────────────────────────────────────────────────────────

    router.get('/:id/chats', requireRole('viewer'), validate({ query: S.ListChatsQuery }), async (req, res) => {
        const project = await loadProject(req);
        const rows = await store().listChats(project.id, { userId: userIdOf(req), archived: req.query.archived === '1' });
        const box = await chatCrypto().forProject(project);
        const aiPolicy = await aiPolicyFor(project);
        const chats = rows.map((row) => {
            let lastMessage = null;
            if (row.lastMessage && row.lastMessage.authorKind === 'system') {
                lastMessage = { authorKind: 'system', authorUserId: row.lastMessage.authorUserId, excerpt: '', notice: row.lastMessage.notice || null };
            } else if (row.lastMessage) {
                const opened = tryOpen(() => box.openContent(row.id, row.lastMessage.id, row.lastMessage.content), `message ${row.lastMessage.id} in chat ${row.id}`);
                lastMessage = {
                    authorKind: row.lastMessage.authorKind,
                    authorUserId: row.lastMessage.authorUserId,
                    excerpt: excerptOf(opened.text),
                };
            }
            return { ...presentChat(box, row, aiPolicy), lastMessage, unread: row.unread };
        });
        res.json({ chats, role: req.projectRole, aiPolicy });
    });

    // The agents a chat here may answer as: what every member may use.
    router.get('/:id/chat-agents', requireRole('viewer'), async (req, res) => {
        const project = await loadProject(req);
        res.json({ agents: await listChatAgents(project, { userId: userIdOf(req) }) });
    });

    router.post('/:id/chats', requireRole('editor'), postLimiter, validate({ body: S.CreateChatBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        if (project.kind === 'solution') {
            throw conflict('SOLUTION_HOLDS_NO_CHATS', 'A Studio Solution holds no chats. Start the chat in a project instead.');
        }
        const agentId = req.body.agentId || null;
        if (agentId && !(await resolveAgent({ agentId, userId }) && await isChatAgentAllowed(project, { agentId, userId }))) {
            throw badRequest('agent_unavailable', 'That agent is not available to everyone in this project.');
        }
        await assertModeAllowed(project, req.body.aiMode || 'mention');
        const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
        const box = await chatCrypto().forProject(project);

        const chatId = newId();
        // A title taken from the first message remembers that message, so
        // deleting, editing or erasing it takes its words out of the title too.
        const messageId = newId();
        const named = (req.body.title || '').trim();
        const derived = named ? '' : titleFromMessage(message);
        const title = named || derived || DEFAULT_TITLE;
        let chat = await store().createChat({
            id: chatId,
            projectId: project.id,
            title: box.sealTitle(chatId, title),
            titleFromMessageId: derived ? messageId : null,
            createdBy: userId,
            aiMode: req.body.aiMode || 'mention',
            agentId,
        });
        await audit(project.id, userId, 'chat.created', chat.id);
        await emit(project.id, chatEvent('chat.created', userId, chat.id));
        if (chat.aiMode === 'auto') await postAutoNotice(project, chat, userId);
        if (chat.aiMode === 'auto' || chat.aiMode === 'always') aiModeChanged(project);

        let posted = null;
        /** @type {{ status: string, reason?: string }} */
        let ai = { status: 'skipped', reason: 'no_message' };
        if (message) {
            let out;
            try {
                out = await postMessage(req, { project, chat, box, content: message, messageId, refs: req.body.refs || [] });
            } catch (err) {
                // The first message never landed (what follows the store cannot throw out of
                // postMessage): take the chat back, or it stays as an empty orphan and a
                // retry makes a second one.
                await rollBackNewChat(project, chat, userId);
                throw err;
            }
            posted = out.message;
            ai = out.ai;
            chat = (await store().getChat(project.id, chat.id)) || chat;
        }
        res.status(201).json({ chat: presentChat(box, chat, await aiPolicyFor(project)), message: posted, ai });
    });

    router.get('/:id/chats/:chatId', requireRole('viewer'), async (req, res) => {
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        const box = await chatCrypto().forProject(project);
        const aiPolicy = await aiPolicyFor(project);
        const aiState = await assistant().getStatus?.(chat.id);
        res.json({ chat: { ...presentChat(box, chat, aiPolicy), ...(aiState ? { aiState } : {}) }, role: req.projectRole, aiPolicy });
    });

    router.patch('/:id/chats/:chatId', requireRole('editor'), validate({ body: S.UpdateChatBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        const { title, aiMode, agentId, archived } = req.body;
        if (agentId && agentId !== chat.agentId
            && !(await resolveAgent({ agentId, userId }) && await isChatAgentAllowed(project, { agentId, userId }))) {
            throw badRequest('agent_unavailable', 'That agent is not available to everyone in this project.');
        }
        // A mode the chat already has stays usable for other edits even when
        // the organisation has since withdrawn it; only a change is checked.
        if (aiMode !== undefined && aiMode !== chat.aiMode) await assertModeAllowed(project, aiMode);
        const box = await chatCrypto().forProject(project);
        const patch = {};
        if (title !== undefined) patch.title = box.sealTitle(chat.id, title);
        if (aiMode !== undefined) patch.aiMode = aiMode;
        if (agentId !== undefined) patch.agentId = agentId;
        if (archived !== undefined) patch.archived = archived;
        const updated = await store().updateChat(project.id, chat.id, patch);
        if (!updated) throw notFound('chat_not_found', 'This chat does not exist in this project.');
        if (Object.keys(patch).length > 0) await emit(project.id, chatEvent('chat.updated', userId, chat.id));
        if (chat.aiMode !== 'auto' && updated.aiMode === 'auto') await postAutoNotice(project, updated, userId);
        if (chat.aiMode === 'auto' && (updated.aiMode !== 'auto' || updated.archived)) {
            await participation().cancelContainer('chat', chat.id);
        }
        if (updated.aiMode !== chat.aiMode) aiModeChanged(project);
        res.json({ chat: presentChat(box, updated, await aiPolicyFor(project)) });
    });

    router.delete('/:id/chats/:chatId', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        if (req.projectRole !== 'owner' && chat.createdBy !== userId) {
            throw forbidden('not_chat_creator', 'Only the person who started this chat or the project owner can delete it.');
        }
        if (!(await store().deleteChat(project.id, chat.id))) {
            throw notFound('chat_not_found', 'This chat does not exist in this project.');
        }
        await dropTaskLinks(project.id, 'chat', chat.id);
        await audit(project.id, userId, 'chat.deleted', chat.id);
        await emit(project.id, chatEvent('chat.deleted', userId, chat.id));
        if (chat.aiMode === 'auto') await participation().cancelContainer('chat', chat.id);
        if (chat.aiMode === 'auto' || chat.aiMode === 'always') aiModeChanged(project);
        res.json({ success: true });
    });

    // ── Messages ──────────────────────────────────────────────────────────

    router.get('/:id/chats/:chatId/messages', requireRole('viewer'), validate({ query: S.MessagesQuery }), async (req, res) => {
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        const box = await chatCrypto().forProject(project);
        const { after, before, limit } = req.query;
        const page = await store().listMessages(chat.id, { after: after ?? null, before: before ?? null, limit });
        const automatic = page.messages.filter((m) => m.authorKind === 'assistant' && AUTO_TRIGGERS.includes(m.aiTrigger)).map((m) => m.id);
        let feedback = new Map();
        if (automatic.length > 0) {
            try {
                feedback = await participationStore().feedbackFor(userIdOf(req), automatic);
            } catch (err) {
                // The "Not helpful" button then simply shows again.
                log.warn(`[ProjectChat] feedback of chat ${chat.id} unavailable: ${err && err.message}`);
            }
        }
        res.json({ messages: page.messages.map((m) => presentMessage(box, m, undefined, feedback)), hasMore: page.hasMore });
    });

    router.post('/:id/chats/:chatId/messages', requireRole('editor'), postLimiter, validate({ body: S.PostMessageBody }), async (req, res) => {
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        if (chat.archived) throw conflict('chat_archived', 'This chat is archived. Restore it before posting.');
        const box = await chatCrypto().forProject(project);
        const { content, clientMsgId, replyTo, threadId, refs, mentions, askAi, modelTier } = req.body;
        const out = await postMessage(req, {
            project, chat, box, content, clientMsgId: clientMsgId || null, replyTo: replyTo || null, threadId: threadId || null, refs: refs || [], mentions: mentions || [], askAi: askAi === true, modelTier: modelTier || null,
        });
        res.status(out.created ? 201 : 200).json({ message: out.message, ai: out.ai });
    });

    router.patch('/:id/chats/:chatId/messages/:messageId', requireRole('editor'), validate({ body: S.EditMessageBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        const message = await store().getMessage(chat.id, req.params.messageId);
        if (!message) throw notFound('message_not_found', 'This message does not exist in this chat.');
        if (message.authorKind !== 'user' || message.authorUserId !== userId) {
            throw forbidden('not_message_author', 'Only the author can edit this message.');
        }
        if (message.deletedAt) throw conflict('message_deleted', 'This message was deleted and can no longer be edited.');
        const box = await chatCrypto().forProject(project);
        const content = req.body.content;
        const updated = await store().editMessage(chat.id, message.id, userId, box.sealContent(chat.id, message.id, content));
        if (!updated) throw conflict('message_deleted', 'This message was deleted and can no longer be edited.');
        await emit(project.id, chatEvent('chat.message.updated', userId, chat.id, { messageId: updated.id, seq: updated.seq }));
        // A title taken from this message follows the new words, not the old ones.
        if (chat.titleFromMessageId === message.id
            && await store().retitleFromMessage(chat.id, message.id, box.sealTitle(chat.id, titleFromMessage(content) || DEFAULT_TITLE))) {
            await emit(project.id, chatEvent('chat.updated', userId, chat.id));
        }
        res.json({ message: presentMessage(box, updated, content) });
    });

    router.delete('/:id/chats/:chatId/messages/:messageId', requireRole('editor'), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        const message = await store().getMessage(chat.id, req.params.messageId);
        if (!message) throw notFound('message_not_found', 'This message does not exist in this chat.');
        const isAuthor = message.authorKind === 'user' && message.authorUserId === userId;
        if (!isAuthor && req.projectRole !== 'owner') {
            throw forbidden('not_message_author', 'Only the author or the project owner can delete this message.');
        }
        if (message.deletedAt) return res.json({ success: true });
        // A title taken from this message goes with it (the store resets it in the same step).
        const deleted = await store().softDeleteMessage(chat.id, message.id);
        if (deleted) await dropTaskLinks(project.id, 'thread', message.id);
        if (deleted) await emit(project.id, chatEvent('chat.message.deleted', userId, chat.id, { messageId: deleted.id, seq: deleted.seq }));
        if (deleted && deleted.titleReset) await emit(project.id, chatEvent('chat.updated', userId, chat.id));
        res.json({ success: true });
    });

    router.get('/:id/chats/:chatId/messages/:messageId/trace', requireRole('viewer'), async (req, res) => {
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        const message = await store().getMessage(chat.id, req.params.messageId);
        if (!message || message.deletedAt || !message.aiTrace) throw notFound('trace_not_found', 'There is nothing to show for this message.');
        const box = await chatCrypto().forProject(project);
        const opened = tryOpen(() => require('../../projects/chatTrace').openTrace(box, chat.id, message.id, message.aiTrace), `trace of message ${message.id}`);
        if (!opened.ok) throw notFound('trace_not_found', 'There is nothing to show for this message.');
        res.json({ trace: opened.text });
    });

    router.post('/:id/chats/:chatId/messages/:messageId/feedback', requireRole('editor'), validate({ body: S.FeedbackBody }), async (req, res) => {
        const userId = userIdOf(req);
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        const message = await store().getMessage(chat.id, req.params.messageId);
        if (!message) throw notFound('message_not_found', 'This message does not exist in this chat.');
        if (message.authorKind !== 'assistant' || !AUTO_TRIGGERS.includes(message.aiTrigger)) {
            throw conflict('not_automatic_answer', 'Only an answer the AI gave on its own can get this feedback.');
        }
        if (message.deletedAt) throw conflict('message_deleted', 'This message was deleted.');
        const helpful = req.body.helpful === true;
        const recorded = await participationStore().recordFeedback({
            messageId: message.id, userId, projectId: project.id, surface: 'chat', containerId: chat.id, helpful,
        });
        let pausedUntil = chat.autoPausedUntil || null;
        const alreadyPaused = pausedUntil && Date.parse(pausedUntil) > now();
        if (!helpful && !alreadyPaused && recorded.notHelpfulRecently >= BACKOFF_DISMISSALS) {
            const paused = await store().setAutoPausedUntil(chat.id, new Date(now() + PAUSE_MS));
            pausedUntil = paused ? paused.autoPausedUntil : pausedUntil;
            await participation().cancelContainer('chat', chat.id);
            await emit(project.id, chatEvent('chat.updated', userId, chat.id));
        }
        res.json({ ok: true, helpful, autoPausedUntil: pausedUntil });
    });

    router.post('/:id/chats/:chatId/read', requireRole('viewer'), validate({ body: S.ReadBody }), async (req, res) => {
        const project = await loadProject(req);
        const chat = await loadChat(project, req.params.chatId);
        await store().markRead(chat.id, userIdOf(req), req.body.seq);
        res.json({ ok: true });
    });

    return router;
}

const router = makeProjectChatsRouter();

module.exports = router;
module.exports.makeProjectChatsRouter = makeProjectChatsRouter;
module.exports.titleFromMessage = titleFromMessage;
