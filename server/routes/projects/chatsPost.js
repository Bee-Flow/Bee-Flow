// @typecheck noImplicitAny
/**
 * Project team chats: storing one human message, announcing it, and asking
 * the assistant when the chat's rule says so. Shared by "start a chat with a
 * first message" and "post a message". Split out of chats.js; behaviour
 * unchanged. `ctx` is the context from ./chatsContext.js.
 */

'use strict';

const log = require('../../telemetry/log');
const { badRequest, notFound, conflict } = require('../../core/http/errors');
const { effectiveAiMode, chatEvent, presentMessage } = require('./chatsPresent');

/**
 * @typedef {ReturnType<typeof import('./chatsContext').makeChatsContext>} Ctx
 * @typedef {import('./chatsContext').ProjectRow} ProjectRow
 * @typedef {import('./chatsContext').ChatRow} ChatRow
 * @typedef {import('./chatsContext').StoredPost['message']} StoredMessage
 * @typedef {Awaited<ReturnType<typeof import('../../projects/chatCrypto').forProject>>} Box
 * @typedef {import('express').Request} SessionReq
 */

/**
 * Store the sealed message; the store's refusals become 400/409 answers.
 * @param {Ctx} ctx
 * @param {{ messageId: string, project: ProjectRow, chat: ChatRow, userId: string, box: Box, content: string, kept: string[],
 *   replyTo: string | null, threadId: string | null, keptRefs: Array<{ kind: string, id: string }>, clientMsgId: string | null }} opts
 */
async function appendUserMessage(ctx, { messageId, project, chat, userId, box, content, kept, replyTo, threadId, keptRefs, clientMsgId }) {
    try {
        // `{ stale: true }` comes only with `unlessHumanAfterSeq`, which a member's post never sends.
        return /** @type {import('./chatsContext').StoredPost | null} */ (await ctx.store().appendMessage({
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
        }));
    } catch (err) {
        if (err?.code === 'THREAD_NOT_FOUND') throw badRequest('thread_not_found', 'threadId must be a message in this chat that is not itself a reply in a thread.');
        if (err?.code === 'REPLY_TARGET_NOT_FOUND') throw badRequest('reply_target_not_found', 'replyTo must be a message in this chat.');
        if (err?.code === 'CLIENT_MSG_ID_TAKEN') throw conflict('client_msg_id_taken', 'This clientMsgId was already used for another message in this chat. Send a new id.');
        throw err;
    }
}

/**
 * The feed events for a stored post, and the bell for whoever it mentions.
 * @param {Ctx} ctx
 * @param {{ project: ProjectRow, chat: ChatRow, userId: string, stored: StoredMessage, kept: string[] }} opts
 */
async function announcePost(ctx, { project, chat, userId, stored, kept }) {
    await ctx.emit(project.id, chatEvent('chat.message.created', userId, chat.id, { messageId: stored.id, seq: stored.seq, authorKind: 'user' }));
    if (kept.length === 0) return;
    await ctx.emit(project.id, chatEvent('chat.mention', userId, chat.id, { messageId: stored.id, mentionedUserIds: kept }));
    // Best effort: the bell carries the project and the writer's name, never the message.
    try { await ctx.collabNotifier().chatMentioned({ project, actorId: userId, mentionedUserIds: kept, chatId: chat.id }); } catch (err) {
        log.warn(`[ProjectChat] mention not notified: ${err && /** @type {Error} */ (err).message}`);
    }
}

/**
 * Decide whether the AI answers this post, and ask it when so.
 * @param {Ctx} ctx
 * @param {SessionReq} req
 * @param {{ project: ProjectRow, chat: ChatRow, userId: string, stored: StoredMessage, content: string, askAi: boolean, threadId: string | null, modelTier: string | null }} opts
 * @returns {Promise<{ status: string, reason?: string }>}
 */
