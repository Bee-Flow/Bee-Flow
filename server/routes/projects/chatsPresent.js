// @typecheck noImplicitAny
/**
 * Project team chats: the pure pieces of routes/projects/chats.js. Constants,
 * title and excerpt derivation, the effective AI mode, the feed event shape,
 * and how a chat and a message are presented (sealed fields opened, an
 * unreadable one flagged instead of failing the request). Split out of
 * chats.js; behaviour unchanged.
 */

'use strict';

const log = require('../../telemetry/log');

const DEFAULT_TITLE = 'New chat';
const AUTO_TRIGGERS = Object.freeze(['auto_quiet', 'auto_unanswered']);
/** "Not helpful" twice in a chat within the window pauses `auto` there for PAUSE_MS. */
const BACKOFF_DISMISSALS = 2;
const PAUSE_MS = 24 * 60 * 60_000;
const TITLE_FROM_MESSAGE = 60;
const EXCERPT_CHARS = 140;

/** "The first ~60 characters of the message", on one line. @param {string} message */
function titleFromMessage(message) {
    const line = String(message || '').replace(/\s+/g, ' ').trim();
    if (!line) return '';
    return line.length > TITLE_FROM_MESSAGE ? `${line.slice(0, TITLE_FROM_MESSAGE).trimEnd()}…` : line;
}

/** @param {string} text */
function excerptOf(text) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS).trimEnd()}…` : line;
}

/**
 * The mode a chat acts in right now. A mode the organisation withdrew after
 * the chat chose it acts as `mention`: an explicit ask is still answered,
 * nothing else reaches the model. The chat keeps its stored mode, so it comes
 * back when the organisation allows it again.
 *
 * @param {string} aiMode
 * @param {{ autoAllowed: boolean, alwaysAllowed: boolean }} allowed
 */
function effectiveAiMode(aiMode, allowed) {
    if (aiMode === 'always' && !allowed.alwaysAllowed) return 'mention';
    if (aiMode === 'auto' && !allowed.autoAllowed) return 'mention';
    return aiMode;
}

/**
 * @param {string} kind
 * @param {string} actorId
 * @param {string} chatId
 * @param {Record<string, unknown>} [payload]
 */
const chatEvent = (kind, actorId, chatId, payload = {}) => ({
    kind, actorId, targetType: 'project_chat', targetId: chatId, payload: { chatId, ...payload },
});

/**
 * Open a sealed field, or report it unreadable without taking the request down.
 * @template [T=string]
 * @param {() => T} open
 * @param {string} what
 * @returns {{ text: T | '', ok: boolean }}
 */
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
    /** @type {Record<string, any>} */
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

module.exports = {
    DEFAULT_TITLE,
    AUTO_TRIGGERS,
    BACKOFF_DISMISSALS,
    PAUSE_MS,
    titleFromMessage,
    excerptOf,
    effectiveAiMode,
    chatEvent,
    tryOpen,
    presentChat,
    presentMessage,
};
