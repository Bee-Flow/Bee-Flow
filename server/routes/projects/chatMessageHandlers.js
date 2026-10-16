// @typecheck
/**
 * Project team chats: the handler bodies of the message routes (list, post,
 * edit, delete, trace, feedback, read marker). The route table stays in
 * chats.js; each handler takes the shared context (./chatsContext.js)
 * first. Split out of chats.js; behaviour unchanged.
 */

'use strict';

const log = require('../../telemetry/log');
const { forbidden, notFound, conflict } = require('../../core/http/errors');
const {
    DEFAULT_TITLE, AUTO_TRIGGERS, BACKOFF_DISMISSALS, PAUSE_MS, titleFromMessage, chatEvent, tryOpen, presentMessage,
} = require('./chatsPresent');
const { postMessage } = require('./chatsPost');

/** A message of this chat, or a 404. */
async function loadMessage(ctx, chat, messageId) {
    const message = await ctx.store().getMessage(chat.id, messageId);
    if (!message) throw notFound('message_not_found', 'This message does not exist in this chat.');
    return message;
}

async function listMessages(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    const box = await ctx.chatCrypto().forProject(project);
    const { after, before, limit } = req.query;
    const page = await ctx.store().listMessages(chat.id, { after: after ?? null, before: before ?? null, limit });
    const automatic = page.messages.filter((m) => m.authorKind === 'assistant' && AUTO_TRIGGERS.includes(m.aiTrigger)).map((m) => m.id);
    let feedback = new Map();
    if (automatic.length > 0) {
        try {
            feedback = await ctx.participationStore().feedbackFor(ctx.userIdOf(req), automatic);
        } catch (err) {
            // The "Not helpful" button then simply shows again.
            log.warn(`[ProjectChat] feedback of chat ${chat.id} unavailable: ${err && err.message}`);
        }
    }
    res.json({ messages: page.messages.map((m) => presentMessage(box, m, undefined, feedback)), hasMore: page.hasMore });
}

async function postChatMessage(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    if (chat.archived) throw conflict('chat_archived', 'This chat is archived. Restore it before posting.');
    const box = await ctx.chatCrypto().forProject(project);
    const { content, clientMsgId, replyTo, threadId, refs, mentions, askAi, modelTier } = req.body;
    const out = await postMessage(ctx, req, {
        project, chat, box, content, clientMsgId: clientMsgId || null, replyTo: replyTo || null, threadId: threadId || null, refs: refs || [], mentions: mentions || [], askAi: askAi === true, modelTier: modelTier || null,
    });
    res.status(out.created ? 201 : 200).json({ message: out.message, ai: out.ai });
}

async function editMessage(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    const message = await loadMessage(ctx, chat, req.params.messageId);
    if (message.authorKind !== 'user' || message.authorUserId !== userId) {
        throw forbidden('not_message_author', 'Only the author can edit this message.');
    }
    if (message.deletedAt) throw conflict('message_deleted', 'This message was deleted and can no longer be edited.');
    const box = await ctx.chatCrypto().forProject(project);
    const content = req.body.content;
    const updated = await ctx.store().editMessage(chat.id, message.id, userId, box.sealContent(chat.id, message.id, content));
    if (!updated) throw conflict('message_deleted', 'This message was deleted and can no longer be edited.');
    await ctx.emit(project.id, chatEvent('chat.message.updated', userId, chat.id, { messageId: updated.id, seq: updated.seq }));
    // A title taken from this message follows the new words, not the old ones.
    if (chat.titleFromMessageId === message.id
        && await ctx.store().retitleFromMessage(chat.id, message.id, box.sealTitle(chat.id, titleFromMessage(content) || DEFAULT_TITLE))) {
        await ctx.emit(project.id, chatEvent('chat.updated', userId, chat.id));
    }
    res.json({ message: presentMessage(box, updated, content) });
}

async function deleteMessage(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    const message = await loadMessage(ctx, chat, req.params.messageId);
    const isAuthor = message.authorKind === 'user' && message.authorUserId === userId;
    if (!isAuthor && req.projectRole !== 'owner') {
        throw forbidden('not_message_author', 'Only the author or the project owner can delete this message.');
    }
    if (message.deletedAt) return res.json({ success: true });
    // A title taken from this message goes with it (the store resets it in the same step).
    const deleted = await ctx.store().softDeleteMessage(chat.id, message.id);
    if (deleted) await ctx.dropTaskLinks(project.id, 'thread', message.id);
    if (deleted) await ctx.emit(project.id, chatEvent('chat.message.deleted', userId, chat.id, { messageId: deleted.id, seq: deleted.seq }));
    if (deleted && deleted.titleReset) await ctx.emit(project.id, chatEvent('chat.updated', userId, chat.id));
    res.json({ success: true });
}

async function messageTrace(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    const message = await ctx.store().getMessage(chat.id, req.params.messageId);
    if (!message || message.deletedAt || !message.aiTrace) throw notFound('trace_not_found', 'There is nothing to show for this message.');
    const box = await ctx.chatCrypto().forProject(project);
    const opened = tryOpen(() => require('../../projects/chatTrace').openTrace(box, chat.id, message.id, message.aiTrace), `trace of message ${message.id}`);
    if (!opened.ok) throw notFound('trace_not_found', 'There is nothing to show for this message.');
    res.json({ trace: opened.text });
}

async function messageFeedback(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    const message = await loadMessage(ctx, chat, req.params.messageId);
    if (message.authorKind !== 'assistant' || !AUTO_TRIGGERS.includes(message.aiTrigger)) {
        throw conflict('not_automatic_answer', 'Only an answer the AI gave on its own can get this feedback.');
    }
    if (message.deletedAt) throw conflict('message_deleted', 'This message was deleted.');
    const helpful = req.body.helpful === true;
    const recorded = await ctx.participationStore().recordFeedback({
        messageId: message.id, userId, projectId: project.id, surface: 'chat', containerId: chat.id, helpful,
    });
    let pausedUntil = chat.autoPausedUntil || null;
    const alreadyPaused = pausedUntil && Date.parse(pausedUntil) > ctx.now();
    if (!helpful && !alreadyPaused && recorded.notHelpfulRecently >= BACKOFF_DISMISSALS) {
        const paused = await ctx.store().setAutoPausedUntil(chat.id, new Date(ctx.now() + PAUSE_MS));
        pausedUntil = paused ? paused.autoPausedUntil : pausedUntil;
        await ctx.participation().cancelContainer('chat', chat.id);
        await ctx.emit(project.id, chatEvent('chat.updated', userId, chat.id));
    }
    res.json({ ok: true, helpful, autoPausedUntil: pausedUntil });
}

async function markRead(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    await ctx.store().markRead(chat.id, ctx.userIdOf(req), req.body.seq);
    res.json({ ok: true });
}

module.exports = { listMessages, postChatMessage, editMessage, deleteMessage, messageTrace, messageFeedback, markRead };
