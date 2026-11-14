// @typecheck strict
/**
 * Support Tools — read-only lookups the Bee Flow Support AI agent may call
 * while drafting a customer reply. Exposed only to the system support agent
 * (gated in agentTools/the responder), never to tenant agents.
 *
 * Security model: the thread under discussion is fixed by the responder via
 * `context.supportThreadId`. Tools IGNORE any threadId the model might pass in
 * args and always re-derive the thread from that context, so the model cannot
 * pivot to another customer's data. Every tool is strictly read-only.
 */
const supportStore = require('../stores/supportStore');
const userStore = require('../stores/userStore');
const { bestEffort, fallback } = require('../utils/bestEffort');
const { SUPPORT_TOOLS, SUPPORT_ACTION_TOOLS, ACTION_LEVELS, actionLevelForMode, isSupportTool, isSupportActionTool, buildSupportToolset } = require('./supportToolsBuildSupportToolset');
const { registerHandle, handleOf } = require('../core/kb/queryLog/hook.mts');

/**
 * Per-run policy object the executor mutates (budget + clobber signalling).
 * @param {{ actionLevel?: string, budget?: number }} [opts]
 */
function makeActionPolicy({ actionLevel = 'none', budget = 5 } = {}) {
    return {
        actionLevel,
        allowed: new Set(ACTION_LEVELS[actionLevel] || []),
        budget,
        used: 0,
        statusChangedByTool: false,
    };
}

/** @typedef {ReturnType<typeof makeActionPolicy>} ActionPolicy */
/** A support_threads row. @typedef {Record<string, any>} SupportThread */
/**
 * @typedef {{ userId?: string, session?: unknown, supportThreadId?: string,
 *   userAuth?: { supportThreadId?: string, supportActionPolicy?: ActionPolicy, queryLogCarrier?: object },
 *   supportActionPolicy?: ActionPolicy | null }} SupportContext
 */
/**
 * The tool arguments as the model sends them.
 * @typedef {{ priority?: string, tag?: string, category?: string, status?: string, userId?: string,
 *   reason?: string, limit?: unknown, query?: string, topK?: unknown }} SupportArgs
 */

/**
 * Best-effort live refresh after an action (tenant SSE is inbox-scoped).
 * @param {SupportThread} thread
 */
function _emitThreadUpdated(thread) {
    try {
        if (!thread?.inbox_id) return;
        const { supportEvents } = require('../support/events');
        supportEvents.emit('event', { event: 'thread_updated', data: { threadId: thread.id, inboxId: thread.inbox_id } });
    } catch (err) { bestEffort('integrations/supportTools:_emitThreadUpdated', err); /* non-fatal */ }
}

/**
 * @param {SupportContext} context
 */
async function _resolveThread(context) {
    const threadId = context?.supportThreadId || context?.userAuth?.supportThreadId || null;
    if (!threadId) return null;
    return supportStore.getThread(threadId);
}

/**
 * @param {string} threadId
 * @param {string} tool
 * @param {Record<string, unknown>} [payload]
 */
async function _recordAction(threadId, tool, payload = {}) {
    try {
        await supportStore.recordThreadEvent({ threadId, actorKind: 'ai', action: 'ai_action', payload: { tool, ...payload } });
    } catch (err) { bestEffort('integrations/supportTools:_recordAction', err); /* audit is best-effort */ }
}

// The group ACL on the thread's inbox ([] = open). Used so AI assignment/
// escalation never strands a ticket on a teammate who can't access the inbox.
/**
 * @param {SupportThread} thread
 */
async function _inboxSharedGroups(thread) {
    if (!thread?.inbox_id) return [];
    try {
        const inbox = await require('../stores/supportInboxStore').getInbox(thread.inbox_id);
        return Array.isArray(inbox?.shared_groups) ? inbox.shared_groups : [];
    } catch { return []; }
}

/**
 * A mutating support tool: answers `{ error }` to refuse (nothing written,
 * nothing counted) or its result once the change is made.
 * @typedef {(args: SupportArgs, a: { toolName: string, thread: SupportThread, policy: ActionPolicy }) => Promise<Record<string, unknown>>} ActionHandler
 */

