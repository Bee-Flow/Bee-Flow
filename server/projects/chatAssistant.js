// @typecheck noImplicitAny
/**
 * The AI member of a team chat: when it answers, what it reads, and how its
 * answer gets back into the chat.
 *
 * ── When ────────────────────────────────────────────────────────────────────
 *
 * `decideAiTrigger` is the rule for explicit answers: a chat's `ai_mode` is
 * `off` (never), `always` (every human post), `mention` (the default: only
 * when the post asks — the "Ask AI" button, `@ai`, `@assistant`, or
 * `@<agent name>` when the chat has an agent the poster may use), or `auto`:
 * an explicit ask is answered as in `mention`, and every other post is handed
 * to the participation engine (projects/participation/), which decides by
 * itself, later, whether the AI joins. Its answers come back through this same
 * `requestReply` with an `auto_*` trigger.
 *
 * ── Automatic answers are different in four ways ─────────────────────────
 *
 *   - a short prompt: "you joined on your own because <reason>", about 120
 *     words, only the open question, and `[[SKIP]]` when there is nothing
 *     useful to add (the answer is then dropped);
 *   - stale-answer suppression: when a member posted after the conversation
 *     the gate read, the answer is dropped (checked under the chat row lock,
 *     see projectChatStore.appendMessage);
 *   - knowledge only from the bases EVERY project member may read, because
 *     nobody asked and the whole chat sees the answer;
 *   - silence: no `chat.ai.*` events, no error; the engine logs the outcome as
 *     a code in project_ai_decisions.
 *
 * The answer stores why the AI spoke (`ai_trigger`, and for an automatic
 * answer the gate's reason CODE), so the chat can say "Joined because …".
 *
 * ── One answer at a time ────────────────────────────────────────────────────
 *
 * `requestReply` claims the chat's turn in conversation_turn_locks (type
 * `project_chat`), the same lock shared threads use. An automatic answer that
 * finds it held gets `busy` and yields. An explicit ask (Ask AI, @ai, `always`)
 * is `queued` anyway and waits for the turn, polling for up to the longest answer
 * that could hold it, so it is never lost: an automatic answer still running is
 * dropped as stale by the member's post, and the ask is then answered. The claim, the subscription-limit check and the
 * model lookup happen before the route answers, so the poster learns at once
 * whether the AI is coming (`queued`) or why not (`skipped` + reason). The
 * answer itself is written in the background and announced on the live feed:
 * transient `chat.ai.started` / `chat.ai.finished {chatId, status}` and the
 * durable `chat.message.created` for the answer. The lock is released on every
 * path, and its lifetime outlasts the answer (for an explicit one the tool loop,
 * timeout x3), so a crashed process frees the chat on its own.
 *
 * ── What the model sees ─────────────────────────────────────────────────────
 *
 *   - the last CONTEXT_MESSAGES messages as a transcript, each line under the
 *     author's display name (never an e-mail address);
 *   - the project's name and custom instructions;
 *   - the chat's agent as a persona, ONLY when the asking member may use that
 *     agent (the rule an automation applies to its owner: owner, or published and
 *     shared with them — core/automationRunner/aiStepAgent.resolveStepAgent);
 *   - passages from the project's knowledge bases that the ASKING member may
 *     read (testAs.visibleKbIdsFor, context 'project_kb', plus the project's
 *     own files base via core/kb/projectFilesKb, then the direct-chat
 *     quickKBSearch path), stripped by the shield's own-server list.
 *
 * The transcript is the one user message, so the Privacy Shield passage
 * (chatShield.js) scans all of it. The model is the asking member's `fast`
 * tier (core/llm/modelResolver), called non-streaming with a timeout. Usage is
 * logged to usageStore like every other model call, as source `project_chat`.
 *
 * ── What never leaves ───────────────────────────────────────────────────────
 *
 * Events carry ids and a status, never content and never an error text: a
 * failure is `status:'failed'` (or `'blocked'` for the Privacy Shield), and the
 * reason goes to the server log only.
 *
 * Every external call is injectable through makeChatAssistant(deps).
 */

'use strict';

