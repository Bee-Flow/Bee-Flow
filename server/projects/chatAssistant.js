// @typecheck
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

const DEFAULT_TIMEOUT_MS = 90_000;
// The lock must outlive the call it guards, or a slow answer loses its turn.
const LOCK_MARGIN_MS = 30_000;
/** How often an explicit ask that found the turn held looks again. */
const DEFAULT_LOCK_POLL_MS = 1000;
const EXPLICIT_TRIGGERS = Object.freeze(['ask', 'mention', 'always']);

// ── When ──────────────────────────────────────────────────────────────────

/**
 * @param {string} s
 */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ASSISTANT_MENTION = /(^|[^\w@])@(ai|assistant)(?![\w-])/i;

/**
 * Does this text address the assistant?
 * @param {string} content
 * @param {string|null} [agentName]
 */
function mentionsAssistant(content, agentName = null) {
    const text = String(content || '');
    if (ASSISTANT_MENTION.test(text)) return true;
    const name = typeof agentName === 'string' ? agentName.trim() : '';
    if (!name) return false;
    return new RegExp(`(^|[^\\w@])@${escapeRegExp(name)}(?![\\w-])`, 'i').test(text);
}

// In Auto, an unambiguous direct address is an explicit request too. Do this
// before the delayed relevance gate and PII masking can mistake "AI" for a name.
/**
 * @param {string} content
 */
function addressesAssistant(content) {
    const text = String(content || '').trim();
    return /^(?:(?:hoi|hey|hi|hello|hallo|beste)\s+)?(?:ai|assistant|assistent)\s*(?:[,!:]|\b(?:(?:kun|kan|wil|zou)\s+(?:je|jij|u)|(?:can|could|would)\s+you|please|help)\b)/iu.test(text)
        || (/\b(?:je|jij|you)\b/iu.test(text) && /\b(?:ai|assistant|assistent)\s*[?？]$/iu.test(text));
}

/**
 * Does this post get an answer now, and why (`kind` is stored on the answer
 * as its `ai_trigger`)? In `auto` mode a post that does not ask is
 * `auto_pending`: the participation engine takes it from there.
 *
 * @param {{ aiMode: string, content: string, askAi?: boolean, agentName?: string|null }} p
 * @returns {{ trigger: true, kind: 'ask'|'mention'|'always' } | { trigger: false, reason: string }}
 */
function decideAiTrigger({ aiMode, content, askAi = false, agentName = null }) {
    if (aiMode === 'off') return { trigger: false, reason: 'ai_off' };
    if (aiMode === 'always') return { trigger: true, kind: 'always' };
    if (askAi === true) return { trigger: true, kind: 'ask' };
    if (mentionsAssistant(content, agentName)) return { trigger: true, kind: 'mention' };
    if (aiMode === 'auto' && addressesAssistant(content)) return { trigger: true, kind: 'ask' };
    if (aiMode === 'auto') return { trigger: false, reason: 'auto_pending' };
    return { trigger: false, reason: 'not_mentioned' };
}

// ── Default collaborators ─────────────────────────────────────────────────


/**
 * The agent behind a chat, as the ASKING member may use it, or null.
 * Owner: always. Anyone else: only a published agent of their organisation
 * that is shared with them (or with everyone there) and that serves a
 * published version — the rule core/automationRunner/aiStepAgent applies to a
 * automation's owner, reused rather than restated.
 *
 * @param {{ agentId: string, userId: string }} p
 * @param {{ getUser?: Function, resolveUserGroups?: Function, agentStore?: any }} [deps]
 * @returns {Promise<{ agentId: string, name: string, systemPrompt: string }|null>}
 */
