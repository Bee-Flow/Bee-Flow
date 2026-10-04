// @typecheck
/**
 * The team chat as a participation surface (see engine.js for the contract).
 *
 * loadContext opens the chat's recent messages with the project key
 * (chatCrypto) for the engine's rules and the gate. It starts from a bare
 * chat id because the job has no request: it authorises nothing and hands
 * nothing to a person — the watch was only ever created from a member's post
 * that already passed the route's role gate, and every answer is written into
 * that same chat.
 *
 * answer() goes through chatAssistant.requestReply with an `auto_*` trigger,
 * so an automatic answer gets the same turn lock, persona rule, Privacy
 * Shield, sealing and feed event as an asked-for one, plus the automatic
 * rules (short prompt, [[SKIP]], stale suppression, knowledge every member
 * may read, silence on failure).
 */

'use strict';

const log = require('../../telemetry/log');

const CONTEXT_MESSAGES = 30;

/**
 * @param {object} [deps]
 * @param {object}   [deps.store]         stores/projectChatStore surface
 * @param {Function} [deps.getProject]    (id) => project row
 * @param {Function} [deps.getProjectShares] (projectId) => share rows
 * @param {object}   [deps.chatCrypto]    { forProject(project) }
 * @param {object}   [deps.assistant]     { requestReply } (makeChatAssistant())
 */
function makeChatSurface(deps = {}) {
    const store = () => deps.store || require('../../stores/projectChatStore');
    const getProject = deps.getProject || ((id) => require('../../stores/projectStore').getProject(id));
    const getProjectShares = deps.getProjectShares || ((id) => require('../../stores/projectStore').getProjectShares(id));
    const chatCrypto = () => deps.chatCrypto || require('../chatCrypto');
    let sharedAssistant = null;
    const assistant = () => deps.assistant
        || (sharedAssistant || (sharedAssistant = require('../chatAssistant').makeChatAssistant()));
    const { mentionsAssistant } = require('../chatAssistant');

    /** @param {string} chatId */
    async function loadContext(chatId) {
        const chat = await store().getChatById(chatId);
        if (!chat) return null;
        const project = await getProject(chat.projectId);
        if (!project) return null;
        const box = await chatCrypto().forProject(project);
        // The main conversation only: a thread is its own conversation, and its
        // replies must not read as later turns (or fill the window) here.
        const { messages } = await store().listMessages(chat.id, { limit: CONTEXT_MESSAGES, threadId: null });
        const opened = [];
        for (const m of messages) {
            if (m.deletedAt || m.authorKind === 'system' || m.threadId) continue;
            let text;
            try {
                text = box.openContent(chat.id, m.id, m.content);
            } catch (err) {
                log.warn(`[AiParticipation] message ${m.id} in chat ${chat.id} could not be decrypted: ${err && err.code}`);
                continue;
            }
            opened.push({
                id: m.id,
                seq: m.seq,
                authorKind: m.authorKind,
                authorUserId: m.authorUserId,
                text,
                createdAt: m.createdAt,
                replyTo: m.replyTo,
                mentionsAi: m.authorKind === 'user' && mentionsAssistant(text),
                mentionsHuman: Array.isArray(m.mentions) && m.mentions.length > 0,
            });
        }
        let memberCount = null;
        try {
            // A hint for the gate, not a count to trust: a group counts once.
            memberCount = 1 + ((await getProjectShares(project.id)) || []).length;
        } catch (_) { memberCount = null; }
        return {
            projectId: project.id,
            orgId: project.organizationId || null,
            aiMode: chat.aiMode,
            closed: !!chat.archived,
            autoPausedUntil: chat.autoPausedUntil || null,
            messages: opened,
            memberCount,
            readByOthers: (message) => store().countReadersAtLeast(chat.id, message.seq, message.authorUserId),
            project,
            chat,
        };
    }

    /**
     * @param {{ ctx: any, watch: any, trigger: any, aiTrigger: string, reasonCode: string, gateLastSeq: number }} job
     */
    async function answer({ ctx, watch, trigger, aiTrigger, reasonCode, gateLastSeq }) {
        const reply = await assistant().requestReply({
            project: ctx.project,
            chat: ctx.chat,
            trigger: { id: trigger.id },
            triggerText: trigger.text,
            userId: watch.authorUserId,
            orgId: watch.orgId,
            limitOrgId: watch.limitOrgId,
            session: null,
            aiTrigger,
            reasonCode,
            gateLastSeq,
        });
        if (reply.status !== 'queued' || !reply.done) return { status: reply.status === 'busy' ? 'busy' : reply.reason || 'skipped' };
        return reply.done;
    }

    return { lockType: 'project_chat', loadContext, answer };
}

module.exports = { makeChatSurface };