async function askAssistantFor(ctx, req, { project, chat, userId, stored, content, askAi, threadId, modelTier }) {
    const { decideAiTrigger, mentionsAssistant } = require('../../projects/chatAssistant');
    // `always` sends every post to the model, so it is re-checked against the
    // organisation on every post: a withdrawn `always` acts as `mention`.
    // (`auto` is re-checked by the participation engine itself.)
    const aiMode = chat.aiMode === 'always' ? effectiveAiMode(chat.aiMode, await ctx.aiPolicyFor(project)) : chat.aiMode;
    /** @type {string | null} */
    let agentName = null;
    // The agent's name only matters for "@<agent name>" in mention and auto
    // mode, and only an agent the poster may use can be addressed by them.
    if ((aiMode === 'mention' || aiMode === 'auto') && !askAi && chat.agentId && content.includes('@') && !mentionsAssistant(content)) {
        try {
            agentName = (await ctx.resolveAgent({ agentId: chat.agentId, userId }))?.name || null;
        } catch (err) {
            log.warn(`[ProjectChat] agent lookup failed for chat ${chat.id}: ${err && /** @type {Error} */ (err).message}`);
        }
    }
    const decision = decideAiTrigger({ aiMode, content, askAi, agentName });
    const notice = { containerId: chat.id, messageId: stored.id, authorUserId: userId, projectId: project.id };
    if (decision.trigger === false && decision.reason === 'auto_pending' && threadId) {
        // The AI joins the main conversation on its own, not a thread; asked outright it answers there too.
        return { status: 'skipped', reason: 'auto' };
    }
    if (decision.trigger === false && decision.reason === 'auto_pending') {
        // The engine decides later, quietly; the poster is told nothing more.
        const { orgId, limitOrgId } = await ctx.resolveOrgs(req);
        ctx.tellParticipation({ ...notice, orgId, limitOrgId });
        return { status: 'skipped', reason: 'auto' };
    }
    if (decision.trigger === false) {
        return { status: 'skipped', reason: aiMode !== chat.aiMode ? 'ai_mode_not_allowed' : decision.reason };
    }
    const { orgId, limitOrgId } = await ctx.resolveOrgs(req);
    // Asked outright in an auto chat: whatever the engine had queued is moot.
    if (chat.aiMode === 'auto') ctx.tellParticipation({ ...notice, orgId, limitOrgId, explicit: true });
    const reply = await ctx.assistant().requestReply({
        project, chat, trigger: stored, triggerText: content, userId, orgId, limitOrgId, session: req.session, aiTrigger: decision.kind, modelTier,
    });
    return reply.reason ? { status: reply.status, reason: reply.reason } : { status: reply.status };
}

/**
 * Store one human message, announce it, and ask the assistant when the
 * chat's rule says so.
 * @param {Ctx} ctx
 * @param {SessionReq} req
 * @param {{ project: ProjectRow, chat: ChatRow, box: Box, content: string, clientMsgId?: string | null, replyTo?: string | null, threadId?: string | null,
 *   refs?: Array<{ kind: string, id: string }>, mentions?: unknown[], askAi?: boolean, modelTier?: string | null, messageId?: string }} opts
 */
async function postMessage(ctx, req, { project, chat, box, content, clientMsgId = null, replyTo = null, threadId = null, refs = [], mentions = [], askAi = false, modelTier = null, messageId = ctx.newId() }) {
    const userId = ctx.userIdOf(req);
    const kept = await ctx.memberMentions(project.id, mentions);
    const keptRefs = await ctx.checkedRefs(project.id, refs);
    const result = await appendUserMessage(ctx, { messageId, project, chat, userId, box, content, kept, replyTo, threadId, keptRefs, clientMsgId });
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
        await announcePost(ctx, { project, chat, userId, stored, kept });
        ai = await askAssistantFor(ctx, req, { project, chat, userId, stored, content, askAi, threadId, modelTier });
    } catch (err) {
        log.warn(`[ProjectChat] message ${stored.id} in chat ${chat.id} stored, but the AI step failed: ${err && /** @type {Error} */ (err).message}`);
        ai = { status: 'skipped', reason: 'unavailable' };
    }
    return { created: true, message: presentMessage(box, stored, content), ai };
}

module.exports = { postMessage };
