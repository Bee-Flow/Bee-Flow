// @typecheck
const express = require('express');
const agentStore = require('../../stores/agentStore');
const agentRuntime = require('../../core/agentRuntime');
const { getAIConfig } = require('../../core/aiAgent');
const { fetchConfiguredEndpoint } = require('../../core/http/configuredEndpointFetch');
require('../../stores/configStore');
const { requireAuth } = require('../../auth');
require('../../stores/memoryStore');
const { resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId, getUserAuth } = require('../../utils/routeHelpers');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');

// LLM-backed helper endpoints (title generation, building description) are
// gated to prevent unauthenticated cost blow-up. Stream chat has its own
// concurrency cap below.
const helperLimiter = perUserRateLimit({ windowMs: 60_000, max: 30 });
const streamLimiter = perUserRateLimit({ windowMs: 60_000, max: 60 });
// The embed metadata endpoint is public — without rate limiting an attacker
// can enumerate agent IDs by scanning UUID prefixes. 100/min/IP is high
// enough that any legitimate embed (one page-load = one call) stays well
// under the limit while still bounding crawl rates.
const embedLimiter = perUserRateLimit({ windowMs: 60_000, max: 100 });

require('../../stores/usageStore');
const { checkSubscriptionLimits: checkSubLimits } = require('../../core/entitlements/limits');
const { setupSSE, sendSSEError } = require('../../core/http/sseHelpers');
const { storedFlag, FLAG_DEFAULTS } = require('../../usecases/agents/storedFlag');

const router = express.Router();
const { validate } = require('../../core/http/validate');
// What a caller may send, and why each key is typed the way it is: ./chatSchema.js.
const { TurnBody, PlainTurnBody, TitleBody, DescribeBody } = require('./chatSchema');
const { fallback } = require('../../utils/bestEffort');
const incognitoRules = require('../../core/conversation/incognito.mts');
// Who may take a turn with an agent (auth/agentAccess.mts): the chat gate in
// front of the turn and history routes, the edit rule behind "Test as".
const { requireAgentChat, canModifyAgent } = require('./crud');
const { agentAccessOf } = require('../../auth/agentAccess.mts');

// ============ Chat ============

// Chat with agent. The audience is re-read on every turn by the gate, so a
// revoked group or organisation takes effect at once.
router.post('/:id/chat', requireAgentChat(), validate({ body: PlainTurnBody }), async (req, res) => {
    const { userId } = agentAccessOf(req);
    const { message } = req.body;

    // ── Subscription limit enforcement ──
    // Mirrors the /chat/stream gate at line 213 so the legacy non-streaming
    // endpoint can't be used to bypass monthly message/token/cost caps.
    {
        const orgIds = await resolveUserOrgIds(req);
        const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const limitError = await checkSubLimits(orgId, 'chat', userId);
        if (limitError) {
            return res.status(402).json({ error: limitError });
        }
    }

    const userAuth = await getUserAuth(req);
    const result = await agentRuntime.chatWithAgent(
        req.params.id,
        userId,
        message,
        userAuth
    );
    res.json(result);
});

// ============ Embeddable Chat Widget ============