async function resolveUsableAgent({ agentId, userId }, deps = {}) {
    if (!agentId || !userId) return null;
    const getUser = deps.getUser || ((/** @type {string} */ id) => require('../stores/userStore').getUser(id));
    const resolveUserGroups = deps.resolveUserGroups || ((/** @type {string} */ id) => require('../auth/audience').resolveUserGroups(id));
    /** @type {{ userId: string, userHomeOrgId: string|null, userGroupIds: string[], identityError: string|null }} */
    const ctx = { userId, userHomeOrgId: null, userGroupIds: [], identityError: null };
    try {
        const user = await getUser(userId);
        ctx.userHomeOrgId = user?.organizationId || null;
        ctx.userGroupIds = (await resolveUserGroups(userId)) || [];
    } catch (err) {
        // An identity we could not read is not a yes (only the owner branch,
        // which needs no identity, can still pass).
        ctx.identityError = /** @type {Error} */ (err)?.message || 'identity lookup failed';
    }
    try {
        const { resolveStepAgent } = require('../core/automationRunner/aiStepAgent');
        const binding = await resolveStepAgent({ agentId }, ctx, deps.agentStore ? { agentStore: deps.agentStore } : {});
        if (!binding) return null;
        return {
            agentId: binding.agentId,
            name: typeof binding.agent?.name === 'string' && binding.agent.name.trim() ? binding.agent.name.trim() : 'Agent',
            systemPrompt: binding.systemPrompt || '',
        };
    } catch (err) {
        if (err?.errorClass === 'agent_unavailable') return null;
        throw err;
    }
}

/**
 * Passages from the project's knowledge bases, as prompt text, or ''.
 *
 * A project chat or comment answer is read by the whole project, asked for
 * or not, so the callers pass the audience (`audienceIds`, from
 * listProjectAudience) and the project's linked bases are narrowed to what
 * EVERY member may read — the intersection, the asker included — before
 * anything is searched; an unknown audience (null) keeps no linked base at
 * all, because a passage one member may read must not reach the others
 * through the answer. Without `audienceIds` (undefined) the bases are
 * narrowed to what the asking member may read, as the agent path does: only
 * right for an answer that member alone will see. The project's own files base is
 * searchable by every member once it is verified to be this project's
 * (core/kb/projectFilesKb.js). The passages are stripped by the shield's
 * own-server list.
 *
 * A project with files but no linked base still has something to search, so
 * an empty `knowledgeBaseIds` is not a reason to stop here.
 *
 * @param {{ project: any, userId: string, query: string, session?: any|null, shield?: any|null,
 *           audienceIds?: string[]|null }} p
 * @param {{ visibleKbIdsFor?: Function, quickKBSearch?: Function, injectedPassagesPrompt?: Function, kbStore?: any }} [deps]
 */
async function searchProjectKnowledge({ project, userId, query, session = null, shield = null, audienceIds = undefined }, deps = {}) {
    if (!project || !query) return '';
    const visibleKbIdsFor = deps.visibleKbIdsFor || require('../core/agentRuntime/testAs').visibleKbIdsFor;
    const quickKBSearch = deps.quickKBSearch || require('../core/agentRuntime/knowledgeSearch').quickKBSearch;
    const injectedPassagesPrompt = deps.injectedPassagesPrompt || require('../core/privacy/toolPiiGate').injectedPassagesPrompt;
    const { searchableProjectKbIds } = require('../core/kb/projectFilesKb');
    /** @param {string[]} ids */
    const forEveryone = async (ids) => {
        if (!Array.isArray(audienceIds) || audienceIds.length === 0) return [];
        let kept = ids;
        for (const memberId of new Set([userId, ...audienceIds])) {
            if (kept.length === 0) break;
            const visible = new Set(await visibleKbIdsFor(kept, { userId: memberId, context: 'project_kb' }));
            kept = kept.filter((id) => visible.has(id));
        }
        return kept;
    };
    const kbIds = await searchableProjectKbIds(project, {
        filterAttached: audienceIds === undefined
            ? (ids) => visibleKbIdsFor(ids, { userId, context: 'project_kb' })
            : forEveryone,
        deps: deps.kbStore ? { kbStore: deps.kbStore } : {},
    });
    if (!kbIds || kbIds.length === 0) return '';
    const chunks = await quickKBSearch(userId, kbIds, query, { topK: 6, session: session || null });
    if (!chunks || chunks.length === 0) return '';
    return injectedPassagesPrompt(chunks, { shield, tag: 'ProjectChat' });
}

// ── The assistant ─────────────────────────────────────────────────────────

