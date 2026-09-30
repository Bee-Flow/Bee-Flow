// @typecheck
/**
 * Comment threads as a surface of the AI participation engine
 * (projects/participation): what lets the AI join a thread by itself when the
 * thread's mode is `auto`.
 *
 * The engine owns the decision — rules, debounce, the fast relevance gate,
 * cooldowns, caps, the Privacy Shield on every call and staying silent on any
 * failure. This module only answers its two questions about a thread:
 *
 *   loadContext(threadId)  the thread as the engine reads it: project, org,
 *                          mode, whether it is closed (resolved), the
 *                          comments (opened), and the anchored passage with
 *                          its section as `extraContext`, read with the access
 *                          of the person who wrote the latest comment; null
 *                          when the thread is gone or its item left the
 *                          project, so the engine drops it without a model call.
 *                          With `{ light: true }` (the rules only) the passage
 *                          is not read: that is a whole-item read and
 *                          conversion, which only an answer needs;
 *   postAnswer({...})      store the engine's answer as an assistant comment
 *                          and announce it on the feed, ids only — or report
 *                          it stale (`{stale:true}`) when the thread was
 *                          resolved or a person commented after the
 *                          conversation the gate read (`afterSeq`), checked
 *                          under the thread lock.
 *
 * The router tells the engine about people's comments in `auto` threads
 * (`notifyHumanComment`, with `explicit` for "@ai" and "Ask AI", which the AI
 * answers at once anyway) and withdraws a thread (`cancelCommentThread`)
 * when it leaves `auto`, is resolved or is deleted.
 *
 * Registration is idempotent and defensive: while the engine is not there
 * (or answers with a different shape) nothing is registered, a line is
 * logged, and comments keep working with `@ai`.
 */

'use strict';

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { findPassage } = require('./passage');
const { describePassage, mentionsAi } = require('./commentAssistant');

const SURFACE = 'comment';
const LOCK_TYPE = 'project_comment';
const CONTEXT_COMMENTS = 30;
const ANSWER_CHARS = 10000;

/**
 * @param {object} [deps]
 * @param {object}   [deps.store]          stores/projectCommentStore surface
 * @param {object}   [deps.commentCrypto]  { forProject(project) }
 * @param {Function} [deps.getProject]     (id) => project row
 * @param {object}   [deps.itemReader]     { read({projectId, targetType, targetId, userId, sectionId}) }
 * @param {Function} [deps.emit]           (projectId, event) => durable event
 * @param {Function} [deps.newId]
 */
