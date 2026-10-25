// @typecheck
/**
 * Project comment threads: the context every comment handler shares. The
 * injected dependencies with their lazily required defaults, plus the helpers
 * built on them: lookups that check the item is still filed in the project,
 * the organisation's AI policy, mentions and their bell, the caller's own
 * feedback, the thread as the panel shows it, and what happens after a
 * person's comment. Split out of comments.js; behaviour unchanged. The `deps`
 * contract is documented on makeProjectCommentsRouter.
 */

'use strict';

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { lazyProjectRoleGate } = require('./roleGate');
const { forbidden, notFound } = require('../../core/http/errors');
const { isAutomatic, presentThread } = require('./commentsPresent');
const { fallback } = require('../../utils/bestEffort');

/** The dependencies, each defaulting to the real module, required on first use. */
function resolveCommentsDeps(deps) {
    let defaultAssistant = null;
    let defaultLimiter = null;
    let defaultCollabNotifier = null;
    return {
        requireRole: deps.requireProjectRole || lazyProjectRoleGate,
        store: () => deps.store || require('../../stores/projectCommentStore'),
        getProject: deps.getProject || ((id) => require('../../stores/projectStore').getProject(id)),
        getProjectRole: deps.getProjectRole
            || ((userId, projectId) => require('../../auth/projectAccess').getProjectRole(userId, projectId)),
        commentCrypto: () => deps.commentCrypto || require('../../projects/comments/commentCrypto'),
        assistant: () => deps.assistant
            || (defaultAssistant || (defaultAssistant = require('../../projects/comments/commentAssistant').makeCommentAssistant())),
        participation: deps.participation || {
            notify: (p) => require('../../projects/comments/surface').notifyHumanComment(p),
            cancel: (threadId) => require('../../projects/comments/surface').cancelCommentThread(threadId),
        },
        resolveOrgs: deps.resolveOrgs || (async (req) => {
            const userId = req.session.user.id;
            const orgId = await require('../../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId });
            const limitOrgId = await require('../../core/entitlements/limits').resolveOrgId(req);
            return { orgId: orgId || null, limitOrgId: limitOrgId || null };
        }),
        emit: deps.emit
            || ((projectId, event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectComments' })),
        logActivity: deps.logActivity
            || ((projectId, actorId, action, details) => require('../../stores/projectStore').logActivity(projectId, actorId, action, details)),
        postLimiter: deps.postLimiter || function rateLimitMiddleware(req, res, next) {
            if (!defaultLimiter) {
                defaultLimiter = require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 90, name: 'project-comment-post' });
            }
            return defaultLimiter(req, res, next);
        },
        participationStore: () => deps.participationStore || require('../../stores/projectAiParticipationStore'),
        policy: () => deps.policy || require('../../projects/participation/policy').defaultPolicy(),
        // A thread's AI mode is something the project compliance checks read.
        aiModeChanged: (project) => (deps.signalProjectChanged || require('./complianceSignal').signalProjectChanged)(project, 'ai_mode'),
        now: deps.now || (() => Date.now()),
        newId: deps.newId || (() => crypto.randomUUID()),
        // A comment that mentions someone rings their bell (the text is never in it): a task through
        // the task notifier as before, a document or notebook through the collaboration notifier.
        taskNotifier: () => deps.taskNotifier || require('../../projects/taskNotify').makeTaskNotifier(),
        collabNotifier: () => deps.collabNotifier
            || (defaultCollabNotifier || (defaultCollabNotifier = require('../../projects/collabNotify').makeCollabNotifier())),
        userIdOf: (req) => req.session.user.id,
    };
}

/** The helpers on top of the dependencies; returns the full handler context. */
function makeCommentsContext(deps = {}) {
    const ctx = resolveCommentsDeps(deps);
    const { store } = ctx;
    const { decideCommentAi, mentionsAi } = require('../../projects/comments/commentAssistant');

    async function loadProject(req) {
        const project = await ctx.getProject(req.params.id);
        // Deleted between the role check and here.
        if (!project) throw notFound('not_found', 'Not found');
        return project;
    }

    async function notifyMentions(project, thread, actorId, mentionedUserIds) {
        try {
            if (thread.targetType === 'task') {
                await ctx.taskNotifier().mentioned({ project, actorId, mentionedUserIds, taskId: thread.targetId });
            } else {
                await ctx.collabNotifier().commentMentioned({ project, actorId, mentionedUserIds, targetType: thread.targetType, targetId: thread.targetId });
            }
        } catch (err) {
            log.warn(`[ProjectComments] mention not notified: ${err && err.message}`);
        }
    }

    /** The item must be filed in this project right now. */
    async function assertTarget(project, targetType, targetId) {
        const target = await store().lookupTarget(targetType, targetId);
        if (!target || target.projectId !== project.id) {
            throw notFound('target_not_found', 'This notebook, document or task is not in this project.');
        }
        return target;
    }

    /** What the organisation lets a thread choose, for the panel. Never throws (the policy narrows on failure). */
    async function aiPolicyFor(project) {
        const { autoAllowedOn } = require('../../projects/participation/policy');
        return { autoAllowed: autoAllowedOn(await ctx.policy().resolveOrgPolicy(project.organizationId || null), 'comment') };
    }

    /**
     * "AI decides" on a comment thread only where the organisation allows the
     * AI to join comment threads by itself (projects/participation/policy
     * autoAllowedOn). Off and mention are always allowed.
     */
    async function assertModeAllowed(project, aiMode) {
        if (aiMode !== 'auto') return;
        if (!(await aiPolicyFor(project)).autoAllowed) {
            throw forbidden('ai_mode_not_allowed', 'Your organisation does not let the AI join comment threads by itself. Choose another AI mode.');
        }
    }

    async function loadThread(project, threadId) {
        const thread = await store().getThread(project.id, threadId);
        if (!thread) throw notFound('thread_not_found', 'This comment thread does not exist in this project.');
        await assertTarget(project, thread.targetType, thread.targetId);
        return thread;
    }

    /**
     * The caller's own feedback on the automatic answers among `comments`. A
     * courtesy: when it cannot be read the panel just shows no choice made.
     */
    async function myFeedback(userId, comments) {
        const ids = comments.filter(isAutomatic).map((c) => c.id);
        if (ids.length === 0) return new Map();
        try {
            return await ctx.participationStore().feedbackFor(userId, ids);
        } catch (err) {
            log.warn(`[ProjectComments] feedback not read: ${err && err.message}`);
            return new Map();
        }
    }

    /**
     * The thread as the panel shows it: its latest comments (before
     * `beforeSeq` when paging back), and how many older ones are left, so a
     * long thread never reads as complete while its middle is missing.
     */
    async function fullThread(box, thread, userId, { beforeSeq = null } = {}) {
        const page = await store().pageComments(thread.id, { beforeSeq });
        return presentThread(box, { ...thread, omittedComments: page.earlier }, page.comments, new Map(), await myFeedback(userId, page.comments));
    }

    /** Mentions are kept only for people who are on the project right now. */
    async function memberMentions(projectId, ids) {
        const wanted = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))];
        // A lookup that fails reads as "not a member".
        const roles = await Promise.all(wanted.map((id) => Promise.resolve().then(() => ctx.getProjectRole(id, projectId)).catch((e) => fallback('routes/projects/commentsContext:memberMentions', e, null))));
        return wanted.filter((_, i) => !!roles[i]);
    }

    /**
     * Hand a stored comment to the participation engine without holding up
     * the answer: the engine reads the thread (and may read the item), which
     * the poster should never wait for. Never throws.
     */
    function tellParticipation(notice) {
        Promise.resolve()
            .then(() => ctx.participation.notify(notice))
            .catch((err) => log.warn(`[ProjectComments] participation not told about comment ${notice.commentId}: ${err && err.message}`));
    }

    /**
     * After a person's comment: the AI answers now (asked), the participation
     * engine is told (every comment in an `auto` thread, so it can also see a
     * question being answered by a person), or nothing happens. Returns what
     * the poster sees; the engine's own decision comes later, quietly.
     */
    async function afterHumanComment(req, { project, thread, comment, content, askAi }) {
        const userId = ctx.userIdOf(req);
        const decision = decideCommentAi({ aiMode: thread.aiMode, status: thread.status, content, askAi });
        const orgs = decision.trigger || thread.aiMode === 'auto' ? await ctx.resolveOrgs(req) : null;
        if (orgs && thread.aiMode === 'auto' && thread.status === 'open') {
            tellParticipation({
                threadId: thread.id, commentId: comment.id, authorUserId: userId, projectId: project.id,
                orgId: orgs.orgId, limitOrgId: orgs.limitOrgId, explicit: decision.trigger === true,
            });
        }
        if (decision.trigger === false) return { status: 'skipped', reason: decision.reason };
        const { orgId, limitOrgId } = orgs || await ctx.resolveOrgs(req);
        const reply = await ctx.assistant().requestReply({
            project, thread, trigger: comment, triggerText: content, userId, aiTrigger: decision.aiTrigger, orgId, limitOrgId, session: req.session,
        });
        return reply.reason ? { status: reply.status, reason: reply.reason } : { status: reply.status };
    }

    return Object.assign(ctx, {
        mentionsAi, loadProject, notifyMentions, assertTarget, aiPolicyFor, assertModeAllowed, loadThread,
        myFeedback, fullThread, memberMentions, afterHumanComment,
    });
}

module.exports = { makeCommentsContext };

/** @typedef {NonNullable<Parameters<typeof import('./comments').makeProjectCommentsRouter>[0]>} CommentsDeps */

/** @typedef {import('../../projects/comments/commentAssistant').CommentProject} CommentProject */

/** @typedef {import('../../projects/comments/commentAssistant').CommentThread} CommentThread */

/** @typedef {import('../../projects/comments/commentAssistant').CommentBox} CommentBox */

/** @typedef {ReturnType<typeof import('../../stores/lib/projectCommentRows').rowToComment>} CommentRow */

/** @typedef {ReturnType<typeof makeCommentsContext>} CommentsCtx */