// Get agent metadata for embed widget (no auth required — public endpoint).
// Rate-limited to slow down ID enumeration; returns 404 on both "not found"
// and "exists but not embeddable" so the response shape doesn't leak which
// agent IDs exist.
router.get('/:id/embed', embedLimiter, async (req, res) => {
    // Embed is a consumer surface → the runtime projection (A1 concept/live).
    const agent = await agentStore.getForRuntime(req.params.id);

    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // For regular agents: must be published AND embed_enabled. Return 404
    // (not 403) so an attacker probing IDs can't distinguish "exists but
    // hidden" from "doesn't exist".
    if (!agent.is_published || !agent.embed_enabled) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Parse starter_prompts
    let starterPrompts = [];
    try {
        starterPrompts = typeof agent.starter_prompts === 'string'
            ? JSON.parse(agent.starter_prompts)
            : (agent.starter_prompts || []);
    } catch (e) { fallback('routes/agents/chat:anon', e); /* starter prompts are not valid JSON, show none */ }

    return res.json({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        avatar: agent.avatar,
        starterPrompts: starterPrompts.filter(p => p && p.trim()),
        // The owner's choice lives in two places. The agent editor ("Allow
        // copying", BuilderSplit) keeps it in `config.allowCopy` and never
        // writes the column; the older designer writes `copy_enabled`. The
        // in-app chat honours the config key (MessageItem), so either one
        // saying no is a no here. And not `copy_enabled !== 0`: Postgres
        // returns false, and `false !== 0` read an OFF column as on.
        copyEnabled: storedFlag(agent.copy_enabled, FLAG_DEFAULTS.copy_enabled)
            && agent.config?.allowCopy !== false,
        // What the page tells a website visitor about chat signals: state,
        // start date, version, signals and the org's own https notice. No ids,
        // no org name (core/privacy/chatSignalsNotice.embedNotice).
        complianceNotice: await embedComplianceNotice(agent),
        isSwarm: false
    });
});

/**
 * The embed's chat-signals notice, from the resolver for the AGENT's
 * organisation (the org a visitor's turn counts under). An agent without an
 * organisation is never counted, so nothing is announced for it. Never throws:
 * a failure reads off, and an unannounced turn is not counted either.
 */
async function embedComplianceNotice(agent) {
    const notice = require('../../core/privacy/chatSignalsNotice');
    const orgId = typeof agent?.organization_id === 'string' && agent.organization_id ? agent.organization_id : null;
    if (!orgId) return notice.EMBED_OFF;
    try {
        const mon = await require('../../core/entitlements/chatMonitoringFlag').resolveChatMonitoring(orgId);
        return notice.embedNotice(mon);
    } catch (_) {
        return notice.EMBED_OFF;
    }
}

// ── Subscription limit enforcement (uses shared module) ──────────────────────
const checkSubscriptionLimits = checkSubLimits;

