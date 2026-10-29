// @typecheck
/**
 * Project team chats: the context every chat handler shares. The injected
 * dependencies with their lazily required defaults (so requiring chats.js
 * loads no store), plus the small helpers built on them: the organisation's
 * AI policy, project and chat lookups, the audit trail, mentions and tagged
 * refs, the auto notice and the rollback of a half-made chat. Split out of
 * chats.js; behaviour unchanged. The `deps` contract is documented on
 * makeProjectChatsRouter.
 */

'use strict';

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { projectAccessDeps } = require('./roleGate');
const { badRequest, forbidden, notFound } = require('../../core/http/errors');
const { chatEvent } = require('./chatsPresent');
const { fallback } = require('../../utils/bestEffort');

/** The dependencies, each defaulting to the real module, required on first use. */
function resolveChatsDeps(deps) {
    // The shared gate, bound on first use so requiring chats.js (the default
    // instance) loads no store. Same name as the gate itself, which is what
    // the project route-table baseline records.
    const { requireRole, getProjectRole, getProject } = projectAccessDeps(deps);
    let defaultCollabNotifier = null;
    let defaultAssistant = null;
    let defaultLimiter = null;
    return {
        requireRole, getProjectRole, getProject,
        // A chat's AI mode is something the project compliance checks read.
        aiModeChanged: (project) => (deps.signalProjectChanged || require('./complianceSignal').signalProjectChanged)(project, 'ai_mode'),
        store: () => deps.store || require('../../stores/projectChatStore'),
        taskStore: () => deps.taskStore || require('../../stores/projectTaskStore'),
        collabNotifier: () => deps.collabNotifier
            || (defaultCollabNotifier || (defaultCollabNotifier = require('../../projects/collabNotify').makeCollabNotifier())),
        chatCrypto: () => deps.chatCrypto || require('../../projects/chatCrypto'),
        assistant: () => deps.assistant
            || (defaultAssistant || (defaultAssistant = require('../../projects/chatAssistant').makeChatAssistant())),
        resolveAgent: deps.resolveAgent
            || ((/** @type {{ agentId: string; userId: string; }} */ args) => require('../../projects/chatAssistant').resolveUsableAgent(args)),
        isChatAgentAllowed: deps.isChatAgentAllowed
            || ((/** @type {{ id: string; }} */ project, /** @type {{ agentId: string; userId: string; }} */ args) => require('../../projects/chatAssistant').isChatAgentAllowed(project, args)),
        listChatAgents: deps.listChatAgents
            || ((/** @type {{ id: string; }} */ project, /** @type {{ userId: string; }} */ args) => require('../../projects/chatAssistant').listChatAgents(project, args)),
        // The ids of what is filed in the project, per kind, for validating `refs`.
        filedIds: deps.filedIds || (async (projectId, kind) => {
            const entry = require('../../projects/membership').getKind(kind);
            const rows = entry ? await entry.list(projectId) : [];
            return new Set((rows || []).map((r) => r.id));
        }),
        resolveOrgs: deps.resolveOrgs || (async (req) => {
            const userId = req.session.user.id;
            const orgId = await require('../../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId });
            const limitOrgId = await require('../../core/entitlements/limits').resolveOrgId(req);
            return { orgId: orgId || null, limitOrgId: limitOrgId || null };
        }),
        emit: deps.emit
            || ((/** @type {string} */ projectId, /** @type {{ kind?: string; actorId?: string | null; targetType?: string | null; targetId?: string | null; payload?: object; }} */ event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectChat' })),
        logActivity: deps.logActivity
            || ((projectId, actorId, action, details) => require('../../stores/projectStore').logActivity(projectId, actorId, action, details)),
        // One budget for starting chats and posting, per member: generous for
        // a conversation, a wall for a runaway client.
        postLimiter: deps.postLimiter || function rateLimitMiddleware(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) {
            if (!defaultLimiter) {
                defaultLimiter = require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 120, name: 'project-chat-post' });
            }
            return defaultLimiter(req, res, next);
        },
        participation: () => deps.participation || require('../../projects/participation'),
        policy: () => deps.policy || require('../../projects/participation/policy').defaultPolicy(),
        participationStore: () => deps.participationStore || require('../../stores/projectAiParticipationStore'),
        now: deps.now || (() => Date.now()),
        newId: deps.newId || (() => crypto.randomUUID()),
        userIdOf: (req) => req.session.user.id,
    };
}

/** The helpers on top of the dependencies; returns the full handler context. */
function makeChatsContext(deps = {}) {
    const ctx = resolveChatsDeps(deps);
    const { store, taskStore, emit, participation, newId } = ctx;

    /** What a task linked to (a chat, or the thread of a message) is gone: the link goes, the task stays. Best effort. */
    async function dropTaskLinks(projectId, kind, id) {
        try {
            await taskStore().dropLinksTo(projectId, kind, id);
        } catch (err) {
            log.warn(`[ProjectChat] task links to ${kind} ${id} not dropped: ${err && /** @type {Error} */ (err).message}`);
        }
    }

    /** What the organisation lets a chat choose. Never throws (the policy narrows on failure). */
    async function aiPolicyFor(project) {
        const p = await ctx.policy().resolveOrgPolicy(project.organizationId || null);
        return { autoAllowed: !!p.autoAllowed, alwaysAllowed: !!p.alwaysAllowed };
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
            log.warn(`[ProjectChat] auto notice not posted in chat ${chat.id}: ${err && /** @type {Error} */ (err).message}`);
        }
    }

    /** Undo a chat that was created together with a first message that failed to store. */
    async function rollBackNewChat(project, chat, userId) {
        try {
            if (!(await store().deleteChat(project.id, chat.id))) return;
            await emit(project.id, chatEvent('chat.deleted', userId, chat.id));
            if (chat.aiMode === 'auto') await participation().cancelContainer('chat', chat.id);
            if (chat.aiMode === 'auto' || chat.aiMode === 'always') ctx.aiModeChanged(project);
        } catch (err) {
            log.warn(`[ProjectChat] chat ${chat.id} could not be rolled back after its first message failed: ${err && /** @type {Error} */ (err).message}`);
        }
    }

    /** Hand a stored post to the participation engine without holding up the answer. */
    function tellParticipation(args) {
        Promise.resolve()
            .then(() => participation().onHumanMessage({ surface: 'chat', ...args }))
            .catch((err) => log.warn(`[ProjectChat] participation not told about message ${args.messageId}: ${err && err.message}`));
    }

    async function loadProject(req) {
        const project = await ctx.getProject(req.params.id);
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
            await ctx.logActivity(projectId, actorId, action, { targetType: 'project_chat', targetId: chatId });
        } catch (err) {
            log.warn(`[ProjectChat] activity not recorded (${action}): ${err && /** @type {Error} */ (err).message}`);
        }
    }

    /** Mentions are kept only for people who are on the project right now. */
    async function memberMentions(projectId, ids) {
        const unique = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
        const kept = [];
        for (const id of unique) {
            try {
                if (await ctx.getProjectRole(id, projectId)) kept.push(id);
            } catch (err) { fallback('routes/projects/chatsContext:memberMentions', err); /* unknown is not a member */ }
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
            const filed = await ctx.filedIds(projectId, kind);
            if (unique.some((r) => r.kind === kind && !filed.has(r.id))) {
                throw badRequest('ref_not_in_project', 'You can only tag documents, notebooks and meeting notes that are filed in this project.');
            }
        }
        return unique;
    }

    return Object.assign(ctx, {
        dropTaskLinks, aiPolicyFor, assertModeAllowed, postAutoNotice, rollBackNewChat, tellParticipation,
        loadProject, loadChat, audit, memberMentions, checkedRefs,
    });
}