const crypto = require('crypto');
const log = require('../telemetry/log');
const { listProjectAudience, listChatAgents, isChatAgentAllowed } = require('./chatAudience');
const { makeChatShield } = require('./chatShield');
const { loadTaggedItems } = require('./chatTaggedItems');
const { resolveChatModel } = require('./chatModel');
const { writeAnswer: writeAnswerSteps } = require('./chatAnswerSteps');
const {
    CONTEXT_MESSAGES, ASSISTANT_NAME, AUTO_MAX_TOKENS, SKIP_SENTINEL, AUTO_TRIGGERS, TOOL_TIMEOUT_FACTOR,
    displayNameOf, buildTranscript, buildSystemPrompt, withTimeout, isSkip, num,
} = require('./chatPromptParts');
const { fallback } = require('../utils/bestEffort');
const { DEFAULT_TIMEOUT_MS, LOCK_MARGIN_MS, DEFAULT_LOCK_POLL_MS, EXPLICIT_TRIGGERS, mentionsAssistant, decideAiTrigger, resolveUsableAgent, searchProjectKnowledge } = require('./chatAssistantSearchProjectKnowledge');

// ── When ──────────────────────────────────────────────────────────────────

// ── Default collaborators ─────────────────────────────────────────────────


// ── The assistant ─────────────────────────────────────────────────────────

/**
 * Every dependency is a test seam whose default is the real module: the chat
 * store, the project's chat crypto, the turn locks, the shield
 * (makeChatShield()), the model call and the tool loop for the project tools,
 * the project tools themselves, the model and persona lookups, the knowledge
 * search, the tagged documents and notebooks the asker may read, the audience
 * of automatic answers, the user lookup, the limit check (error text or null),
 * the durable and the transient feed event, usage logging, `recordReply` (an
 * explicit answer, for the automatic cooldown) and `reasonText` (the gate's
 * reason in words, for the automatic prompt). `lockPollMs` is how often an
 * explicit ask waits-and-retries for a held turn, `lockWaitMs` how long it
 * waits at most (default: the longest answer that could hold the turn).
 *
 * @param {{
 *   store?: typeof import('../stores/projectChatStore'),
 *   chatCrypto?: { forProject: typeof import('./chatCrypto').forProject },
 *   locks?: typeof import('../stores/conversationLockStore'),
 *   shield?: import('./chatAnswerSteps').ChatShield,
 *   llmChat?: import('./chatAnswerSteps').AnswerCtx['llmChat'],
 *   runToolLoop?: import('./chatAnswerSteps').AnswerCtx['runToolLoop'],
 *   projectTools?: ReturnType<typeof import('./chatTools').makeProjectChatTools>,
 *   resolveModel?: typeof resolveChatModel,
 *   resolvePersona?: import('./chatAnswerSteps').AnswerCtx['resolvePersona'],
 *   searchKnowledge?: import('./chatAnswerSteps').AnswerCtx['searchKnowledge'],
 *   loadTagged?: import('./chatAnswerSteps').AnswerCtx['loadTagged'],
 *   listAudience?: import('./chatAnswerSteps').AnswerCtx['listAudience'],
 *   getUser?: typeof import('../stores/userStore').getUser,
 *   checkLimits?: (limitOrgId: string|null, userId: string) => Promise<string|null>,
 *   emit?: import('./chatAnswerSteps').AnswerCtx['emit'],
 *   publishTransient?: (projectId: string, event: Record<string, unknown>) => Promise<unknown>,
 *   logUsage?: import('./chatAnswerSteps').AnswerCtx['logUsage'],
 *   recordReply?: typeof import('../stores/projectAiParticipationStore').recordDecision,
 *   reasonText?: import('./chatAnswerSteps').AnswerCtx['reasonText'],
 *   timeoutMs?: number,
 *   lockPollMs?: number,
 *   lockWaitMs?: number,
 *   newId?: () => string }} [deps]
 */