/** @type {ActionHandler} */
async function setPriority(args, { toolName, thread }) {
    const priority = String(args.priority || '').toLowerCase();
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return { error: 'invalid priority' };
    await supportStore.updateThread(thread.id, { priority });
    await _recordAction(thread.id, toolName, { priority });
    return { ok: true, priority };
}

/** @type {ActionHandler} */
async function addTag(args, { toolName, thread }) {
    const tag = String(args.tag || '').trim();
    if (!tag) return { error: 'tag required' };
    const taxonomy = await supportStore.listTags(thread.organization_id || null);
    const match = taxonomy.find(t => t.name.toLowerCase() === tag.toLowerCase());
    if (!match) return { error: 'Tag is not in the team taxonomy.' };
    await supportStore.addThreadTag(thread.id, match.name);
    await _recordAction(thread.id, toolName, { tag: match.name });
    return { ok: true, tag: match.name };
}

/** @type {ActionHandler} */
async function setCategory(args, { toolName, thread }) {
    const category = String(args.category || '').trim().slice(0, 100);
    if (!category) return { error: 'category required' };
    await supportStore.updateThread(thread.id, { category });
    await _recordAction(thread.id, toolName, { category });
    return { ok: true, category };
}

/** @type {ActionHandler} */
async function setStatus(args, { toolName, thread, policy }) {
    const status = String(args.status || '');
    const allowedValues = policy.actionLevel === 'full'
        ? ['awaiting_user', 'awaiting_agent', 'resolved']
        : ['awaiting_user', 'awaiting_agent'];
    if (!allowedValues.includes(status)) return { error: `Status "${status}" not permitted at this level.` };
    /** @type {{ status: string, resolved_at?: string }} */
    const patch = { status };
    if (status === 'resolved' && thread.status !== 'resolved') patch.resolved_at = new Date().toISOString();
    await supportStore.updateThread(thread.id, patch);
    policy.statusChangedByTool = true;
    await _recordAction(thread.id, toolName, { status });
    return { ok: true, status };
}

/** @type {ActionHandler} */
async function requestMoreInfo(_args, { toolName, thread, policy }) {
    await supportStore.updateThread(thread.id, { status: 'awaiting_user' });
    policy.statusChangedByTool = true;
    await _recordAction(thread.id, toolName, {});
    return { ok: true, status: 'awaiting_user' };
}

/** @type {ActionHandler} */
async function assignToTeammate(args, { toolName, thread }) {
    const userId = String(args.userId || '').trim();
    if (!userId) return { error: 'userId required' };
    const { _eligibleStaffForOrg } = require('../services/supportAutoAssigner');
    const eligible = /** @type {string[]} */ (await _eligibleStaffForOrg(thread.organization_id || null, { tenantInbox: !!thread.inbox_id }).catch((e) => fallback('integrations/supportTools:executeSupportActionTool', e, [])));
    if (!eligible.includes(userId)) return { error: 'Not an eligible teammate for this organisation.' };
    // On a group-restricted inbox the assignee must be able to work it,
    // otherwise the ticket is stranded with someone who'd be 403'd.
    const sharedGroups = await _inboxSharedGroups(thread);
    if (sharedGroups.length) {
        const access = require('../support/access');
        const g = await access.userGroupsFor(userId);
        if (!g.some((/** @type {string} */ x) => sharedGroups.includes(x))) {
            return { error: 'That teammate does not have access to this inbox.' };
        }
    }
    await supportStore.updateThread(thread.id, { assignee_user_id: userId, auto_assigned: false });
    await _recordAction(thread.id, toolName, { assignee_user_id: userId });
    return { ok: true };
}

