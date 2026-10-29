// @typecheck
'use strict';

/**
 * The steps of one project-chat answer (chatAssistant.js writeAnswer): read
 * the conversation, gather knowledge and tagged items, ask the model, record
 * the usage, store and announce the answer. Each step takes the collaborators
 * makeChatAssistant resolved (`ctx`) and the values it reads, and returns
 * what it produces; the order of the awaits is writeAnswer's.
 */

const log = require('../telemetry/log');
const { usageLogFields } = require('../core/providers/usageNormalizer');
const { taggedItemsBlock, TAGGED_TOTAL_CHARS, TAGGED_ITEM_CHARS } = require('./chatTaggedItems');
const { answerRecord } = require('./chatTrace');
const { answerWithTools, toolsPrompt, TOOL_MAX_TOKENS } = require('./chatToolRun');
const {
    CONTEXT_MESSAGES, ASSISTANT_NAME, AUTO_TRIGGERS, AUTO_MAX_TOKENS, ANSWER_CHARS, TOOL_TIMEOUT_FACTOR,
    buildTranscript, buildSystemPrompt, withTimeout, isSkip,
} = require('./chatPromptParts');

/** The chat's readable messages as transcript lines, with the persona and the crypto box. */
async function readConversation(ctx, { chat, trigger, triggerText, userId, project }) {
    const box = await ctx.chatCrypto().forProject(project);
    const persona = chat.agentId
        ? await ctx.resolvePersona({ agentId: chat.agentId, userId }).catch((err) => {
            log.warn(`[ProjectChat] agent persona unavailable for chat ${chat.id}: ${err && err.message}`);
            return null;
        })
        : null;

    // A thread is its own conversation: its root and replies, loaded by
    // root so an old thread keeps its root. The main conversation leaves
    // the thread replies out.
    const threadId = trigger.threadId || null;
    const { messages: recent } = await ctx.store().listMessages(chat.id, { limit: CONTEXT_MESSAGES, threadId });
    const messages = recent.filter((m) => (threadId ? m.id === threadId || m.threadId === threadId : !m.threadId));
    const visible = [];
    for (const m of messages) {
        // A notice ("the AI now joins on its own") is not conversation.
        if (m.deletedAt || m.authorKind === 'system') continue;
        try {
            visible.push({ m, text: box.openContent(chat.id, m.id, m.content) });
        } catch (err) {
            // An unreadable message is left out of the context, loudly.
            log.error(`[ProjectChat] message ${m.id} in chat ${chat.id} could not be decrypted: ${err && err.code}`);
        }
    }
    const authors = visible.filter((v) => v.m.authorKind === 'user').map((v) => v.m.authorUserId);
    const names = await ctx.namesFor([...new Set([userId, ...authors])]);
    const askerName = names.get(userId) || 'A project member';
    const assistantName = persona ? persona.name : ASSISTANT_NAME;
    const lines = visible.map((v) => ({
        author: v.m.authorKind === 'assistant' ? assistantName : names.get(v.m.authorUserId) || 'A project member',
        text: v.text,
    }));
    // The question is always in the context, even when it has scrolled
    // past the window or was removed while the answer was queued.
    if (!visible.some((v) => v.m.id === trigger.id)) lines.push({ author: askerName, text: triggerText });
    return { box, persona, threadId, lines, askerName };
}

/** The project knowledge passages for the question; '' when the search fails. */
async function searchKnowledgeFor(ctx, { project, chat, userId, triggerText, session, shieldConfig }) {
    let knowledge = '';
    try {
        // Asked for or not, the answer is read by the whole chat, so the
        // bases are cut to what EVERY member may read (null audience:
        // none of the linked bases), never to what the asker alone may.
        const audienceIds = await ctx.listAudience(project);
        knowledge = await ctx.searchKnowledge({
            project, userId, query: triggerText, session, shield: shieldConfig, audienceIds,
        }) || '';
    } catch (err) {
        log.warn(`[ProjectChat] project knowledge search failed for chat ${chat.id}: ${err && /** @type {Error} */ (err).message}`);
    }
    return knowledge;
}