/**
 * @param {object} [deps]
 * @param {any}   [deps.store]            stores/projectChatStore surface
 * @param {any}   [deps.chatCrypto]       { forProject(project) }
 * @param {any}   [deps.locks]            { acquireTurn, releaseTurn }
 * @param {any}   [deps.shield]           makeChatShield() surface
 * @param {import('./chatAnswerSteps').AnswerCtx['llmChat']} [deps.llmChat]          (modelId, messages, options) => { content, usage }
 * @param {import('./chatAnswerSteps').AnswerCtx['runToolLoop']} [deps.runToolLoop]      (modelId, messages, tools, options, executeTool, maxRounds) => { content, usage }, for the project tools
 * @param {any}   [deps.projectTools]     projects/chatTools surface: offered, forAnswer
 * @param {typeof resolveChatModel} [deps.resolveModel]     ({userId, orgId}) => { modelId, options, providerConfig } | null
 * @param {import('./chatAnswerSteps').AnswerCtx['resolvePersona']} [deps.resolvePersona]   ({agentId, userId}) => { agentId, name, systemPrompt } | null
 * @param {import('./chatAnswerSteps').AnswerCtx['searchKnowledge']} [deps.searchKnowledge]  ({project, userId, query, session, shield, audienceIds?}) => string
 * @param {import('./chatAnswerSteps').AnswerCtx['loadTagged']} [deps.loadTagged]       (refs, {userId}) => [{kind, name, text}], the tagged documents and notebooks the asker may read
 * @param {import('./chatAnswerSteps').AnswerCtx['listAudience']} [deps.listAudience]     (project) => string[] | null, for automatic answers
 * @param {(id: string) => Promise<any>} [deps.getUser]          (id) => user row
 * @param {(limitOrgId: string|null, userId: string) => Promise<string|null>} [deps.checkLimits]      (limitOrgId, userId) => error text | null
 * @param {import('./chatAnswerSteps').AnswerCtx['emit']} [deps.emit]             (projectId, event) => durable event
 * @param {(projectId: string, event: object) => Promise<unknown>} [deps.publishTransient] (projectId, event) => transient event
 * @param {import('./chatAnswerSteps').AnswerCtx['logUsage']} [deps.logUsage]         (entry) => usage row
 * @param {(decision: object) => Promise<unknown>} [deps.recordReply]      (decision) => row: an explicit answer, for the automatic cooldown
 * @param {import('./chatAnswerSteps').AnswerCtx['reasonText']} [deps.reasonText]       (reasonCode) => the reason in words, for the automatic prompt
 * @param {number}   [deps.timeoutMs]
 * @param {number}   [deps.lockPollMs]       how often an explicit ask waits-and-retries for a held turn
 * @param {number}   [deps.lockWaitMs]       how long it waits at most (default: the longest answer that could hold the turn)
 * @param {() => string} [deps.newId]
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
    const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
    const lockPollMs = Number.isFinite(deps.lockPollMs) && deps.lockPollMs > 0 ? deps.lockPollMs : DEFAULT_LOCK_POLL_MS;
    const lockWaitMs = Number.isFinite(deps.lockWaitMs) && deps.lockWaitMs > 0 ? deps.lockWaitMs : timeoutMs * TOOL_TIMEOUT_FACTOR + LOCK_MARGIN_MS;
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
     * @param {object} p
     * @param {any} p.project       the project row (id, name, organizationId, customInstructions, knowledgeBaseIds)
     * @param {any} p.chat          the chat row (id, agentId)
     * @param {any} p.trigger       the stored message that asked (id)
     * @param {string} p.triggerText   its plaintext
     * @param {string} p.userId        the asking member (for an automatic answer: the trigger's author)
     * @param {string|null} [p.orgId]  their org for tiers and the shield
     * @param {string|null} [p.limitOrgId] their org for subscription limits
     * @param {any|null} [p.session]
     * @param {'ask'|'mention'|'always'|'auto_quiet'|'auto_unanswered'} [p.aiTrigger]  why the AI answers
     * @param {string|null} [p.reasonCode]   the gate's reason code (automatic answers)
     * @param {number|null} [p.gateLastSeq]  the last seq the gate read (automatic answers)
     * @param {string|null} [p.modelTier]  the response depth the asker picked (explicit asks only)
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
    async function getStatus(chatId) {
        const turn = await locks().getTurn(chatId);
        if (!turn) return { status: 'idle', threadId: /** @type {string|null} */ (null) };
        /** @type {string | null} */
        let threadId = null;
        if (turn.runId?.startsWith('pc:')) {
            try { threadId = decodeURIComponent(turn.runId.split(':')[1]) || null; } catch (err) { fallback('projects/chatAssistant:getStatus', err); /* older lock */ }
        }
        return { status: 'running', threadId, startedAt: turn.acquiredAt };
    }
    return { requestReply, getStatus };
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