function makeChatAssistant(deps = {}) {
    const store = () => deps.store || require('../stores/projectChatStore');
    const chatCrypto = () => deps.chatCrypto || require('./chatCrypto');
    const locks = () => deps.locks || require('../stores/conversationLockStore');
    const shield = deps.shield || makeChatShield();
    const runToolLoop = deps.runToolLoop || /** @type {typeof import('../core/llm/llmClient').runToolLoop} */ ((modelId, messages, tools, options, executeTool, maxRounds) => require('../core/llm/llmClient').runToolLoop(modelId, messages, tools, options, executeTool, maxRounds));
    const projectTools = () => deps.projectTools || (defaultTools || (defaultTools = require('./chatTools').makeProjectChatTools()));
    /** @type {ReturnType<typeof import('./chatTools').makeProjectChatTools>|null} */
    let defaultTools = null;
    const llmChat = deps.llmChat || /** @type {typeof import('../core/llm/llmClient').chat} */ ((modelId, messages, options) => require('../core/llm/llmClient').chat(modelId, messages, options));
    const resolveModel = deps.resolveModel || resolveChatModel;
    const resolvePersona = deps.resolvePersona || resolveUsableAgent;
    const searchKnowledge = deps.searchKnowledge || searchProjectKnowledge;
    const loadTagged = deps.loadTagged || loadTaggedItems;
    const listAudience = deps.listAudience || ((/** @type {{ id: string, ownerId?: string|null }} */ project) => listProjectAudience(project));
    const getUser = deps.getUser || ((/** @type {string} */ id) => require('../stores/userStore').getUser(id));
    const checkLimits = deps.checkLimits
        || ((/** @type {string|null} */ limitOrgId, /** @type {string} */ userId) => require('../core/entitlements/limits').checkSubscriptionLimits(limitOrgId, 'chat', userId));
    const emit = deps.emit
        || ((/** @type {string} */ projectId, /** @type {Parameters<typeof import('../core/projectFeed').emitProjectEvent>[1]} */ event) => require('../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectChat' }));
    const publishTransient = deps.publishTransient
        || ((/** @type {string} */ projectId, /** @type {Parameters<typeof import('../core/projectEventBus').publishTransient>[1]} */ event) => require('../core/projectEventBus').publishTransient(projectId, event));
    const logUsage = deps.logUsage || ((/** @type {Parameters<typeof import('../stores/usageStore').logUsage>[0]} */ entry) => require('../stores/usageStore').logUsage(entry));
    const recordReply = deps.recordReply
        || ((/** @type {Parameters<typeof import('../stores/projectAiParticipationStore').recordDecision>[0]} */ decision) => require('../stores/projectAiParticipationStore').recordDecision(decision));
    const reasonText = deps.reasonText || ((/** @type {string} */ reasonCode) => {
        const { REASON_TEXT } = require('./participation/relevanceGate');
        return /** @type {Readonly<Record<string, string>>} */ (REASON_TEXT)[reasonCode] || 'the conversation seemed to need you';
    });
    const timeoutMs = typeof deps.timeoutMs === 'number' && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
    const lockPollMs = typeof deps.lockPollMs === 'number' && Number.isFinite(deps.lockPollMs) && deps.lockPollMs > 0 ? deps.lockPollMs : DEFAULT_LOCK_POLL_MS;
    const lockWaitMs = typeof deps.lockWaitMs === 'number' && Number.isFinite(deps.lockWaitMs) && deps.lockWaitMs > 0 ? deps.lockWaitMs : timeoutMs * TOOL_TIMEOUT_FACTOR + LOCK_MARGIN_MS;
    const newId = deps.newId || (() => crypto.randomUUID());

    /**
     * Live-feed status, best-effort: a missed beat is a later refetch.
     * @param {string} projectId
     * @param {string} kind
     * @param {string} actorId
     * @param {string} chatId
     * @param {string} status
     */
    async function announce(projectId, kind, actorId, chatId, status) {
        try {
            await publishTransient(projectId, { kind, actorId, chatId, status, payload: { chatId, status } });
        } catch (err) {
            log.warn(`[ProjectChat] ${kind} not published: ${err && /** @type {Error} */ (err).message}`);
        }
    }

    /**
     * Author names for the transcript, one lookup per person.
     * @param {string[]} userIds
     * @returns {Promise<Map<string, string>>}
     */
    async function namesFor(userIds) {
        const names = new Map();
        for (const id of userIds) {
            let user = null;
            try { user = await getUser(id); } catch (_) { user = null; }
            names.set(id, displayNameOf(user));
        }
        return names;
    }

    /**
     * An explicit answer restarts the automatic cooldown; the log is a courtesy, never a blocker.
     * @param {{ project: { id: string, organizationId?: string|null }, chat: { id: string }, trigger: { id: string }, aiTrigger: string, messageId: string, orgId: string|null }} p
     */
    async function noteExplicitReply({ project, chat, trigger, aiTrigger, messageId, orgId }) {
        try {
            await recordReply({
                projectId: project.id,
                orgId: project.organizationId || orgId || null,
                surface: 'chat',
                containerId: chat.id,
                triggerMessageId: trigger.id,
                triggerKind: aiTrigger === 'always' ? 'always' : 'explicit',
                decision: 'replied',
                replyMessageId: messageId,
            });
        } catch (err) {
            log.warn(`[ProjectChat] reply in chat ${chat.id} not logged for the cooldown: ${err && /** @type {Error} */ (err).message}`);
        }
    }

    const answerCtx = {
        store, chatCrypto, locks, shield, runToolLoop, projectTools, llmChat, resolvePersona, searchKnowledge,
        loadTagged, listAudience, emit, logUsage, reasonText, timeoutMs, newId,
        announce, namesFor, noteExplicitReply,
    };
    /** @param {Parameters<typeof writeAnswerSteps>[1]} p */
    const writeAnswer = (p) => writeAnswerSteps(answerCtx, p);

    /**
     * Ask the assistant to answer `trigger` in `chat`.
     *
     * An explicit ask that finds the turn held is `queued` too: `done` waits for the turn
     * (and is `busy` only when it never came); an automatic answer is `busy` at once.
     *
     * `project` is the project row, `chat` the chat row, `trigger` the stored
     * message that asked and `triggerText` its plaintext; `userId` is the asking
     * member (for an automatic answer: the trigger's author), `orgId` their org
     * for tiers and the shield, `limitOrgId` their org for subscription limits.
     * `aiTrigger` is why the AI answers; `reasonCode` and `gateLastSeq` are the
     * gate's reason code and the last seq it read (automatic answers);
     * `modelTier` is the response depth the asker picked (explicit asks only).
     *
     * @param {{ project: import('./chatAnswerSteps').ProjectRef, chat: import('./chatAnswerSteps').ChatRef,
     *           trigger: import('./chatAnswerSteps').TriggerRef, triggerText: string, userId: string,
     *           orgId?: string|null, limitOrgId?: string|null, session?: unknown,
     *           aiTrigger?: 'ask'|'mention'|'always'|'auto_quiet'|'auto_unanswered',
     *           reasonCode?: string|null, gateLastSeq?: number|null, modelTier?: string|null }} p
     * @returns {Promise<{ status: 'queued'|'busy'|'skipped', reason?: string,
     *   done?: Promise<{ status: string, messageId?: string, reason?: string }> }>}
     */
    async function requestReply({
        project, chat, trigger, triggerText, userId, orgId = null, limitOrgId = null, session = null,
        aiTrigger = 'ask', reasonCode = null, gateLastSeq = null, modelTier = null,
    }) {
        const kind = [...EXPLICIT_TRIGGERS, ...AUTO_TRIGGERS].includes(aiTrigger) ? aiTrigger : 'ask';
        const auto = AUTO_TRIGGERS.includes(kind);
        try {
            const limitError = await checkLimits(limitOrgId, userId);
            if (limitError) return { status: 'skipped', reason: 'limit' };
        } catch (err) {
            log.warn(`[ProjectChat] limit check failed, not answering: ${err && /** @type {Error} */ (err).message}`);
            return { status: 'skipped', reason: 'unavailable' };
        }

        let model;
        try {
            model = await resolveModel({ userId, orgId, modelTier: auto ? null : modelTier, message: triggerText });
        } catch (err) {
            log.warn(`[ProjectChat] model lookup failed, not answering: ${err && /** @type {Error} */ (err).message}`);
            return { status: 'skipped', reason: 'unavailable' };
        }
        if (!model || !model.modelId) return { status: 'skipped', reason: 'no_model' };

        // Correlate the transient lock with its thread without retaining message text.
        const runId = `pc:${encodeURIComponent(trigger.threadId || '')}:${newId()}`;
        // An explicit answer may run the tool loop, so its lock outlasts that, not one model call.
        const ttlMs = timeoutMs * (auto ? 1 : TOOL_TIMEOUT_FACTOR) + LOCK_MARGIN_MS;
        const claimTurn = () => locks().acquireTurn({
            conversationId: chat.id,
            conversationType: 'project_chat',
            projectId: project.id,
            userId,
            runId,
            ttlMs,
        });
        let claim;
        try {
            claim = await claimTurn();
        } catch (err) {
            log.warn(`[ProjectChat] turn claim failed for chat ${chat.id}: ${err && /** @type {Error} */ (err).message}`);
            return { status: 'skipped', reason: 'unavailable' };
        }
        const write = () => writeAnswer({
            project, chat, trigger, triggerText, userId, orgId, session, model, runId,
            aiTrigger: kind, reasonCode: auto ? reasonCode : null, gateLastSeq: auto ? gateLastSeq : null,
        });
        if (!claim || !claim.acquired) {
            // An automatic answer nobody asked for just yields. Somebody who asked
            // outright waits for the turn (bounded by the longest answer): the running
            // answer finishes, or is dropped as stale, and then this one is written.
            if (auto) return { status: 'busy' };
            const done = (async () => {
                if (!(await waitForTurn(claimTurn))) return { status: 'busy' };
                await announce(project.id, 'chat.ai.started', userId, chat.id, 'running');
                return write();
            })();
            return { status: 'queued', done };
        }

        if (!auto) await announce(project.id, 'chat.ai.started', userId, chat.id, 'running');
        return { status: 'queued', done: write() };
    }

    /** Poll for a held turn until it is ours or the longest answer that could hold it has passed. */
    async function waitForTurn(/** @type {() => Promise<any>} */ claimTurn) {
        const deadline = Date.now() + lockWaitMs;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, lockPollMs));
            try {
                const claim = await claimTurn();
                if (claim && claim.acquired) return true;
            } catch (err) {
                log.warn(`[ProjectChat] waiting for the turn failed: ${err && /** @type {Error} */ (err).message}`);
                return false;
            }
        }
        return false;
    }

    /** @param {string} chatId */
    const getStatus = (chatId) => chatTurnStatus(locks(), chatId);
    return { requestReply, getStatus };
}