/** The tagged documents and notebooks as a prompt block, with the sources that fit the budget. */
async function loadTaggedSources(ctx, { auto, trigger, userId, project }) {
    // Automatic answers reach everyone and were never asked for: they
    // read the conversation only, not what a member tagged.
    const loadedItems = !auto && Array.isArray(trigger.refs) && trigger.refs.length
        ? await ctx.loadTagged(trigger.refs, { userId, project }) : [];
    const tagged = taggedItemsBlock(loadedItems);
    let sourceBudget = TAGGED_TOTAL_CHARS;
    const usedSources = [];
    for (const item of loadedItems) {
        if (sourceBudget <= 0) break;
        const cap = Math.min(TAGGED_ITEM_CHARS, sourceBudget);
        sourceBudget -= item.text.length > cap ? cap + 2 : item.text.length;
        if (item.id) usedSources.push({ kind: item.kind, id: item.id });
    }
    return { tagged, usedSources };
}

/** The system prompt, the model options and the two messages of the call. */
function buildModelCall(ctx, { project, persona, knowledge, outbound, definitions, auto, reasonCode, model }) {
    const system = buildSystemPrompt({
        project,
        persona,
        knowledge,
        tokenAddendum: ctx.shield.tokenAddendum(outbound.tokenMap),
        auto: auto ? { reasonText: ctx.reasonText(reasonCode) } : null,
    }) + (definitions.length ? `\n\n${toolsPrompt(definitions)}` : '');

    const options = { ...(model.options || {}), timeoutMs: ctx.timeoutMs };
    if (auto) options.maxTokens = Math.min(Number(options.maxTokens) || AUTO_MAX_TOKENS, AUTO_MAX_TOKENS);
    // A whole styled document is written inside one tool call: it needs room to be written.
    if (definitions.length) options.maxTokens = Math.max(Number(options.maxTokens) || 0, TOOL_MAX_TOKENS);
    const messagesOut = [
        { role: 'system', content: system },
        { role: 'user', content: outbound.text },
    ];
    return { options, messagesOut };
}

/** Call the model (the tool loop when tools are offered); returns the result and what the tools made. */
async function askModel(ctx, {
    definitions, model, messagesOut, options, outbound, shieldConfig, project, userId, orgId, session, persona, chat,
}) {
    let made = [];
    // withTimeout cannot stop the tool loop: once the answer is given up
    // on, a late tool call must not make anything nobody will be told about.
    let givenUp = false;
    const tools = ctx.projectTools();
    const guardedTools = {
        ...tools,
        forAnswer: (/** @type {Parameters<typeof tools.forAnswer>[0]} */ a) => {
            const run = tools.forAnswer(a);
            return {
                get created() { return run.created; },
                execute: async (/** @type {string} */ name, /** @type {Parameters<ReturnType<typeof tools.forAnswer>['execute']>[1]} */ args) => (givenUp
                    ? JSON.stringify({ ok: false, error: 'This answer was given up on; nothing more can be made.' })
                    : run.execute(name, args)),
            };
        },
    };
    const result = await withTimeout(definitions.length
        ? answerWithTools({
            tools: guardedTools, definitions, runToolLoop: ctx.runToolLoop, shield: ctx.shield, shieldConfig, project, userId, orgId, session,
            modelId: model.modelId, messages: messagesOut, options, tokenMap: outbound.tokenMap,
            auditBase: { conversation_id: chat.id, model: model.modelId, agent_id: persona?.agentId || null },
        }).then((r) => { made = r.created; return r.result; })
        : Promise.resolve(ctx.llmChat(model.modelId, messagesOut, options)),
    ctx.timeoutMs * (definitions.length ? TOOL_TIMEOUT_FACTOR : 1)).catch((err) => { givenUp = true; throw err; });
    return { result, made };
}

/** Log the usage row; a failure is logged and never blocks the answer. */
async function recordUsage(ctx, { result, userId, orgId, persona, model, auto, started, chat }) {
    try {
        const usage = result?.usage || {};
        await ctx.logUsage({
            user_id: userId,
            organization_id: orgId || null,
            agent_id: persona?.agentId || null,
            agent_name: 'project-chat',
            agent_type: 'chat',
            model: model.modelId,
            ...usageLogFields(usage),
            stop_reason: result?.stop_reason || null,
            source: auto ? 'project_chat_auto' : 'project_chat',
            duration_ms: Date.now() - started,
            conversation_id: chat.id,
        });
    } catch (err) {
        log.warn(`[ProjectChat] usage logging failed: ${err && /** @type {Error} */ (err).message}`);
    }
}

/**
 * Store the answer and announce it. Returns the outcome: 'skipped' (the model
 * had nothing to add), 'stale' (a member spoke after the gate read), or
 * 'answered'.
 * @returns {Promise<{ status: 'answered'|'failed'|'blocked'|'skipped'|'stale', messageId?: string, reason?: string }>}
 */