// Streaming chat with agent (SSE). The chat gate re-reads the audience on
// every turn (membership from the database, not the session), so a revoked
// permission takes effect even for someone who already has the agent open.
router.post('/:id/chat/stream', streamLimiter, requireAgentChat(), validate({ body: TurnBody }), async (req, res) => {
    // Incognito: refused combinations are a 400 before anything is read; the
    // turn becomes ephemeral and memory is switched off on the request itself.
    incognitoRules.assertIncognitoRequest(req.body, 'agent');
    incognitoRules.applyIncognitoPolicy(req.body, 'agent');
    const { agent } = agentAccessOf(req);

    const { message, history, messageId, parentId, attachments, conversationId, ephemeral, modelTier, activeSkillIds, reasoningEffort } = req.body;

    const userId = getEffectiveUserId(req);

    // ── Subscription limit enforcement ──
    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const agentType = 'chat';
    const limitError = await checkSubscriptionLimits(orgId, agentType, userId);
    if (limitError) {
        sendSSEError(res, limitError);
        return;
    }

    /**
     * "Test als \u00b7 groep X" (A1c) — the editor's preview of somebody else's
     * view. Three things about this block, all deliberate:
     *
     *   • It runs BEFORE the SSE headers, so a group that cannot be resolved
     *     comes back as an ordinary JSON error rather than a stream that has
     *     to explain itself halfway through.
     *   • It is gated on the EDIT right, not on the chat right. Simulating
     *     only ever takes knowledge away, so a chatter could not gain
     *     anything — but the affordance belongs to whoever is building the
     *     agent, and asking `canModifyAgent` costs one read on the one
     *     request in a thousand that carries `asGroup`.
     *   • It forces the turn EPHEMERAL. A narrowed answer stored in the
     *     agent's real history would later read as what the agent said to
     *     this person, and would count as a conversation in the usage tab.
     */
    // `test: true` (A4) and `asGroup` (A1c) are two halves of the same
    // affordance and BOTH belong to whoever may edit the agent, so the edit
    // right is resolved ONCE here rather than twice below. A test chat is the
    // stronger of the two: it serves the UNPUBLISHED concept, which is
    // work-in-progress that a chatter has no business reading.
    const testChatMod = require('../../core/agentRuntime/testChat');
    const wantsTest = testChatMod.wantsTestChat(req.body);
    let testAs = null;
    let isTestChat = false;
    if (wantsTest || req.body?.asGroup) {
        let canEdit = false;
        try {
            canEdit = await canModifyAgent(agent, userId, req);
        } catch (e) {
            // An edit check that could not run is not permission to simulate.
            log.error('[AgentChat] test-mode edit check failed:', /** @type {Error} */ (e).message);
            // One failed check refuses BOTH affordances when both have been
            // requested. `code` remains the strongest (a test chat serves the draft), but
            // `codes` names every refused affordance — otherwise a client that handles
            // the A1c contract (`test_as_check_failed`) misses precisely the case in which
            // it ALSO sent `test: true`.
            /** @type {string[]} */
            const _refused = [];
            if (wantsTest) _refused.push(testChatMod.TEST_CHAT_CODES.checkFailed);
            if (req.body?.asGroup) _refused.push('test_as_check_failed');
            throw new HttpError(503, _refused[0] || 'test_as_check_failed',
                'Could not check your permissions right now. Try again.', { codes: _refused });
        }
        const testGate = /** @type {Record<string, any>} */ (testChatMod.gateTestChatRequest({ test: req.body?.test, canEdit }));
        if (!testGate.ok) return res.status(testGate.status).json({ error: testGate.error, code: testGate.code });
        isTestChat = testGate.testChat;

        // "Test als" keeps its own module and its own refusals — A4 rides the
        // A1c path, it does not grow a second one beside it.
        const testAsMod = require('../../core/agentRuntime/testAs');
        const gated = /** @type {Record<string, any>} */ (await testAsMod.gateTestAsRequest({
            asGroup: req.body.asGroup, userId, orgIds, canEdit,
        }));
        if (!gated.ok) return res.status(gated.status).json({ error: gated.error, code: gated.code });
        testAs = gated.testAs;
    }
    // A preview is always ephemeral, and so is a test chat — for the same
    // reason and one more. A narrowed or concept-driven answer stored in the
    // agent's real history would later read as what the agent said to somebody,
    // and it would count as a conversation in the usage tab, the card footer
    // and every history list. Writing no row is what makes a test conversation
    // mean the SAME thing in all of them: it is not there.
    // An ordinary turn keeps the exact value the client sent (undefined
    // included — several readers treat it as a tri-state).
    const isEphemeral = (testAs || isTestChat) ? true : ephemeral;

    // Set up SSE
    const { sendEvent, abortController, markEnded } = setupSSE(res);

    try {
        const userAuth = await getUserAuth(req);

        const result = await agentRuntime.chatWithAgentStream(
            req.params.id,
            userId,
            message,
            userAuth,
            // Callback for streaming events
            (type, data) => {
                sendEvent(type, data);
            },
            // Custom history override for thread context isolation
            history,
            // Message metadata for persistence (id, parentId, attachments, and conversationId)
            { messageId, parentId, attachments, conversationId, ephemeral: isEphemeral, ephemeralKey: testChatMod.normaliseSessionKey(req.body.testSessionId), testAs, testChat: isTestChat, toolDecisions: isTestChat ? testChatMod.normaliseToolDecisions(req.body.toolDecisions) : undefined, notebookspaceContent: req.body.notebookspaceContent, notebookspaceSelection: req.body.notebookspaceSelection, notebookspaceAvailable: req.body.notebookspaceAvailable, sidePanelWebpage: req.body.sidePanelWebpage, sidePanelDocument: req.body.sidePanelDocument, signal: abortController.signal, userOrgId: userAuth.userOrgId, timezone: req.body.timezone, projectId: req.body.projectId, modelTier, activeSkillIds, orgId, reasoningEffort, memoryWriteEnabled: req.body.memoryWriteEnabled, memoryReadEnabled: req.body.memoryReadEnabled, webSearchEnabled: req.body.webSearchEnabled,
                // Chat signals: the marker and the switch, read by the turn
                // preflight's recorder call (chatStream/turnPreflight.js).
                chatSignals: { notice: typeof req.body.chatSignalsNotice === 'string' ? req.body.chatSignalsNotice : null, optOut: req.body.chatSignalsOptOut === true },
                // The runtime withholds the memory and notebook tools (toolStackAssembly.narrowToolsForTurn).
                incognito: incognitoRules.isIncognito(req.body) }
        );

        // Skip all post-stream persistence for ephemeral embed chats — and for
        // a "Test as" preview, which is ephemeral for the same reason.
        if (!isEphemeral) {
            const conv = await agentStore.getConversationById(result.conversationId, req.session?.encryptionKey);

            // Generate/update title:
            // 1. If it's still "New Chat" (and we have at least 1 exchange), generate it immediately.
            //    This handles cases where tool calls might make the length > 2 on the first turn.
            // 2. Otherwise update at specific intervals (6, 10, 20) to refine context.
            const isNewChat = !conv?.title || conv.title === 'New Chat';
            const isUpdateInterval = [6, 10, 20].includes(result.conversationLength);

            // A turn whose user message was redacted does not name the chat.
            const shouldUpdateTitle = !result.guardrailViolation && !result.userMessageRedacted
                && ((isNewChat && result.conversationLength >= 2) || isUpdateInterval);

            log.info('[Title Gen] Conv length:', result.conversationLength, 'shouldUpdate:', shouldUpdateTitle, 'isNew:', isNewChat);

            if (conv && shouldUpdateTitle) {
                // Get all user messages for better context
                const userMessages = conv.messages
                    .filter(m => m.role === 'user')
                    .map(m => {
                        if (typeof m.content === 'string') return m.content;
                        if (Array.isArray(m.content)) {
                            return m.content
                                .filter(c => c.type === 'text')
                                .map(c => c.text)
                                .join(' ');
                        }
                        return '';
                    })
                    .filter(Boolean)
                    .join(' | ');

                // Shape only: the context is the user's messages, the title is
                // generated from them (an encryption surface).
                log.info(`[Title Gen] Triggering title generation (${userMessages.length} chars of context)`);
                // Use the System Agent's configured model (default behavior)
                try {
                    // The title model is sent the Privacy Shield's tokens, like the chat model.
                    const shielded = await require('../../core/dlp/titleShield.mts').shieldTitleContext(result.conversationId, userMessages);
                    const title = shielded.restore(await agentRuntime.generateChatTitle(shielded.text, null, orgId, userId));
                    log.info(`[Title Gen] Generated title (${String(title || '').length} chars)`);
                    if (title && title !== 'New Chat') {
                        await agentStore.updateConversationTitle(result.conversationId, title);
                        log.info('[Title Gen] Updated conversation:', result.conversationId);

                        // Optional: Send specific event for title update if we wanted to be fancy, 
                        // but waiting for 'done' is sufficient since frontend refetches context.
                        sendEvent('title_generated', { title });
                    }
                } catch (err) {
                    log.error('[Title Gen] Error:', err);
                }
            }
        }

        // Send final result. Incognito: without the (in-memory) conversation id.
        sendEvent('done', incognitoRules.isIncognito(req.body) ? incognitoRules.incognitoDonePayload(result) : result);
        markEnded();
        res.end();
    } catch (error) {
        if (/** @type {Error} */ (error).name === 'AbortError' || abortController.signal.aborted) {
            log.info('[agents] Agent execution aborted by client');
        } else {
            log.error('Agent streaming chat error:', error);
            sendEvent('error', require('../../core/http/sseError.mts').sseErrorPayload(error, { tag: '[agents/chat]', req }));
        }
        if (!res.writableEnded) {
            markEnded();
            res.end();
        }
    }
});

