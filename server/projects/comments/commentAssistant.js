// @typecheck noImplicitAny
/**
 * The AI in a comment thread: when it answers, what it reads, and how its
 * answer gets back into the thread.
 *
 * ── When ────────────────────────────────────────────────────────────────────
 *
 * `decideCommentAi` is the rule for a person's comment. A thread's `ai_mode`
 * is `off` (never), `mention` (the default: only when the comment asks — the
 * "Ask AI" action, `@ai` or `@assistant`) or `auto`. In `auto` an explicit
 * request is answered at once like in `mention`; any other comment is handed
 * to the participation engine (projects/participation), which decides later,
 * quietly, whether the AI should join (projects/comments/surface.js). A
 * resolved thread is never answered.
 *
 * ── What the model sees ─────────────────────────────────────────────────────
 *
 *   - the anchored passage and the section around it (projects/comments/
 *     passage.js), read with the ASKING member's access from the co-editing
 *     layer or the stored copy — or the beginning of the item for a comment
 *     on the whole item;
 *   - the thread so far, each comment under its author's display name (never
 *     an e-mail address);
 *   - passages from the project's knowledge bases EVERY member may read (the
 *     team chat's search, projects/chatAssistant.searchProjectKnowledge, cut to
 *     the project's audience: a thread is read by the whole project);
 *   - the project's name and instructions.
 *
 * The passage, the item's name and the thread are one user message, so the
 * Privacy Shield passage (projects/chatShield.js) scans all of it before it
 * leaves; knowledge passages are stripped by the shield's own-server list.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 *
 * It never edits the item and never resolves or reopens a thread: its only
 * write is one comment in the thread it was asked in, and that write is
 * refused when the thread was resolved meanwhile. The prompt says so, so a
 * request to "fix it" gets a suggested wording, not a change.
 *
 * ── One answer at a time, and what leaves ───────────────────────────────────
 *
 * `requestReply` claims the thread's turn in conversation_turn_locks (type
 * `project_comment`); a second request meanwhile gets `busy`. The answer is
 * written in the background and announced on the live feed: transient
 * `comment.ai.started` / `comment.ai.finished {threadId, status}` and the
 * durable `comment.created` for the answer. Events carry ids and a status;
 * a failure's reason goes to the server log only. Usage is logged as source
 * `project_comment`, and the answer as a `replied` decision (ids only), so it
 * starts the quiet time before the AI may join the thread by itself.
 */

'use strict';

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { usageLogFields } = require('../../core/providers/usageNormalizer');
const { findPassage } = require('./passage');
const {
    ASSISTANT_NAME, clip, describePassage, buildThreadText, buildCommentSystemPrompt, answerWithin,
} = require('./commentPrompt');
const { bestEffort } = require('../../utils/bestEffort');

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/projectStore').getProject>>>} CommentProject */
/** @typedef {ReturnType<typeof import('../../stores/lib/projectCommentRows').rowToThread>} CommentThread */
/** @typedef {Awaited<ReturnType<typeof import('./commentCrypto').forProject>>} CommentBox */
/** @typedef {Function} LlmChat  `(modelId, messages, options) => { content, usage, stop_reason }`; loose: llmClient.chat declares no `stop_reason`, which the usage log reads */

const CONTEXT_COMMENTS = 50;
const ANSWER_CHARS = 10000;
const DEFAULT_TIMEOUT_MS = 90_000;
const LOCK_MARGIN_MS = 30_000;
const MEMBER_NAME = 'A project member';

const ASKS_ASSISTANT = /(^|[^\w@])@(ai|assistant)(?![\w-])/i;

/**
 * Does this comment address the assistant by name?
 * @param {unknown} content
 */
function mentionsAi(content) {
    return ASKS_ASSISTANT.test(String(content || ''));
}

/**
 * @param {{ aiMode: string, status?: string, content: string, askAi?: boolean }} p
 * @returns {{ trigger: true, aiTrigger: 'ask'|'mention' } | { trigger: false, reason: string }}
 */
function decideCommentAi({ aiMode, status = 'open', content, askAi = false }) {
    if (aiMode === 'off') return { trigger: false, reason: 'ai_off' };
    if (status === 'resolved') return { trigger: false, reason: 'resolved' };
    if (askAi === true) return { trigger: true, aiTrigger: 'ask' };
    if (mentionsAi(content)) return { trigger: true, aiTrigger: 'mention' };
    if (aiMode === 'auto') return { trigger: false, reason: 'auto_pending' };
    return { trigger: false, reason: 'not_mentioned' };
}