async function storeAnswer(ctx, {
    result, made, auto, model, outbound, triggerText, box, chat, project, persona, trigger, threadId,
    usedSources, aiTrigger, reasonCode, gateLastSeq, userId, orgId,
}) {
    let answer = typeof result?.content === 'string' ? result.content.trim() : '';
    if (auto && isSkip(answer)) {
        return { status: 'skipped', reason: 'skip_sentinel' };
    }
    // A model that made something and said nothing still leaves a line saying what.
    if (!answer && made.length) answer = made.map((m) => `“${m.name}”`).join(', ');
    if (!answer) throw Object.assign(new Error('The model returned an empty answer'), { code: 'AI_EMPTY' });
    const rawAnswer = answer;
    answer = ctx.shield.restore(answer, outbound.tokenMap);
    if (answer.length > ANSWER_CHARS) answer = `${answer.slice(0, ANSWER_CHARS)} …`;

    const messageId = ctx.newId();
    const { aiMeta, aiTrace } = answerRecord({ model, outbound, triggerText, rawAnswer, box, chatId: chat.id, messageId });
    if (usedSources.length) /** @type {Record<string, any>} */ (aiMeta).usedSources = usedSources;
    const saved = await ctx.store().appendMessage({
        id: messageId,
        projectId: project.id,
        chatId: chat.id,
        authorKind: 'assistant',
        agentId: persona?.agentId || null,
        content: box.sealContent(chat.id, messageId, answer),
        replyTo: trigger.id,
        threadId: threadId,
        aiMeta,
        aiTrace,
        refs: made.filter((m) => m.kind === 'document' || m.kind === 'notebook').map(({ kind, id }) => ({ kind, id })),
        aiTrigger,
        aiReason: auto ? reasonCode || null : null,
        unlessHumanAfterSeq: auto && Number.isFinite(gateLastSeq) ? gateLastSeq : null,
    });
    if (!saved) throw Object.assign(new Error('The chat no longer exists'), { code: 'CHAT_GONE' });
    if (saved.stale) {
        // A member spoke after the conversation the gate read: the
        // answer may be to a question already moved past. Dropped.
        return { status: 'stale' };
    }
    await ctx.emit(project.id, {
        kind: 'chat.message.created',
        actorId: userId,
        targetType: 'project_chat',
        targetId: chat.id,
        payload: { chatId: chat.id, messageId: saved.message.id, seq: saved.message.seq, authorKind: 'assistant' },
    });
    if (!auto) await ctx.noteExplicitReply({ project, chat, trigger, aiTrigger, messageId: saved.message.id, orgId });
    return { status: 'answered', messageId: saved.message.id };
}

/**
 * @returns {Promise<{ status: 'answered'|'failed'|'blocked'|'skipped'|'stale', messageId?: string, reason?: string }>}
 */
async function writeAnswer(ctx, { project, chat, trigger, triggerText, userId, orgId, session, model, runId, aiTrigger, reasonCode, gateLastSeq }) {
    const { shield } = ctx;
    const auto = AUTO_TRIGGERS.includes(aiTrigger);
    const dlpConversationId = `project-chat-${chat.id}-${runId}`;
    /** @type {{ status: 'answered'|'failed'|'blocked'|'skipped'|'stale', messageId?: string, reason?: string }} */
    let outcome = { status: 'failed' };
    try {
        const { box, persona, threadId, lines, askerName } = await readConversation(ctx, { chat, trigger, triggerText, userId, project });
        const shieldConfig = await shield.resolve({ orgId, userId });
        const knowledge = await searchKnowledgeFor(ctx, { project, chat, userId, triggerText, session, shieldConfig });
        const { tagged, usedSources } = await loadTaggedSources(ctx, { auto, trigger, userId, project });
        const outbound = await shield.protect({
            shield: shieldConfig,
            orgId,
            userId,
            text: tagged + buildTranscript(lines, { askerName, persona, auto }),
            conversationId: dlpConversationId,
            providerConfig: model.providerConfig || {},
            auditBase: { conversation_id: chat.id, model: model.modelId, agent_id: persona?.agentId || null },
        });
        // Only an explicit ask may do things: an automatic answer nobody asked for is offered no tools.
        const definitions = auto ? [] : await ctx.projectTools().offered({ project, userId, orgId, session });
        const { options, messagesOut } = buildModelCall(ctx, { project, persona, knowledge, outbound, definitions, auto, reasonCode, model });
        const started = Date.now();
        const { result, made } = await askModel(ctx, {
            definitions, model, messagesOut, options, outbound, shieldConfig, project, userId, orgId, session, persona, chat,
        });
        await recordUsage(ctx, { result, userId, orgId, persona, model, auto, started, chat });
        outcome = await storeAnswer(ctx, {
            result, made, auto, model, outbound, triggerText, box, chat, project, persona, trigger, threadId,
            usedSources, aiTrigger, reasonCode, gateLastSeq, userId, orgId,
        });
    } catch (err) {
        outcome = { status: err?.code === 'PRIVACY_BLOCKED' ? 'blocked' : 'failed' };
        // The reason stays here, in the server log; the feed only says the status.
        log.warn(`[ProjectChat] answer in chat ${chat.id} (run ${runId}${auto ? ', automatic' : ''}) ${outcome.status}: ${err?.code || /** @type {Error} */ (err)?.name || 'error'}: ${err && /** @type {Error} */ (err).message}`);
    } finally {
        try {
            await ctx.locks().releaseTurn({ conversationId: chat.id, runId });
        } catch (err) {
            log.warn(`[ProjectChat] turn release failed for chat ${chat.id}; it expires on its own: ${err && /** @type {Error} */ (err).message}`);
        }
        shield.release(dlpConversationId);
        // Automatic answers are silent: the answer appears, or nothing does.
        if (!auto) await ctx.announce(project.id, 'chat.ai.finished', userId, chat.id, outcome.status);
    }
    return outcome;
}

