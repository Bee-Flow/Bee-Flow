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

const express = require('express');
const { validate } = require('../../core/http/validate');
const S = require('./chatSchemas');
const { titleFromMessage } = require('./chatsPresent');
const { makeChatsContext } = require('./chatsContext');
const C = require('./chatsHandlers');
const M = require('./chatMessageHandlers');

/**
 * The route table. Handler bodies live in chatsHandlers.js (chats) and
 * chatMessageHandlers.js (messages), posting in chatsPost.js, the shared
 * context in chatsContext.js and the presentation in chatsPresent.js.
 *
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
 * @param {object}   [deps.collabNotifier]      { chatMentioned } (projects/collabNotify): the bell for a mention
 * @param {Function} [deps.signalProjectChanged]  (project, reason) => void (routes/projects/complianceSignal)
 * @param {Function} [deps.now]
 * @param {Function} [deps.newId]
 */
function makeProjectChatsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const ctx = makeChatsContext(deps);
    const { requireRole, postLimiter } = ctx;
    /** @param {(ctx: any, req: any, res: any) => any} handler */
    const h = (handler) => (req, res) => handler(ctx, req, res);

    // ── Chats ─────────────────────────────────────────────────────────────

    router.get('/:id/chats', requireRole('viewer'), validate({ query: S.ListChatsQuery }), h(C.listChats));
    // The agents a chat here may answer as: what every member may use.
    router.get('/:id/chat-agents', requireRole('viewer'), h(C.listAgents));
    router.post('/:id/chats', requireRole('editor'), postLimiter, validate({ body: S.CreateChatBody }), h(C.createChat));
    router.get('/:id/chats/:chatId', requireRole('viewer'), h(C.getChat));
    router.patch('/:id/chats/:chatId', requireRole('editor'), validate({ body: S.UpdateChatBody }), h(C.updateChat));
    router.delete('/:id/chats/:chatId', requireRole('editor'), h(C.deleteChat));

    // ── Messages ──────────────────────────────────────────────────────────

    router.get('/:id/chats/:chatId/messages', requireRole('viewer'), validate({ query: S.MessagesQuery }), h(M.listMessages));
    router.post('/:id/chats/:chatId/messages', requireRole('editor'), postLimiter, validate({ body: S.PostMessageBody }), h(M.postChatMessage));
    router.patch('/:id/chats/:chatId/messages/:messageId', requireRole('editor'), validate({ body: S.EditMessageBody }), h(M.editMessage));
    router.delete('/:id/chats/:chatId/messages/:messageId', requireRole('editor'), h(M.deleteMessage));
    router.get('/:id/chats/:chatId/messages/:messageId/trace', requireRole('viewer'), h(M.messageTrace));
    router.post('/:id/chats/:chatId/messages/:messageId/feedback', requireRole('editor'), validate({ body: S.FeedbackBody }), h(M.messageFeedback));
    router.post('/:id/chats/:chatId/read', requireRole('viewer'), validate({ body: S.ReadBody }), h(M.markRead));

    return router;
}

const router = makeProjectChatsRouter();

module.exports = router;
module.exports.makeProjectChatsRouter = makeProjectChatsRouter;
module.exports.titleFromMessage = titleFromMessage;