function makeCommentSurface(deps = {}) {
    const store = () => deps.store || require('../../stores/projectCommentStore');
    const commentCrypto = () => deps.commentCrypto || require('./commentCrypto');
    const getProject = deps.getProject || ((id) => require('../../stores/projectStore').getProject(id));
    let defaultReader = null;
    const itemReader = () => deps.itemReader || (defaultReader || (defaultReader = require('./passage').makeItemReader()));
    const emit = deps.emit
        || ((projectId, event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectComments' }));
    const newId = deps.newId || (() => crypto.randomUUID());

    /** The thread, its project, and whether its item is still filed there. */
    async function load(threadId) {
        const thread = threadId ? await store().getThreadById(threadId) : null;
        if (!thread) return null;
        const project = await getProject(thread.projectId);
        if (!project) return null;
        const target = await store().lookupTarget(thread.targetType, thread.targetId);
        if (!target || target.projectId !== project.id) return null;
        return { thread, project };
    }

    /** The passage and its section, read as `userId`; '' when it cannot be read. */
    async function passageText(project, thread, anchor, userId) {
        try {
            const item = await itemReader().read({
                projectId: project.id, targetType: thread.targetType, targetId: thread.targetId, userId, sectionId: anchor?.sectionId || null,
            });
            if (!item) return '';
            let passage = item.sectionMarkdown ? findPassage(item.sectionMarkdown, anchor) : null;
            if (!passage || !passage.found) passage = findPassage(item.markdown, anchor);
            return describePassage({ kind: thread.targetType, name: item.name, passage, tagged: false });
        } catch (err) {
            log.warn(`[ProjectComments] passage unavailable for thread ${thread.id}: ${err && err.message}`);
            return '';
        }
    }

    /**
     * @param {string} threadId
     * @param {{ light?: boolean }} [opts]
     */
    async function loadContext(threadId, { light = false } = {}) {
        const found = await load(threadId);
        if (!found) return null;
        const { thread, project } = found;
        const box = await commentCrypto().forProject(project);
        const rows = await store().listComments(thread.id, { limit: CONTEXT_COMMENTS });
        const messages = [];
        for (const c of rows) {
            if (c.deletedAt) continue;
            let text;
            try {
                text = box.openContent(thread.id, c.id, c.content);
            } catch (err) {
                log.error(`[ProjectComments] comment ${c.id} in thread ${thread.id} could not be decrypted: ${err && err.code}`);
                continue;
            }
            messages.push({
                id: c.id,
                seq: c.seq,
                authorKind: c.authorKind,
                authorUserId: c.authorUserId,
                text,
                createdAt: c.createdAt,
                replyTo: c.replyTo,
                mentionsAi: c.authorKind === 'user' && (c.mentionsAi || mentionsAi(text)),
                mentionsHuman: c.mentions.length > 0,
            });
        }
        let anchor = null;
        try {
            anchor = box.openAnchor(thread.id, thread.anchor);
        } catch (err) {
            log.error(`[ProjectComments] anchor of thread ${thread.id} could not be decrypted: ${err && err.code}`);
        }
        const reader = [...messages].reverse().find((m) => m.authorKind === 'user')?.authorUserId || null;
        const extraContext = reader && !light ? await passageText(project, thread, anchor, reader) : '';
        return {
            projectId: project.id,
            orgId: project.organizationId || null,
            aiMode: thread.aiMode,
            closed: thread.status !== 'open',
            autoPausedUntil: thread.autoPausedUntil || null,
            messages,
            ...(extraContext ? { extraContext } : {}),
        };
    }

    /**
     * @param {{ containerId: string, text: string, replyTo?: string|null, trigger?: string,
     *           agentId?: string|null, afterSeq?: number|null }} p
     * @returns {Promise<{ messageId: string }|{ stale: true }|null>}
     */
    async function postAnswer({ containerId, text, replyTo = null, trigger = 'auto', agentId = null, afterSeq = null }) {
        const found = await load(containerId);
        if (!found) return null;
        const { thread, project } = found;
        const answer = String(text || '').trim();
        if (!answer) return null;
        const box = await commentCrypto().forProject(project);
        const replyTarget = replyTo ? await store().getComment(thread.id, replyTo) : null;
        const commentId = newId();
        let saved;
        try {
            saved = await store().appendComment(project.id, thread.id, {
                id: commentId,
                authorKind: 'assistant',
                authorUserId: null,
                agentId: agentId || null,
                content: box.sealContent(thread.id, commentId, answer.length > ANSWER_CHARS ? `${answer.slice(0, ANSWER_CHARS)} …` : answer),
                replyTo: replyTarget ? replyTarget.id : null,
                aiTrigger: String(trigger || 'auto').slice(0, 40),
            }, { requireOpen: true, staleAfterSeq: Number.isFinite(afterSeq) ? afterSeq : null });
        } catch (err) {
            // Resolved while the answer was written: the people are done with it.
            if (err?.code === 'THREAD_RESOLVED') return { stale: true };
            throw err;
        }
        if (!saved) return null;
        if (saved.stale || !saved.comment) return { stale: true };
        await emit(project.id, {
            kind: 'comment.created',
            actorId: null,
            targetType: 'comment_thread',
            targetId: thread.id,
            payload: {
                threadId: thread.id, commentId: saved.comment.id, seq: saved.comment.seq, authorKind: 'assistant',
                targetType: thread.targetType, targetId: thread.targetId,
            },
        });
        return { messageId: saved.comment.id };
    }

    return { lockType: LOCK_TYPE, loadContext, postAnswer };
}

let registered = false;

/** The participation engine, or null while it is not installed. */
function defaultEngine() {
    try {
        // @ts-ignore -- the engine ships with its own workstream; without it the surface stays unregistered
        return require('../participation');
    } catch (err) {
        log.debug(`[ProjectComments] participation engine not available: ${err && err.message}`);
        return null;
    }
}

/**
 * Register the comment surface with the engine, once per process. Returns
 * whether it is registered.
 *
 * @param {{ engine?: object|null, surface?: object }} [opts]
 */
function ensureCommentSurface({ engine, surface } = {}) {
    if (registered && !engine) return true;
    const target = engine === undefined ? defaultEngine() : engine;
    if (!target || typeof target.registerSurface !== 'function') return false;
    try {
        target.registerSurface(SURFACE, surface || makeCommentSurface());
        if (!engine) registered = true;
        return true;
    } catch (err) {
        log.warn(`[ProjectComments] comment surface not registered: ${err && err.message}`);
        return false;
    }
}

/**
 * Tell the engine a person commented in a thread in `auto` mode (`explicit`
 * when they asked the AI outright). Never throws: the comment is saved either
 * way, and a missed notice only means the AI stays quiet.
 *
 * @param {{ threadId: string, commentId: string, authorUserId: string, orgId: string|null,
 *           limitOrgId: string|null, projectId: string, explicit?: boolean }} p
 * @param {{ engine?: object|null }} [opts]
 * @returns {Promise<boolean>} whether the engine took it
 */
async function notifyHumanComment({ threadId, commentId, authorUserId, orgId, limitOrgId, projectId, explicit = false }, { engine } = {}) {
    const target = engine === undefined ? defaultEngine() : engine;
    if (!target || typeof target.onHumanMessage !== 'function') return false;
    if (engine === undefined && !ensureCommentSurface()) return false;
    try {
        await target.onHumanMessage({
            surface: SURFACE, containerId: threadId, messageId: commentId, authorUserId, orgId, limitOrgId, projectId, explicit,
        });
        return true;
    } catch (err) {
        log.warn(`[ProjectComments] participation notice failed for thread ${threadId}: ${err && err.message}`);
        return false;
    }
}

/**
 * Nothing stays queued for a thread that left `auto`, was resolved or was
 * deleted. Never throws.
 *
 * @param {string} threadId
 * @param {{ engine?: object|null }} [opts]
 */
async function cancelCommentThread(threadId, { engine } = {}) {
    const target = engine === undefined ? defaultEngine() : engine;
    if (!target || typeof target.cancelContainer !== 'function') return false;
    try {
        await target.cancelContainer(SURFACE, threadId);
        return true;
    } catch (err) {
        log.warn(`[ProjectComments] participation cancel failed for thread ${threadId}: ${err && err.message}`);
        return false;
    }
}

module.exports = {
    SURFACE,
    LOCK_TYPE,
    makeCommentSurface,
    ensureCommentSurface,
    notifyHumanComment,
    cancelCommentThread,
};