module.exports = { writeAnswer };

/** @typedef {ReturnType<typeof import('./chatShield').makeChatShield>} ChatShield */

/** @typedef {Exclude<Awaited<ReturnType<typeof import('../stores/projectChatStore').appendMessage>>, { stale: true }>} AppendedMessage  an append that was not dropped as stale */

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../stores/projectStore').getProject>>>} ProjectRef  the project row */

/** @typedef {{ id: string, agentId?: string|null }} ChatRef */

/** @typedef {{ id: string, threadId?: string|null, refs?: unknown[] }} TriggerRef */

/** @typedef {{ agentId: string, name: string, systemPrompt: string }} Persona */

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('./chatModel').resolveChatModel>>>} ChatModel */

/** @typedef {Awaited<ReturnType<typeof import('./chatCrypto').forProject>>} ChatBox */

/** @typedef {Awaited<ReturnType<ChatShield['protect']>>} Outbound */

/** @typedef {Awaited<ReturnType<ChatShield['resolve']>>} ShieldConfig */

/**
 * The collaborators makeChatAssistant resolved (chatAssistant.js `answerCtx`).
 * @typedef {{
 *   store: () => typeof import('../stores/projectChatStore'),
 *   chatCrypto: () => { forProject: typeof import('./chatCrypto').forProject },
 *   locks: () => typeof import('../stores/conversationLockStore'),
 *   shield: ChatShield,
 *   runToolLoop: typeof import('../core/llm/llmClient').runToolLoop,
 *   projectTools: () => ReturnType<typeof import('./chatTools').makeProjectChatTools>,
 *   llmChat: typeof import('../core/llm/llmClient').chat,
 *   resolvePersona: (p: { agentId: string, userId: string }) => Promise<Persona|null>,
 *   searchKnowledge: (p: { project: ProjectRef, userId: string, query: string, session?: any|null, shield?: ShieldConfig|null, audienceIds?: string[]|null }) => Promise<string>,
 *   loadTagged: (refs: unknown[], opts: { userId: string, project: ProjectRef }) => Promise<Array<{ kind: string, id?: string, name: string, text: string }>>,
 *   listAudience: (project: ProjectRef) => Promise<string[]|null>,
 *   emit: (projectId: string, event: { kind: string, actorId?: string|null, targetType?: string, targetId?: string, payload?: object }) => Promise<unknown>,
 *   logUsage: (entry: Record<string, unknown>) => Promise<unknown>,
 *   reasonText: (reasonCode: string|null) => string,
 *   timeoutMs: number,
 *   newId: () => string,
 *   announce: (projectId: string, kind: string, actorId: string, chatId: string, status: string) => Promise<void>,
 *   namesFor: (userIds: string[]) => Promise<Map<string, string>>,
 *   noteExplicitReply: (p: { project: ProjectRef, chat: ChatRef, trigger: TriggerRef, aiTrigger: string, messageId: string, orgId: string|null }) => Promise<void> }} AnswerCtx
 */