/** @type {ActionHandler} */
async function escalateToHuman(args, { toolName, thread, policy }) {
    const reason = String(args.reason || 'escalated by AI').slice(0, 200);
    await supportStore.appendMessage({ threadId: thread.id, authorKind: 'system', body: `AI handed off to a human agent (${reason}).` }).catch((e) => bestEffort('integrations/supportTools:executeSupportActionTool#2', e));
    await supportStore.updateThread(thread.id, { status: 'awaiting_agent', ai_handled: true, ai_escalated_reason: reason });
    policy.statusChangedByTool = true;
    try {
        const fresh = await supportStore.getThread(thread.id);
        if (fresh && !fresh.assignee_user_id) {
            const { pickNextAssignee } = require('../services/supportAutoAssigner');
            const sharedGroups = await _inboxSharedGroups(thread);
            const next = await pickNextAssignee(thread.organization_id || null, { sharedGroups, tenantInbox: !!thread.inbox_id });
            if (next) await supportStore.updateThread(thread.id, { assignee_user_id: next, auto_assigned: true });
        }
    } catch (err) { bestEffort('integrations/supportTools:executeSupportActionTool#3', err); /* auto-assign best-effort */ }
    await _recordAction(thread.id, toolName, { reason });
    return { ok: true };
}

/** @type {Record<string, ActionHandler>} */
const ACTION_HANDLERS = {
    support_set_priority: setPriority,
    support_add_tag: addTag,
    support_set_category: setCategory,
    support_set_status: setStatus,
    support_request_more_info: requestMoreInfo,
    support_assign_to_teammate: assignToTeammate,
    support_escalate_to_human: escalateToHuman,
};

/**
 * Execute a MUTATING support tool. Enforces the per-run action policy (level +
 * budget), audits every change, and signals status clobber so the responder can
 * yield. Never sends customer email.
 * @param {string} toolName
 * @param {SupportArgs} args
 * @param {SupportContext} context
 * @param {SupportThread} thread
 */