// ── The assistant ─────────────────────────────────────────────────────────

/**
 * Every dependency is a test seam whose default is the real module. `checkLimits` answers an error
 * text or null; `recordReply` logs an answer somebody asked for, for the automatic cooldown.
 *
 * @typedef {{
 *   store?: Pick<typeof import('../../stores/projectCommentStore'), 'listComments'|'appendComment'>,
 *   commentCrypto?: Pick<typeof import('./commentCrypto'), 'forProject'>,
 *   locks?: Pick<typeof import('../../stores/conversationLockStore'), 'acquireTurn'|'releaseTurn'>,
 *   shield?: ReturnType<typeof import('../chatShield').makeChatShield>, llmChat?: LlmChat,
 *   resolveModel?: typeof import('../chatAssistant').resolveChatModel, searchKnowledge?: typeof import('../chatAssistant').searchProjectKnowledge,
 *   listAudience?: typeof import('../chatAssistant').listProjectAudience, itemReader?: Pick<ReturnType<typeof import('./passage').makeItemReader>, 'read'>,
 *   getUser?: typeof import('../../stores/userStore').getUser, displayName?: typeof import('../chatAssistant').displayNameOf,
 *   checkLimits?: (limitOrgId: string|null, userId: string|null) => Promise<string|null>,
 *   emit?: (projectId: string, event: Parameters<typeof import('../../core/projectFeed').emitProjectEvent>[1]) => Promise<unknown>,
 *   publishTransient?: typeof import('../../core/projectEventBus').publishTransient, logUsage?: typeof import('../../stores/usageStore').logUsage,
 *   recordReply?: typeof import('../../stores/projectAiParticipationStore').recordDecision, timeoutMs?: number, newId?: () => string }} CommentDeps
 */

/**
 * What a comment assistant resolves from its deps once, at creation; each
 * module default is required on first use.
 * @param {CommentDeps} deps
 */