module.exports = { makeChatsContext };

/**
 * @typedef {typeof import('../../projects/chatAssistant')} ChatAssistantModule
 * @typedef {Parameters<typeof projectAccessDeps>[0] & {
 *   signalProjectChanged?: typeof import('./complianceSignal').signalProjectChanged,
 *   store?: typeof import('../../stores/projectChatStore'),
 *   taskStore?: typeof import('../../stores/projectTaskStore'),
 *   collabNotifier?: ReturnType<typeof import('../../projects/collabNotify').makeCollabNotifier>,
 *   chatCrypto?: { forProject: typeof import('../../projects/chatCrypto').forProject },
 *   assistant?: ReturnType<ChatAssistantModule['makeChatAssistant']>,
 *   resolveAgent?: ChatAssistantModule['resolveUsableAgent'],
 *   isChatAgentAllowed?: ChatAssistantModule['isChatAgentAllowed'],
 *   listChatAgents?: ChatAssistantModule['listChatAgents'],
 *   filedIds?: (projectId: string, kind: string) => Promise<Set<string>>,
 *   resolveOrgs?: (req: import('express').Request) => Promise<{ orgId: string | null, limitOrgId: string | null }>,
 *   emit?: (projectId: string, event: Parameters<typeof import('../../core/projectFeed').emitProjectEvent>[1]) => Promise<unknown>,
 *   logActivity?: typeof import('../../stores/projectStore').logActivity,
 *   postLimiter?: import('express').RequestHandler,
 *   participation?: typeof import('../../projects/participation'),
 *   policy?: ReturnType<typeof import('../../projects/participation/policy').defaultPolicy>,
 *   participationStore?: typeof import('../../stores/projectAiParticipationStore'),
 *   now?: () => number,
 *   newId?: () => string,
 * }} ChatsDeps
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/projectStore').getProject>>>} ProjectRow
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/projectChatStore').getChat>>>} ChatRow
 * @typedef {Exclude<Awaited<ReturnType<typeof import('../../stores/projectChatStore').appendMessage>>, { stale: true }>} StoredPost
 */