async function executeSupportActionTool(toolName, args, context, thread) {
    const policy = context?.supportActionPolicy || context?.userAuth?.supportActionPolicy || null;
    if (!policy || policy.actionLevel === 'none') return { error: 'Action tools are not enabled for this inbox.' };
    if (!policy.allowed || !policy.allowed.has(toolName)) {
        return { error: `This action is not permitted in the current reply mode (level: ${policy.actionLevel}).` };
    }
    if (policy.used >= policy.budget) return { error: `Action budget exhausted (max ${policy.budget} per turn).` };

    const handler = Object.hasOwn(ACTION_HANDLERS, toolName) ? ACTION_HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown support action tool: ${toolName}` };
    const result = await handler(args, { toolName, thread, policy });
    if ('error' in result) return result;

    policy.used += 1;
    const fresh = await supportStore.getThread(thread.id).catch(() => thread);
    _emitThreadUpdated(fresh || thread);
    return result;
}

/** @typedef {(args: SupportArgs, r: { thread: SupportThread, context: SupportContext }) => Promise<any>} ReadHandler */

/** @type {ReadHandler} */
async function requesterProfile(_args, { thread }) {
    let role = thread.requester_org_role || null;
    let accountCreatedAt = null;
    if (thread.requester_user_id) {
        try {
            const user = await userStore.getUser(thread.requester_user_id);
            if (user) {
                role = role || user.role || null;
                accountCreatedAt = user.createdAt || user.created_at || null;
            }
        } catch (err) { fallback('integrations/supportTools:executeSupportTool', err); /* best-effort */ }
    }
    return {
        name: thread.requester_name || null,
        email: thread.requester_email,
        loggedIn: !!thread.requester_user_id,
        organizationName: thread.requester_org_name || null,
        orgRole: role,
        accountCreatedAt,
    };
}

/** @type {ReadHandler} */
async function organizationInfo(_args, { thread }) {
    if (!thread.organization_id) return null;
    try {
        const org = await userStore.getOrganization(thread.organization_id);
        if (!org) return null;
        return {
            id: org.id,
            name: org.name || null,
            createdAt: org.createdAt || org.created_at || null,
        };
    } catch (e) {
        return { error: /** @type {Error} */ (e).message };
    }
}

/** @type {ReadHandler} */
async function subscriptionStatus(_args, { thread }) {
    if (!thread.organization_id) return null;
    try {
        const sub = await userStore.getOrgSubscription(thread.organization_id);
        if (!sub) return { status: 'none', note: 'No subscription on record (likely free/consumer account).' };
        return {
            planName: sub.plan_name || null,
            planTier: sub.plan_tier || null,
            status: sub.status || null,
            renewsAt: sub.current_period_end || sub.renews_at || null,
        };
    } catch (e) {
        return { error: /** @type {Error} */ (e).message };
    }
}

/** @type {ReadHandler} */
async function recentThreadsForRequester(args, { thread }) {
    const limit = Math.min(Math.max(parseInt(/** @type {string} */ (args.limit), 10) || 10, 1), 10);
    const threads = await supportStore.listThreads({
        requesterEmail: thread.requester_email,
        limit,
    });
    return threads
        .filter(t => t.id !== thread.id)
        .map(t => ({
            subject: t.subject,
            status: t.status,
            resolvedAt: t.resolved_at || null,
            createdAt: t.created_at,
        }));
}

/** @type {ReadHandler} */
async function searchKnowledgeBase(args, { thread, context }) {
    const query = (args.query || '').toString().trim();
    if (!query) return { error: 'query required' };
    const topK = Math.min(Math.max(parseInt(/** @type {string} */ (args.topK), 10) || 4, 1), 8);
    try {
        const { quickKBSearch } = require('../core/agentRuntime/knowledgeSearch');
        const agentStore = require('../stores/agentStore');
        const agent = await agentStore.getAgent('system-bee-flow-support');
        const kbList = /** @type {{ knowledge_base_ids?: string[] } | undefined} */ (agent?.config)?.knowledge_base_ids;
        const kbIds = Array.isArray(kbList) ? kbList : [];
        const aiUserId = `support-ai:${thread.id}`;
        // KB query log: the person asking is the requester; the responder finishes the handle with its reply.
        const hits = await quickKBSearch(aiUserId, kbIds, query, {
            topK,
            log: context.userAuth?.queryLogCarrier ? {
                channel: 'support', channelRef: { threadId: thread.id },
                orgId: thread.organization_id || null, userId: thread.requester_user_id || null,
            } : null,
        });
        registerHandle(context.userAuth?.queryLogCarrier, handleOf(hits));
        return (/** @type {any[]} */ (hits) || []).map(h => ({ title: h.title, content: h.content, score: h.score, source: h.source_uri }));
    } catch (e) {
        return { error: /** @type {Error} */ (e).message };
    }
}

/** @type {ReadHandler} */
async function cannedResponses(_args, { thread }) {
    try {
        const { renderCannedBody } = require('../support/notifications');
        const list = await supportStore.listCannedResponses(thread.organization_id || null);
        return list.map(c => ({
            title: c.title,
            shortcut: c.shortcut || null,
            // Wrapped + rendered so the model treats it as content, not instructions.
            body: `<canned>${renderCannedBody(c.body, thread, null)}</canned>`,
        }));
    } catch (e) {
        return { error: /** @type {Error} */ (e).message };
    }
}

/** @type {Record<string, ReadHandler>} */
const READ_HANDLERS = {
    support_get_requester_profile: requesterProfile,
    support_get_organization_info: organizationInfo,
    support_get_subscription_status: subscriptionStatus,
    support_list_recent_threads_for_requester: recentThreadsForRequester,
    support_search_knowledge_base: searchKnowledgeBase,
    support_list_canned_responses: cannedResponses,
};

/**
 * @param {string} toolName
 * @param {SupportArgs} [args]
 * @param {SupportContext} [context]
 */
async function executeSupportTool(toolName, args = {}, context = {}) {
    const thread = await _resolveThread(context);
    if (!thread) return { error: 'No support thread context available.' };

    if (isSupportActionTool(toolName)) {
        return executeSupportActionTool(toolName, args, context, thread);
    }
    const handler = Object.hasOwn(READ_HANDLERS, toolName) ? READ_HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown support tool: ${toolName}` };
    return handler(args, { thread, context });
}

module.exports = {
    SUPPORT_TOOLS,
    SUPPORT_ACTION_TOOLS,
    isSupportTool,
    isSupportActionTool,
    executeSupportTool,
    buildSupportToolset,
    makeActionPolicy,
    actionLevelForMode,
};