function commentParts(deps) {
    const store = () => deps.store || require('../../stores/projectCommentStore');
    const commentCrypto = () => deps.commentCrypto || require('./commentCrypto');
    const locks = () => deps.locks || require('../../stores/conversationLockStore');
    /** @type {ReturnType<typeof import('../chatShield').makeChatShield> | null} */
    let defaultShield = null;
    const shield = () => deps.shield || (defaultShield || (defaultShield = require('../chatShield').makeChatShield({ source: 'project_comment' })));
    const llmChat = deps.llmChat || ((/** @type {string} */ modelId, /** @type {Parameters<typeof import('../../core/llm/llmClient').chat>[1]} */ messages, /** @type {Parameters<typeof import('../../core/llm/llmClient').chat>[2]} */ options) => require('../../core/llm/llmClient').chat(modelId, messages, options));
    const resolveModel = deps.resolveModel || ((/** @type {Parameters<typeof import('../chatAssistant').resolveChatModel>[0]} */ args) => require('../chatAssistant').resolveChatModel(args));
    const searchKnowledge = deps.searchKnowledge || ((/** @type {Parameters<typeof import('../chatAssistant').searchProjectKnowledge>[0]} */ args) => require('../chatAssistant').searchProjectKnowledge(args));
    const listAudience = deps.listAudience || ((/** @type {Parameters<typeof import('../chatAssistant').listProjectAudience>[0]} */ project) => require('../chatAssistant').listProjectAudience(project));
    /** @type {ReturnType<typeof import('./passage').makeItemReader> | null} */
    let defaultReader = null;
    const itemReader = () => deps.itemReader || (defaultReader || (defaultReader = require('./passage').makeItemReader()));
    const getUser = deps.getUser || ((/** @type {string} */ id) => require('../../stores/userStore').getUser(id));
    const displayName = deps.displayName || ((/** @type {Parameters<typeof import('../chatAssistant').displayNameOf>[0]} */ user) => require('../chatAssistant').displayNameOf(user));
    const checkLimits = deps.checkLimits
        || ((/** @type {string|null} */ limitOrgId, /** @type {string|null} */ userId) => require('../../core/entitlements/limits').checkSubscriptionLimits(limitOrgId, 'chat', userId));
    const emit = deps.emit
        || ((/** @type {string} */ projectId, /** @type {Parameters<typeof import('../../core/projectFeed').emitProjectEvent>[1]} */ event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectComments' }));
    const publishTransient = deps.publishTransient
        || ((/** @type {string} */ projectId, /** @type {Parameters<typeof import('../../core/projectEventBus').publishTransient>[1]} */ event) => require('../../core/projectEventBus').publishTransient(projectId, event));
    const logUsage = deps.logUsage || ((/** @type {Parameters<typeof import('../../stores/usageStore').logUsage>[0]} */ entry) => require('../../stores/usageStore').logUsage(entry));
    const recordReply = deps.recordReply
        || ((/** @type {Parameters<typeof import('../../stores/projectAiParticipationStore').recordDecision>[0]} */ decision) => require('../../stores/projectAiParticipationStore').recordDecision(decision));
    const timeoutMs = typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
    const newId = deps.newId || (() => crypto.randomUUID());
    return { store, commentCrypto, locks, shield, llmChat, resolveModel, searchKnowledge, listAudience, itemReader, getUser, displayName, checkLimits, emit, publishTransient, logUsage, recordReply, timeoutMs, newId };
}

/** @typedef {ReturnType<typeof commentParts>} CommentParts */

/**
 * @param {CommentDeps} [deps]
 */
function makeCommentAssistant(deps = {}) {
    const parts = commentParts(deps);
    const { locks, publishTransient, recordReply, checkLimits, resolveModel, timeoutMs, newId } = parts;

    /**
     * Live-feed status, best-effort: a missed beat is a later refetch.
     * @param {string} projectId
     * @param {string} kind
     * @param {string} actorId
     * @param {CommentThread} thread
     * @param {string} status
     */
    async function announce(projectId, kind, actorId, thread, status) {
        try {
            await publishTransient(projectId, {
                kind, actorId, targetType: 'comment_thread', targetId: thread.id,
                payload: { threadId: thread.id, targetType: thread.targetType, targetId: thread.targetId, status },
            });
        } catch (err) {
            log.warn(`[ProjectComments] ${kind} not published: ${err && err.message}`);
        }
    }

    /**
     * An answer somebody asked for restarts the quiet time before the AI may
     * join this thread by itself (the participation caps read it from the
     * decision log). A courtesy, never a blocker: the answer stands either way.
     * @param {{ project: CommentProject, thread: CommentThread, trigger: { id: string }, messageId: string, orgId?: string|null }} p
     */
    async function noteExplicitReply({ project, thread, trigger, messageId, orgId }) {
        try {
            await recordReply({
                projectId: project.id,
                orgId: project.organizationId || orgId || null,
                surface: 'comment',
                containerId: thread.id,
                triggerMessageId: trigger.id,
                triggerKind: 'explicit',
                decision: 'replied',
                replyMessageId: messageId,
            });
        } catch (err) {
            log.warn(`[ProjectComments] answer in thread ${thread.id} not logged for the cooldown: ${err && err.message}`);
        }
    }

    /** @type {CommentKit} */
    const kit = { ...parts, announce, noteExplicitReply };

    /**
     * Ask the assistant to answer `trigger` (the stored comment that asked) in
     * `thread` (the thread row, its anchor sealed); `triggerText` is the
     * comment's plaintext and `userId` the asking member.
     *
     * @param {{ project: CommentProject, thread: CommentThread, trigger: { id: string }, triggerText: string, userId: string,
     *           aiTrigger?: 'ask'|'mention', orgId?: string|null, limitOrgId?: string|null,
     *           session?: Parameters<typeof import('../chatAssistant').searchProjectKnowledge>[0]['session'] | null }} p
     * @returns {Promise<{ status: 'queued'|'busy'|'skipped', reason?: string, done?: Promise<{status: string}> }>}
     */
    async function requestReply({ project, thread, trigger, triggerText, userId, aiTrigger = 'mention', orgId = null, limitOrgId = null, session = null }) {
        try {
            if (await checkLimits(limitOrgId, userId)) return { status: 'skipped', reason: 'limit' };
        } catch (err) {
            log.warn(`[ProjectComments] limit check failed, not answering: ${err && err.message}`);
            return { status: 'skipped', reason: 'unavailable' };
        }
        let model;
        try {
            model = await resolveModel({ userId, orgId });
        } catch (err) {
            log.warn(`[ProjectComments] model lookup failed, not answering: ${err && err.message}`);
            return { status: 'skipped', reason: 'unavailable' };
        }
        if (!model || !model.modelId) return { status: 'skipped', reason: 'no_model' };

        const runId = newId();
        let claim;
        try {
            claim = await locks().acquireTurn({
                conversationId: thread.id,
                conversationType: 'project_comment',
                projectId: project.id,
                userId,
                runId,
                ttlMs: timeoutMs + LOCK_MARGIN_MS,
            });
        } catch (err) {
            log.warn(`[ProjectComments] turn claim failed for thread ${thread.id}: ${err && err.message}`);
            return { status: 'skipped', reason: 'unavailable' };
        }
        if (!claim || !claim.acquired) return { status: 'busy' };

        await announce(project.id, 'comment.ai.started', userId, thread, 'running');
        const done = writeAnswer(kit, { project, thread, trigger, triggerText, userId, orgId, session, model, runId, aiTrigger });
        return { status: 'queued', done };
    }

    return { requestReply };
}

/**
 * A member's display name, looked up once per thread answer.
 * @param {CommentParts} parts
 * @param {Map<string, string>} names
 * @param {string} id
 */
async function nameOf({ getUser, displayName }, names, id) {
    if (!names.has(id)) {
        let user = null;
        try { user = await getUser(id); } catch (_) { user = null; }
        names.set(id, displayName(user) || MEMBER_NAME);
    }
    return names.get(id);
}

/**
 * The anchored passage, or null when the item cannot be read.
 * @param {CommentParts} parts
 * @param {{ project: CommentProject, thread: CommentThread, box: CommentBox, userId: string }} p
 */
async function readPassage({ itemReader }, { project, thread, box, userId }) {
    let anchor = null;
    try {
        anchor = box.openAnchor(thread.id, thread.anchor);
    } catch (err) {
        log.error(`[ProjectComments] anchor of thread ${thread.id} could not be decrypted: ${err && err.code}`);
    }
    try {
        const item = await itemReader().read({
            projectId: project.id, targetType: thread.targetType, targetId: thread.targetId, userId, sectionId: anchor?.sectionId || null,
        });
        if (!item) return { name: '', passage: null, quote: anchor?.quote || '' };
        let passage = item.sectionMarkdown ? findPassage(item.sectionMarkdown, anchor) : null;
        if (!passage || !passage.found) passage = findPassage(item.markdown, anchor);
        return { name: item.name, passage, quote: anchor?.quote || '' };
    } catch (err) {
        log.warn(`[ProjectComments] item text unavailable for thread ${thread.id}: ${err && err.message}`);
        return { name: '', passage: null, quote: anchor?.quote || '' };
    }
}

/**
 * Write one answer to the thread and announce the outcome; the turn is
 * released and the shield's hold dropped whatever happens.
 * @param {CommentKit} kit
 * @param {{ project: CommentProject, thread: CommentThread, trigger: { id: string }, triggerText: string, userId: string,
 *           orgId?: string|null, session?: Parameters<typeof import('../chatAssistant').searchProjectKnowledge>[0]['session'],
 *           model: NonNullable<Awaited<ReturnType<typeof import('../chatAssistant').resolveChatModel>>>, runId: string, aiTrigger: 'ask'|'mention' }} p
 */
async function writeAnswer(kit, { project, thread, trigger, triggerText, userId, orgId, session, model, runId, aiTrigger }) {
    const { store, commentCrypto, locks, shield, llmChat, searchKnowledge, listAudience, emit, logUsage, timeoutMs, newId, announce, noteExplicitReply } = kit;
    const dlpConversationId = `project-comment-${thread.id}-${runId}`;
    let status = 'failed';
    try {
        const box = await commentCrypto().forProject(project);
        const comments = await store().listComments(thread.id, { limit: CONTEXT_COMMENTS });
        const names = new Map();
        const askerName = await nameOf(kit, names, userId);
        const lines = [];
        for (const c of comments) {
            if (c.deletedAt) continue;
            let text;
            try {
                text = box.openContent(thread.id, c.id, c.content);
            } catch (err) {
                log.error(`[ProjectComments] comment ${c.id} in thread ${thread.id} could not be decrypted: ${err && err.code}`);
                continue;
            }
            const author = c.authorKind === 'assistant' ? ASSISTANT_NAME : await nameOf(kit, names, c.authorUserId);
            lines.push({ id: c.id, author, text });
        }
        // The question is always in the context, even when it was removed
        // while the answer was queued.
        if (!lines.some((l) => l.id === trigger.id)) lines.push({ id: trigger.id, author: askerName, text: triggerText });

        const where = await readPassage(kit, { project, thread, box, userId });
        const shieldConfig = await shield().resolve({ orgId, userId });
        let knowledge = '';
        try {
            const query = [triggerText, where.quote].filter(Boolean).join('\n').slice(0, 2000);
            const audienceIds = await listAudience(project);
            knowledge = await searchKnowledge({ project, userId, query, session, shield: shieldConfig, audienceIds }) || '';
        } catch (err) {
            log.warn(`[ProjectComments] project knowledge search failed for thread ${thread.id}: ${err && err.message}`);
        }

        const text = [
            describePassage({ kind: thread.targetType, name: where.name, passage: where.passage }),
            '',
            buildThreadText(lines, askerName),
        ].join('\n');
        const outbound = await shield().protect({
            shield: shieldConfig,
            orgId,
            userId,
            text,
            conversationId: dlpConversationId,
            providerConfig: model.providerConfig || {},
            auditBase: { conversation_id: thread.id, model: model.modelId, agent_id: null },
        });
        const system = buildCommentSystemPrompt({ project, knowledge, tokenAddendum: shield().tokenAddendum(outbound.tokenMap) });

        const started = Date.now();
        const result = await answerWithin(() => llmChat(model.modelId, [
            { role: 'system', content: system },
            { role: 'user', content: outbound.text },
        ], { ...(model.options || {}), timeoutMs }), timeoutMs);
        try {
            const usage = result?.usage || {};
            await logUsage({
                user_id: userId,
                organization_id: orgId || null,
                agent_id: null,
                agent_name: 'project-comment',
                agent_type: 'chat',
                model: model.modelId,
                ...usageLogFields(usage),
                stop_reason: result?.stop_reason || null,
                source: 'project_comment',
                duration_ms: Date.now() - started,
                conversation_id: thread.id,
            });
        } catch (err) {
            log.warn(`[ProjectComments] usage logging failed: ${err && err.message}`);
        }

        let answer = typeof result?.content === 'string' ? result.content.trim() : '';
        if (!answer) throw Object.assign(new Error('The model returned an empty answer'), { code: 'AI_EMPTY' });
        answer = clip(shield().restore(answer, outbound.tokenMap), ANSWER_CHARS);

        const commentId = newId();
        let saved;
        try {
            saved = await store().appendComment(project.id, thread.id, {
                id: commentId,
                authorKind: 'assistant',
                authorUserId: null,
                content: box.sealContent(thread.id, commentId, answer),
                replyTo: trigger.id,
                aiTrigger,
            }, { requireOpen: true });
        } catch (err) {
            // Resolved while the answer was being written: the people are
            // done with it, so the answer is dropped, not forced in.
            if (err?.code === 'THREAD_RESOLVED') { status = 'skipped'; return { status }; }
            throw err;
        }
        if (!saved) throw Object.assign(new Error('The thread no longer exists'), { code: 'THREAD_GONE' });
        await emit(project.id, {
            kind: 'comment.created',
            actorId: userId,
            targetType: 'comment_thread',
            targetId: thread.id,
            payload: {
                threadId: thread.id, commentId: saved.comment.id, seq: saved.comment.seq, authorKind: 'assistant',
                targetType: thread.targetType, targetId: thread.targetId,
            },
        });
        await noteExplicitReply({ project, thread, trigger, messageId: saved.comment.id, orgId });
        status = 'answered';
    } catch (err) {
        status = err?.code === 'PRIVACY_BLOCKED' ? 'blocked' : 'failed';
        log.warn(`[ProjectComments] answer in thread ${thread.id} (run ${runId}) ${status}: ${err?.code || err?.name || 'error'}: ${err && err.message}`);
    } finally {
        try {
            await locks().releaseTurn({ conversationId: thread.id, runId });
        } catch (err) {
            log.warn(`[ProjectComments] turn release failed for thread ${thread.id}; it expires on its own: ${err && err.message}`);
        }
        try { shield().release(dlpConversationId); } catch (err) { bestEffort('projects/comments/commentAssistant:writeAnswer', err); /* nothing held */ }
        await announce(project.id, 'comment.ai.finished', userId, thread, status);
    }
    return { status };
}

/**
 * @typedef {CommentParts & {
 *   announce: (projectId: string, kind: string, actorId: string, thread: CommentThread, status: string) => Promise<void>,
 *   noteExplicitReply: (p: { project: CommentProject, thread: CommentThread, trigger: { id: string }, messageId: string, orgId?: string|null }) => Promise<void>,
 * }} CommentKit  what an answer is written with: the parts plus the feed and cooldown notes
 */

module.exports = {
    ASSISTANT_NAME,
    DEFAULT_TIMEOUT_MS,
    makeCommentAssistant,
    decideCommentAi,
    mentionsAi,
    describePassage,
    buildThreadText,
    buildCommentSystemPrompt,
};