// Generate thread title
const MAX_TITLE_CONTENT_LEN = 32_000;
router.post('/thread/title', requireAuth, helperLimiter, validate({ body: TitleBody }), async (req, res) => {
    const { content } = req.body;
    if (content.length > MAX_TITLE_CONTENT_LEN) {
        return res.status(413).json({ error: 'Content too large' });
    }

    const threadOrgIds = await resolveUserOrgIds(req);
    const threadOrgId = threadOrgIds && threadOrgIds.size > 0 ? Array.from(threadOrgIds)[0] : null;
    const title = await agentRuntime.generateChatTitle(content, null, threadOrgId, req.session?.user?.id || null);
    res.json({ title });
});

// Describe what's being built from partial code (uses fast model)
const MAX_DESCRIBE_CODE_LEN = 50_000;
router.post('/describe-building', requireAuth, helperLimiter, validate({ body: DescribeBody }), async (req, res) => {
    const { code } = req.body;
    if (code.length > MAX_DESCRIBE_CODE_LEN) {
        return res.status(413).json({ error: 'Code payload too large' });
    }

    try {
        const config = await getAIConfig();
        // Defence-in-depth: refuse if the configured AI URL isn't a normal http(s)
        // endpoint. Prevents accidental SSRF if the config is ever tenant-influenced.
        /** @type {URL} */
        let parsedAiUrl;
        try {
            parsedAiUrl = new URL(config.url);
        } catch (_) {
            return res.json({ description: 'Building an interactive application...' });
        }
        if (!/^https?:$/.test(parsedAiUrl.protocol)) {
            return res.json({ description: 'Building an interactive application...' });
        }
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
        };

        // Use a fast model for quick descriptions
        const fastModel = 'Gemini 2.5 Flash-Lite - Fast';

        // Take the LAST 800 chars to see what's currently being generated
        const recentCode = code.slice(-800);

        const response = await fetchConfiguredEndpoint(`${config.url.replace(/\/+$/, '')}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: fastModel,
                messages: [
                    {
                        role: 'system',
                        content: 'Reply with 3-6 words describing what PART is being built. Add subtle, witty humor. Examples: "Crafting buttons with pizzazz", "Teaching AI to think", "Making pixels dance gracefully", "Wiring up the magic", "Brewing some fresh logic"'
                    },
                    {
                        role: 'user',
                        content: `What part is being built now?\n\n${recentCode}`
                    }
                ],
                max_tokens: 25,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            throw new Error(`AI request failed: ${response.status}`);
        }

        const data = /** @type {{ choices?: { message?: { content?: string } }[] }} */ (await response.json());
        const description = data.choices?.[0]?.message?.content?.trim() || 'Building an interactive application...';

        res.json({ description });
    } catch (error) {
        log.error('Describe building error:', error);
        // Return a fallback description on error
        res.json({ description: 'Building an interactive application...' });
    }
});

// Get conversation history: the caller's own (a visitor's under their
// `guest_…` id), behind the same gate as a turn, so an agent outside the
// caller's audience answers as it does there.
router.get('/:id/history', helperLimiter, requireAgentChat(), async (req, res) => {
    const { userId } = agentAccessOf(req);
    const conversation = await agentStore.getConversation(req.params.id, userId);
    res.json(conversation?.messages || []);
});

// Clear conversation history: the caller's own, same gate.
router.delete('/:id/history', helperLimiter, requireAgentChat(), async (req, res) => {
    const { userId } = agentAccessOf(req);
    await agentStore.clearConversation(req.params.id, userId);
    res.json({ success: true });
});


module.exports = router;
