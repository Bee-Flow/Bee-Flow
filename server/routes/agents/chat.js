const express = require('express');
const agentStore = require('../../stores/agentStore');
const agentRuntime = require('../../core/agentRuntime');
const { getAIConfig } = require('../../core/aiAgent');
require('../../stores/configStore');
const { requireAuth } = require('../../auth');
require('../../stores/memoryStore');
const { resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId, getUserAuth } = require('../../utils/routeHelpers');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const log = require('../../telemetry/log');

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

const userStore = require('../../stores/userStore');
require('../../stores/usageStore');
const { checkSubscriptionLimits: checkSubLimits } = require('../../core/entitlements/limits');
const { setupSSE, sendSSEError } = require('../../core/http/sseHelpers');
const { storedFlag, FLAG_DEFAULTS } = require('./storedFlag');

const router = express.Router();
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// -- What a caller may send ------------------------------------------
//
// The turn body is the widest on the server, and it was read key by key with
// no vocabulary anywhere. Three of those reads decided something:
//
//   - `test: 'true'` (the string) is not `=== true`, which is what
//     `wantsTestChat` asks. The turn therefore ran against the PUBLISHED
//     agent instead of the concept, was WRITTEN TO THE REAL HISTORY and
//     counted in the usage tab -- the three things a test chat exists to
//     avoid, all under a 200. It is a boolean now: a truthy word is refused
//     by name, and still never becomes a test chat.
//   - a misspelled `modelTier` fell back to the agent's own model, so an
//     override the composer offered did nothing and said nothing.
//   - a misspelled key anywhere in the body -- `converstionId`,
//     `memoryWrite` -- was dropped, and the turn answered as though the
//     thing it asked for had happened.
//
// THREE KEYS ARE ACCEPTED AND NOT READ, and they are named here on purpose:
// `agentId` and `stream` (both clients put them in the body -- the mobile
// client's AgentTurnPayload types them) and `isHidden` (the SPA sends it).
// `.strict()` without them would have 400'd every turn from Agent Hub and
// from the Android app.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const text = (name) => worded(`${name} must be text.`).optional();
const id = (name) => worded(`${name} must be an id.`).trim().min(1, `${name} must be an id.`).nullish();
const flag = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` }).optional();

const MESSAGE_TEXT = 'Message is required';

/**
 * One turn of a client-supplied `history`. Everything but `content` is the
 * runtime's to read, so the rest stays open (`passthrough`). `content` is
 * narrowed to what a provider accepts -- text, a list of content blocks, or
 * nothing -- because an object here is replayed verbatim on every later turn
 * and comes back as the provider's 400 "messages[N].content ... got an object".
 */
const HISTORY_TURN_TEXT = 'Each history turn is an object whose content is text, a list of content blocks or empty.';
const HistoryTurn = z.object({
    content: z.union([z.string(), z.array(z.unknown()), z.null()], { errorMap: () => ({ message: HISTORY_TURN_TEXT }) }).optional(),
}, { invalid_type_error: HISTORY_TURN_TEXT }).passthrough();

const TurnBody = bodyOf({
    message: worded(MESSAGE_TEXT).min(1, MESSAGE_TEXT),
    // Read by the runtime, not here: their shape belongs to the turn, and
    // `attachments` carries inline data URLs the uploader already bounds.
    // Only a history turn's `content` is checked (see HistoryTurn).
    history: z.array(HistoryTurn, { invalid_type_error: 'history is a list of turns.' }).optional(),
    attachments: z.array(z.unknown(), { invalid_type_error: 'attachments is a list.' }).optional(),
    messageId: id('messageId'),
    parentId: id('parentId'),
    conversationId: id('conversationId'),
    projectId: id('projectId'),
    ephemeral: flag('ephemeral'),
    modelTier: worded('modelTier is the name of a model tier.').trim().min(1, 'modelTier is the name of a model tier.').optional(),
    activeSkillIds: z.array(worded('activeSkillIds is a list of skill ids.'), { invalid_type_error: 'activeSkillIds is a list of skill ids.' }).optional(),
    reasoningEffort: worded('reasoningEffort is the name of a thinking effort.').trim().min(1, 'reasoningEffort is the name of a thinking effort.').optional(),
    timezone: text('timezone'),
    memoryWriteEnabled: flag('memoryWriteEnabled'),
    webSearchEnabled: flag('webSearchEnabled'),
    // The notebook and the side panel: what the person has open beside the
    // chat. `notebookspaceContent: ''` means "open but blank" and is NOT the
    // same as absent, so there is no `.min(1)` here.
    notebookspaceAvailable: flag('notebookspaceAvailable'),
    notebookspaceContent: text('notebookspaceContent'),
    notebookspaceSelection: text('notebookspaceSelection'),
    sidePanelWebpage: z.record(z.unknown()).nullish(),
    // Test chat (A4) + "Test as, group X" (A1c).
    test: z.boolean({ invalid_type_error: 'test is true or false.' }).optional(),
    testSessionId: text('testSessionId'),
    // LEFT OPEN one level down, on purpose: `normaliseToolDecisions` keeps
    // only an entry whose key is hex and whose decision is approve/decline,
    // and drops the rest. Dropping is the SAFE direction here -- a malformed
    // entry is an approval NOT granted -- and refusing the whole turn over
    // one bad card would cost the person the message they were writing.
    toolDecisions: z.array(z.record(z.unknown()), { invalid_type_error: 'toolDecisions is a list of decisions.' }).optional(),
    // LEFT OPEN, like `toolDecisions`: `gateTestAsRequest` refuses a group
    // that is not a usable id with its own codes (`test_as_invalid_group`,
    // `test_as_group_not_found`), which the composer reads. A shape check
    // here would answer `invalid_request` first and take those away.
    asGroup: z.unknown().optional(),
    // Sent by both clients, read by neither. Named so `.strict()` does not
    // refuse the requests they have always made.
    agentId: z.unknown().optional(),
    stream: z.unknown().optional(),
    isHidden: z.unknown().optional(),
    // Chat signals (core/privacy/chatSignals.js): the notice marker a chat
    // sends when it showed the chat-signals line for exactly this
    // configuration (`agent@<version>`, `agent_public@<version>` from the
    // embed), and the person's "don't count" switch. A turn without the
    // marker is not counted.
    chatSignalsNotice: worded('chatSignalsNotice must be text.').max(120, 'chatSignalsNotice is at most 120 characters.').optional(),
    chatSignalsOptOut: flag('chatSignalsOptOut'),
});

/**
 * The legacy non-streaming turn. It has only ever read `message` -- a
 * `conversationId` sent here was dropped, and the reply that did not continue
 * the thread was the only sign. It says so now.
 */
const PlainTurnBody = bodyOf({ message: worded(MESSAGE_TEXT).min(1, MESSAGE_TEXT) });

const TITLE_TEXT = 'Content is required';
const TitleBody = bodyOf({ content: worded(TITLE_TEXT).min(1, TITLE_TEXT) });
const CODE_TEXT = 'Code is required';
const DescribeBody = bodyOf({ code: worded(CODE_TEXT).min(1, CODE_TEXT) });

/**
 * Re-validates that an authenticated user still has group/org access to a
 * published agent at message-send time — not just when the page loaded.
 *
 * Mirrors the filtering logic in agentCrud.getPublishedAgentsForUser so that
 * revoking group membership or changing org scope takes effect immediately,
 * even for users who already have the agent open in their browser.
 *
 * @param {Object} agent   - Parsed agent record (shared_groups already an array)
 * @param {string} userId  - Authenticated user ID
 * @param {Object} req     - Express request (for resolveUserOrgIds)
 * @returns {Promise<boolean>}
 */
async function userCanAccessPublishedAgent(agent, userId, req) {
    // Agent must be published for anyone other than the owner
    if (!agent.is_published) return false;

    // Owner always has access to their own agent
    if (agent.owner_id === userId) return true;

    // Load current group membership and direct org from DB (not from session/cache)
    let userGroups = [];
    let userDirectOrgId = null;
    try {
        const user = await userStore.getUser(userId);
        if (user) {
            userGroups = Array.isArray(user.groups)
                ? user.groups
                : (() => { try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; } })();
            userDirectOrgId = user.organizationId || null;
        }
    } catch (_) { /* treat as no groups */ }

    // Resolve the full set of org IDs the user belongs to
    const resolvedOrgIds = await resolveUserOrgIds(req);
    let userOrgIds;
    if (resolvedOrgIds instanceof Set) {
        userOrgIds = resolvedOrgIds;
    } else {
        userOrgIds = new Set();
        if (userDirectOrgId) userOrgIds.add(userDirectOrgId);
    }
    const hasOrgMembership = userOrgIds.size > 0;

    // ── Org isolation (same logic as getPublishedAgentsForUser) ─────────────
    if (hasOrgMembership) {
        // Org users can ONLY access agents that belong to one of their orgs
        if (!agent.organization_id) return false;
        if (!userOrgIds.has(agent.organization_id)) return false;
    } else {
        // Users with no org can only access global (non-org-scoped) agents
        if (agent.organization_id) return false;
    }

    // ── Group restriction ────────────────────────────────────────────────────
    // shared_groups is already parsed as an array by agentCrud.parseConfig
    const sharedGroups = agent.shared_groups || [];
    if (sharedGroups.length > 0) {
        return sharedGroups.some(sg => userGroups.includes(sg));
    }

    return true;
}

/**
 * May a visitor WITHOUT an account take a turn with this (published) agent?
 * Only where the agent has a public chat page, and that page exists only while
 * its owner has Web embed switched on — GET /:id/embed below applies the same
 * rule. The editor asks before turning it on: "Make this agent public? Anyone
 * who knows the URL will be able to chat with this agent without an account"
 * (EnableEmbedConfirmModal). Left off, the agent is not public.
 *
 * Why a separate check: a visitor is never userless here. getEffectiveUserId
 * gives every session a `guest_…` id, so the turn routes below send a visitor
 * through userCanAccessPublishedAgent as an account with no organisation — and
 * that admits every published agent WITHOUT an org, embed switch on or off.
 * The "(embed flow)" branch this check replaces was never reached.
 *
 * Signed-in people are unaffected: for them the embed switch is not an
 * audience rule, userCanAccessPublishedAgent is.
 */
function anonymousOutsideEmbed(agent, req) {
    return !req.session?.user?.id && !agent.embed_enabled;
}

// ============ Chat ============

// Chat with agent
router.post('/:id/chat', validate({ body: PlainTurnBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { message } = req.body;

    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!agent.is_published) {
        // Unpublished agents: only the owner can access. A visitor without an
        // account gets the answer /chat/stream gives, and the one below for a
        // published agent without a public page, so an anonymous probe cannot
        // tell the two apart.
        if (!req.session?.user?.id) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        if (agent.owner_id !== userId) {
            return res.status(403).json({ error: 'Access denied' });
        }
    } else if (anonymousOutsideEmbed(agent, req)) {
        return res.status(401).json({ error: 'Not authenticated' });
    } else if (userId) {
        // Published agents: re-validate current group/org permissions on every request
        const canAccess = await userCanAccessPublishedAgent(agent, userId, req);
        if (!canAccess) {
            log.warn(`[AgentChat] User ${userId} attempted to chat with agent ${agent.id} — access denied (permissions revoked)`);
            return res.status(403).json({ error: 'Access denied' });
        }
    }

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
    } catch (e) { }

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

// Streaming chat with agent (SSE)
router.post('/:id/chat/stream', streamLimiter, validate({ body: TurnBody }), async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);

    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Access control — re-validated on every request so revoked permissions take
    // effect immediately, even for users who already have the agent open.
    {
        const userId = getEffectiveUserId(req);

        if (!agent.is_published) {
            // Unpublished: require authentication and ownership
            if (!req.session?.user?.id) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            if (agent.owner_id !== userId) {
                return res.status(403).json({ error: 'Access denied' });
            }
        } else if (anonymousOutsideEmbed(agent, req)) {
            // Published, but with no public page: a visitor without an
            // account has no way in. Same answer as an unpublished agent, so
            // the two cannot be told apart from outside.
            return res.status(401).json({ error: 'Not authenticated' });
        } else if (userId) {
            // Published: re-validate group/org membership from DB on every message.
            // This prevents a user whose permissions were revoked from continuing to
            // chat just because they haven't refreshed the page yet. A visitor
            // with embed on lands here too, under their `guest_…` id.
            const canAccess = await userCanAccessPublishedAgent(agent, userId, req);
            if (!canAccess) {
                log.warn(`[AgentChat] User ${userId} attempted to stream agent ${agent.id} — access denied (permissions revoked)`);
                return res.status(403).json({ error: 'Access denied' });
            }
        }
    }

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
            const { canModifyAgent } = require('./crud');
            canEdit = await canModifyAgent(agent, userId, req);
        } catch (e) {
            // An edit check that could not run is not permission to simulate.
            log.error('[AgentChat] test-mode edit check failed:', e.message);
            // Eén mislukte check weigert BEIDE affordances als er beide
            // gevraagd zijn. `code` blijft de sterkste (een testchat serveert
            // het concept), maar `codes` noemt elke geweigerde affordance —
            // anders mist een client die op het A1c-contract
            // (`test_as_check_failed`) afhandelt precies het geval waarin hij
            // óók `test: true` meestuurde.
            const _refused = [];
            if (wantsTest) _refused.push(testChatMod.TEST_CHAT_CODES.checkFailed);
            if (req.body?.asGroup) _refused.push('test_as_check_failed');
            return res.status(503).json({
                error: 'Could not check your permissions right now. Try again.',
                code: _refused[0] || 'test_as_check_failed',
                codes: _refused,
            });
        }
        const testGate = testChatMod.gateTestChatRequest({ test: req.body?.test, canEdit });
        if (!testGate.ok) return res.status(testGate.status).json({ error: testGate.error, code: testGate.code });
        isTestChat = testGate.testChat;

        // "Test als" keeps its own module and its own refusals — A4 rides the
        // A1c path, it does not grow a second one beside it.
        const testAsMod = require('../../core/agentRuntime/testAs');
        const gated = await testAsMod.gateTestAsRequest({
            asGroup: req.body.asGroup, userId, orgIds, canEdit,
        });
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
            { messageId, parentId, attachments, conversationId, ephemeral: isEphemeral, ephemeralKey: testChatMod.normaliseSessionKey(req.body.testSessionId), testAs, testChat: isTestChat, toolDecisions: isTestChat ? testChatMod.normaliseToolDecisions(req.body.toolDecisions) : undefined, notebookspaceContent: req.body.notebookspaceContent, notebookspaceSelection: req.body.notebookspaceSelection, notebookspaceAvailable: req.body.notebookspaceAvailable, sidePanelWebpage: req.body.sidePanelWebpage, signal: abortController.signal, userOrgId: userAuth.userOrgId, timezone: req.body.timezone, projectId: req.body.projectId, modelTier, activeSkillIds, orgId, reasoningEffort, memoryWriteEnabled: req.body.memoryWriteEnabled, webSearchEnabled: req.body.webSearchEnabled,
                // Chat signals: the marker and the switch, read by the turn
                // preflight's recorder call (chatStream/turnPreflight.js).
                chatSignals: { notice: typeof req.body.chatSignalsNotice === 'string' ? req.body.chatSignalsNotice : null, optOut: req.body.chatSignalsOptOut === true } }
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

            const shouldUpdateTitle = !result.guardrailViolation && ((isNewChat && result.conversationLength >= 2) || isUpdateInterval);

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

                log.info('[Title Gen] Triggering title generation with context:', userMessages.slice(0, 100));
                // Use the System Agent's configured model (default behavior)
                try {
                    const title = await agentRuntime.generateChatTitle(userMessages, null, orgId, userId);
                    log.info('[Title Gen] Generated title:', title);
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

        // Send final result
        sendEvent('done', result);
        markEnded();
        res.end();
    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            log.info('[agents] Agent execution aborted by client');
        } else {
            log.error('Agent streaming chat error:', error);
            const classified = error._classified || {};
            sendEvent('error', {
                error: error.message,
                errorType: classified.retryable ? 'transient' : 'permanent'
            });
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

    try {
        const threadOrgIds = await resolveUserOrgIds(req);
        const threadOrgId = threadOrgIds && threadOrgIds.size > 0 ? Array.from(threadOrgIds)[0] : null;
        const title = await agentRuntime.generateChatTitle(content, null, threadOrgId, req.session?.user?.id || null);
        res.json({ title });
    } catch (error) {
        log.error('Thread title generation error:', error);
        res.status(500).json({ error: 'Failed to generate title' });
    }
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

        const response = await fetch(`${config.url.replace(/\/+$/, '')}/v1/chat/completions`, {
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

        const data = await response.json();
        const description = data.choices?.[0]?.message?.content?.trim() || 'Building an interactive application...';

        res.json({ description });
    } catch (error) {
        log.error('Describe building error:', error);
        // Return a fallback description on error
        res.json({ description: 'Building an interactive application...' });
    }
});

// Get conversation history
router.get('/:id/history', helperLimiter, async (req, res) => {
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Use effective user ID (works for guests too)
    const userId = getEffectiveUserId(req);
    const conversation = await agentStore.getConversation(req.params.id, userId);
    res.json(conversation?.messages || []);
});

// Clear conversation history
router.delete('/:id/history', helperLimiter, async (req, res) => {
    const userId = getEffectiveUserId(req);

    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    // Allow access if published or if user is owner
    if (!agent.is_published && agent.owner_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    await agentStore.clearConversation(req.params.id, userId);
    res.json({ success: true });
});


module.exports = router;
