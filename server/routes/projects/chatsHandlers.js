// @typecheck
/**
 * Project team chats: the handler bodies of the chat routes (list, agents,
 * start, read, update, delete). The route table stays in chats.js; each
 * handler takes the shared context (./chatsContext.js) first. Split out of
 * chats.js; behaviour unchanged.
 */

'use strict';

const { badRequest, forbidden, notFound, conflict } = require('../../core/http/errors');
const { DEFAULT_TITLE, titleFromMessage, excerptOf, chatEvent, tryOpen, presentChat } = require('./chatsPresent');
const { postMessage } = require('./chatsPost');

async function listChats(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const rows = await ctx.store().listChats(project.id, { userId: ctx.userIdOf(req), archived: req.query.archived === '1' });
    const box = await ctx.chatCrypto().forProject(project);
    const aiPolicy = await ctx.aiPolicyFor(project);
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
}

// The agents a chat here may answer as: what every member may use.
async function listAgents(ctx, req, res) {
    const project = await ctx.loadProject(req);
    res.json({ agents: await ctx.listChatAgents(project, { userId: ctx.userIdOf(req) }) });
}

/** An agent the caller names must be usable by every member of the project. */
async function assertAgentAllowed(ctx, project, agentId, userId) {
    if (!(await ctx.resolveAgent({ agentId, userId }) && await ctx.isChatAgentAllowed(project, { agentId, userId }))) {
        throw badRequest('agent_unavailable', 'That agent is not available to everyone in this project.');
    }
}

async function createChat(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    if (project.kind === 'solution') {
        throw conflict('SOLUTION_HOLDS_NO_CHATS', 'A Studio Solution holds no chats. Start the chat in a project instead.');
    }
    const agentId = req.body.agentId || null;
    if (agentId) await assertAgentAllowed(ctx, project, agentId, userId);
    await ctx.assertModeAllowed(project, req.body.aiMode || 'mention');
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const box = await ctx.chatCrypto().forProject(project);

    const chatId = ctx.newId();
    // A title taken from the first message remembers that message, so
    // deleting, editing or erasing it takes its words out of the title too.
    const messageId = ctx.newId();
    const named = (req.body.title || '').trim();
    const derived = named ? '' : titleFromMessage(message);
    const title = named || derived || DEFAULT_TITLE;
    let chat = await ctx.store().createChat({
        id: chatId,
        projectId: project.id,
        title: box.sealTitle(chatId, title),
        titleFromMessageId: derived ? messageId : null,
        createdBy: userId,
        aiMode: req.body.aiMode || 'mention',
        agentId,
    });
    await ctx.audit(project.id, userId, 'chat.created', chat.id);
    await ctx.emit(project.id, chatEvent('chat.created', userId, chat.id));
    if (chat.aiMode === 'auto') await ctx.postAutoNotice(project, chat, userId);
    if (chat.aiMode === 'auto' || chat.aiMode === 'always') ctx.aiModeChanged(project);

    let posted = null;
    /** @type {{ status: string, reason?: string }} */
    let ai = { status: 'skipped', reason: 'no_message' };
    if (message) {
        let out;
        try {
            out = await postMessage(ctx, req, { project, chat, box, content: message, messageId, refs: req.body.refs || [] });
        } catch (err) {
            // The first message never landed (what follows the store cannot throw out of
            // postMessage): take the chat back, or it stays as an empty orphan and a
            // retry makes a second one.
            await ctx.rollBackNewChat(project, chat, userId);
            throw err;
        }
        posted = out.message;
        ai = out.ai;
        chat = (await ctx.store().getChat(project.id, chat.id)) || chat;
    }
    res.status(201).json({ chat: presentChat(box, chat, await ctx.aiPolicyFor(project)), message: posted, ai });
}

async function getChat(ctx, req, res) {
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    const box = await ctx.chatCrypto().forProject(project);
    const aiPolicy = await ctx.aiPolicyFor(project);
    const aiState = await ctx.assistant().getStatus?.(chat.id);
    res.json({ chat: { ...presentChat(box, chat, aiPolicy), ...(aiState ? { aiState } : {}) }, role: req.projectRole, aiPolicy });
}

async function updateChat(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    const { title, aiMode, agentId, archived } = req.body;
    if (agentId && agentId !== chat.agentId) await assertAgentAllowed(ctx, project, agentId, userId);
    // A mode the chat already has stays usable for other edits even when
    // the organisation has since withdrawn it; only a change is checked.
    if (aiMode !== undefined && aiMode !== chat.aiMode) await ctx.assertModeAllowed(project, aiMode);
    const box = await ctx.chatCrypto().forProject(project);
    const patch = {};
    if (title !== undefined) patch.title = box.sealTitle(chat.id, title);
    if (aiMode !== undefined) patch.aiMode = aiMode;
    if (agentId !== undefined) patch.agentId = agentId;
    if (archived !== undefined) patch.archived = archived;
    const updated = await ctx.store().updateChat(project.id, chat.id, patch);
    if (!updated) throw notFound('chat_not_found', 'This chat does not exist in this project.');
    if (Object.keys(patch).length > 0) await ctx.emit(project.id, chatEvent('chat.updated', userId, chat.id));
    if (chat.aiMode !== 'auto' && updated.aiMode === 'auto') await ctx.postAutoNotice(project, updated, userId);
    if (chat.aiMode === 'auto' && (updated.aiMode !== 'auto' || updated.archived)) {
        await ctx.participation().cancelContainer('chat', chat.id);
    }
    if (updated.aiMode !== chat.aiMode) ctx.aiModeChanged(project);
    res.json({ chat: presentChat(box, updated, await ctx.aiPolicyFor(project)) });
}

async function deleteChat(ctx, req, res) {
    const userId = ctx.userIdOf(req);
    const project = await ctx.loadProject(req);
    const chat = await ctx.loadChat(project, req.params.chatId);
    if (req.projectRole !== 'owner' && chat.createdBy !== userId) {
        throw forbidden('not_chat_creator', 'Only the person who started this chat or the project owner can delete it.');
    }
    if (!(await ctx.store().deleteChat(project.id, chat.id))) {
        throw notFound('chat_not_found', 'This chat does not exist in this project.');
    }
    await ctx.dropTaskLinks(project.id, 'chat', chat.id);
    await ctx.audit(project.id, userId, 'chat.deleted', chat.id);
    await ctx.emit(project.id, chatEvent('chat.deleted', userId, chat.id));
    if (chat.aiMode === 'auto') await ctx.participation().cancelContainer('chat', chat.id);
    if (chat.aiMode === 'auto' || chat.aiMode === 'always') ctx.aiModeChanged(project);
    res.json({ success: true });
}

module.exports = { listChats, listAgents, createChat, getChat, updateChat, deleteChat };