/**
 * Whether the assistant holds a chat's turn, and for which thread (read from
 * the lock's run id, `pc:<thread>:<id>`).
 * @param {typeof import('../stores/conversationLockStore')} lockStore
 * @param {string} chatId
 */
async function chatTurnStatus(lockStore, chatId) {
    const turn = await lockStore.getTurn(chatId);
    if (!turn) return { status: 'idle', threadId: /** @type {string|null} */ (null) };
    /** @type {string | null} */
    let threadId = null;
    if (turn.runId?.startsWith('pc:')) {
        try { threadId = decodeURIComponent(turn.runId.split(':')[1]) || null; } catch (err) { fallback('projects/chatAssistant:getStatus', err); /* older lock */ }
    }
    return { status: 'running', threadId, startedAt: turn.acquiredAt };
}

module.exports = {
    CONTEXT_MESSAGES,
    DEFAULT_TIMEOUT_MS,
    ASSISTANT_NAME,
    AUTO_MAX_TOKENS,
    SKIP_SENTINEL,
    AUTO_TRIGGERS,
    makeChatAssistant,
    listProjectAudience,
    listChatAgents,
    isChatAgentAllowed,
    isSkip,
    withTimeout,
    usageNumber: num,
    decideAiTrigger,
    mentionsAssistant,
    displayNameOf,
    resolveUsableAgent,
    resolveChatModel,
    searchProjectKnowledge,
    buildTranscript,
    buildSystemPrompt,
};
