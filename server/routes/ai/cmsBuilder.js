/**
 * CMS Builder — conversational SSE endpoint (trimmed clone of
 * routes/ai/appStudioBuilder.js for CMS page building).
 *
 *   POST /stream            mounted at /api/cms/builder in server/index.js
 *   GET  /session/:siteId   (BEFORE /api/cms so the specific prefix wins)
 *
 * Body: { message, siteId (required), builderSessionId?, modelTier='auto',
 *         context? ({activePageId, activeBlockId, activeLocale}), timezone? }
 *
 * Every mutating tool persists through stores/cmsStore immediately (there is
 * no finalize step), so a refresh recovers the site via the normal CMS admin
 * routes and the chat via GET /session/:siteId.
 *
 * SESSIONS ARE SITE-SCOPED AND SHARED BETWEEN ADMINS — the CMS admin surface
 * is a shared editing space (unlike the owner-scoped studio-app sessions):
 * any admin resuming the builder for a site sees the same conversation.
 *
 * SSE EVENT CONTRACT (FROZEN — the frontend is built against exactly these):
 *   builder_session   { sessionId, siteId }
 *   model_selected    { modelId, tier }
 *   thinking_start {} / thinking { delta } / thinking_stop {}
 *   message           { content }                     — assistant prose deltas
 *   tool_call         { name, label, ok, summary }
 *   draft             { siteId, kind:'site', site }   — after site-index mutations
 *   draft             { siteId, kind:'page', pageId, page } — after page mutations
 *   validation_errors { errors, warnings }
 *   usage             { inputTokens, outputTokens }
 *   done              { siteId, createdPageIds, touchedPageIds }
 *   error             { message, code }               — code ∈ subscription_limit |
 *       rate_limited | model_unavailable | transient_upstream | budget_exhausted |
 *       internal
 *
 * OBSERVABILITY: every turn logs ONE usageStore.logUsage row (agent_type
 * 'cms_builder', agent_id=siteId, conversation_id=sessionId, stop_reason=
 * outcome) and ships the full per-turn metadata as a structured stdout line
 * ("[CmsBuilder] usage {...}") → OpenObserve. Each SSE `error` additionally
 * emits a structured stderr line keyed by its taxonomy code.
 *
 * PROMPT-CACHE DISCIPLINE (mirrors appStudioBuilder.js): the system prompt
 * (instructions + block catalogue) is byte-stable across turns; the live
 * site state travels in ONE LATE role:'user' machine message each turn
 * (renderDraftState + the editor-context line) so provider prefix caches
 * keep hitting while the user iterates.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const cmsStore = require('../../stores/cmsStore');
const usageStore = require('../../stores/usageStore');
const { getProviderForModel, getAIConfig } = require('../../core/aiAgent');
const { getAdapter } = require('../../core/providers');
const { getUserTierMap } = require('../../core/llm/modelResolver');
const { getPermittedTierKeys } = require('../../core/entitlements/userTiers');
const { TOOL_SCHEMAS, MUTATING_TOOLS, SITE_DRAFT_TOOLS, PAGE_DRAFT_TOOLS, applyToolCall } = require('../../cmsBuilder/builderTools');
const { buildSystemPrompt, renderDraftState } = require('../../cmsBuilder/builderPrompt');
const { validateSiteDraft } = require('../../cmsBuilder/validate');
const { getProfileForModel, effortForIteration } = require('../../cmsBuilder/builderModelProfiles');
const { isTransientChatError, applyBuilderTierFloor, streamWithRetry: sharedStreamWithRetry } = require('./builderShared');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { startSseHeartbeat } = require('../../core/http/sseHelpers');

// The same admin gate + siteId validation the CMS CRUD routes use — the
// builder must never be reachable below the admin bar.
const { requireAdmin, SITE_ID_RE } = require('../cmsShared');
const { validate } = require('../../core/http/validate');
const { z, worded, bodyOf, closedObject } = require('../../core/http/schemaParts');

// ── What a caller may send ───────────────────────────────────────────
// The body keys the builder reads, and nothing else: a misspelled
// `modelTeir` used to run the turn on `auto` under a 200, and a misspelled
// `contxt` dropped what the person was looking at without a word. The value
// checks the handler made by hand are the schema's now, in the same words.
const SITE_TEXT = 'Valid siteId required';
const siteId = worded(SITE_TEXT).regex(SITE_ID_RE, SITE_TEXT);
const SessionParams = closedObject({ siteId: worded('Invalid siteId format').regex(SITE_ID_RE, 'Invalid siteId format') }, 'This address');
const StreamBody = bodyOf({
    message: worded('Message required').refine((m) => m.trim().length > 0, 'Message required'),
    siteId,
    builderSessionId: worded('builderSessionId is the id the previous turn handed back.').max(200, 'builderSessionId is at most 200 characters.').nullish(),
    modelTier: worded('modelTier is the name of a model tier.').max(100, 'modelTier is at most 100 characters.').optional(),
    // Accepted for parity with the other builders; pages carry no time semantics.
    timezone: worded('timezone is a zone name, like Europe/Amsterdam.').max(100, 'timezone is at most 100 characters.').optional(),
    // Whitelisted and bounded further by sanitizeEditorContext.
    context: z.record(z.unknown(), { invalid_type_error: "context is the editor's focus, an object." }).nullish(),
}, 'A builder turn');

// Each builder turn is a multi-iteration LLM conversation chaining many tool
// calls — expensive. Same ceiling as the other builders: 12/min/user.
const builderRateLimit = perUserRateLimit({ windowMs: 60_000, max: 12 });

// Hard ceiling on iterations per turn regardless of profile. Pages are much
// cheaper to assemble than app trees — 16 is plenty.
const MAX_ITERATIONS = 16;

// GET the persisted builder-session snapshot for a site. Used by the client
// on mount to rehydrate chat history + validation state after a refresh or
// SSE drop. Site-scoped and shared between admins (see the file header).
router.get('/session/:siteId', requireAdmin, validate({ params: SessionParams }), async (req, res) => {
    const { siteId } = req.params;
    if (!siteId || !SITE_ID_RE.test(siteId)) {
        return res.status(400).json({ error: 'Invalid siteId format' });
    }
    const project = await cmsStore.getProject(siteId);
    if (!project) return res.status(404).json({ error: 'Site not found' });
    const snapshot = await cmsStore.getBuilderSession(siteId);
    if (!snapshot) return res.status(404).json({ error: 'No builder session for this site' });
    res.json({ snapshot });
});

router.post('/stream', requireAdmin, builderRateLimit, validate({ body: StreamBody }), async (req, res) => {
    const userId = req.session.user.id;
    // Wall-clock start of the turn — feeds the usage row's duration_ms and
    // the structured observability line. Set before any SSE so a turn that
    // dies mid-stream still reports a real duration from the outer catch.
    const turnStartedAt = Date.now();
    const {
        message,
        siteId,
        builderSessionId: clientSession,
        modelTier = 'auto',
        timezone, // accepted for parity with the other builders; pages carry no time semantics
    } = req.body || {};
    void timezone;
    // Editor context (what the user is looking at) — whitelisted + bounded,
    // rendered as a machine message after the draft state (never persisted).
    const editorContext = sanitizeEditorContext(req.body?.context);

    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'Message required' });
    }
    if (!siteId || typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) {
        return res.status(400).json({ error: 'Valid siteId required' });
    }

    // ── Subscription limit enforcement — BEFORE switching to SSE, so the
    //    402 stays clean JSON (same shape as appStudioBuilder). ──
    let limitOrgId = null;
    const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
    const { resolveUserOrgIds } = require('../../auth');
    const orgIds = await resolveUserOrgIds(req);
    limitOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
    if (limitError) return res.status(402).json({ error: limitError, code: 'subscription_limit' });

    // ── Load the site draft — a bad siteId 404s pre-SSE. getAdminPayload
    //    pulls the SiteDoc + every PageDoc + locale overrides in one shot
    //    (fresh reads — the builder needs read-your-writes like the panel). ──
    let draftWrap;
    let priorSnapshot = null;
    const project = await cmsStore.getProject(siteId);
    if (!project) return res.status(404).json({ error: 'Site not found' });
    priorSnapshot = await cmsStore.getBuilderSession(siteId).catch(() => null);
    const payload = await cmsStore.getAdminPayload(siteId);
    const locales = new Set(Object.keys(payload.localeOverrides?.siteByLocale || {}));
    for (const perPage of Object.values(payload.localeOverrides?.pagesByLocale || {})) {
        for (const loc of Object.keys(perPage || {})) locales.add(loc);
    }
    draftWrap = {
        siteId,
        userId,
        orgId: req.session?.user?.organizationId || limitOrgId || null,
        builderSessionId: clientSession || priorSnapshot?.sessionId || `cms_${Date.now().toString(36)}`,
        site: payload.site,
        pages: new Map((payload.pages || []).map((p) => [p.id, p])),
        defaultLocale: payload.defaultLocale || 'en',
        locales: [...locales].sort(),
        createdPageIds: [],
        touchedPageIds: new Set(),
    };

    // ── Model resolution (pre-SSE — clean JSON errors). ──
    const userOrgForTiers = req.session?.user?.organizationId || limitOrgId || null;
    let resolvedTier;
    let modelId;
    let tier = {};
    let cfg;
    let adapter;
    try {
        {
            const tiers = await getUserTierMap({ userOrgId: userOrgForTiers, userId });
            resolvedTier = (typeof modelTier === 'string' && modelTier) ? modelTier : 'auto';
            let explicitPick = resolvedTier !== 'auto';
            // An explicit client tier must be one the user is permitted to
            // select — a disallowed/unknown tier silently falls back to auto
            // (never a hard error; the builder should always run).
            if (explicitPick) {
                try {
                    const permitted = await getPermittedTierKeys({ userId, session: req.session });
                    if (!permitted.has(resolvedTier) || !tiers[resolvedTier]) {
                        log.info(`[CmsBuilder] Tier "${resolvedTier}" not permitted/configured for user — falling back to auto`);
                        resolvedTier = 'auto';
                        explicitPick = false;
                    }
                } catch (err) {
                    log.info(`[CmsBuilder] Tier permission check failed (${err.message}) — falling back to auto`);
                    resolvedTier = 'auto';
                    explicitPick = false;
                }
            }
            if (resolvedTier === 'auto') {
                try {
                    const { classifyWithLLM } = require('../../core/llm/promptClassifier');
                    const classifyTiers = Object.fromEntries(
                        Object.entries(tiers).filter(([k]) => !k.startsWith('custom:') && k !== 'swarm'),
                    );
                    const result = await classifyWithLLM(String(message), classifyTiers, { userOrgId: userOrgForTiers, userId });
                    resolvedTier = result.tier;
                    log.info(`[CmsBuilder] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
                } catch (err) {
                    log.info(`[CmsBuilder] Auto classification failed: ${err.message}, using fast`);
                    resolvedTier = 'fast';
                }
            }
            tier = tiers[resolvedTier] || {};
            modelId = tier.modelId;
            if (!modelId) {
                const globalConfig = await getAIConfig();
                modelId = globalConfig?.model || null;
            }
            if (!modelId) {
                return res.status(400).json({ error: `No model configured for tier ${resolvedTier}`, code: 'model_unavailable' });
            }
            // Capability floor: assembling structured blocks on a small model
            // loops to the iteration cap. Only applies when the tier came from
            // 'auto'; an explicit tier choice is always honoured.
            if (!explicitPick) {
                const floored = applyBuilderTierFloor(resolvedTier, modelId, tiers);
                if (floored.modelId !== modelId) {
                    log.info(`[CmsBuilder] Auto floor: bumped small "${resolvedTier}" → "${floored.tier}" (${floored.modelId})`);
                    resolvedTier = floored.tier;
                    modelId = floored.modelId;
                    tier = tiers[resolvedTier] || tier;
                }
            }
            cfg = await getProviderForModel(modelId);
        }
        adapter = getAdapter(cfg.providerType, cfg.url);
    } catch (e) {
        return res.status(400).json({ error: e.message, code: 'model_unavailable' });
    }

    // ── SSE from here on. flushHeaders + 10s heartbeat are REQUIRED: a
    //    thinking model can go silent for 30–60s and an idle gateway would
    //    otherwise drop the stream into a false 504 (same class as the
    //    automation-builder incident / BFSF-221). ──
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const stopHeartbeat = startSseHeartbeat(res);
    const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* stream gone */ }
    };

    // SSE `error` carries a machine `code` AND leaves a structured stderr
    // line (shipped to OpenObserve via stdout — no monitoring tables).
    const sendError = (code, userMessage) => {
        send('error', { message: userMessage, code });
        log.error(`[CmsBuilder] code=${code} siteId=${siteId} session=${draftWrap.builderSessionId || '-'} model=${modelId || '-'}`);
    };

    // Per-turn usage metrics + outcome. Declared out here (not inside the
    // try) so the outer catch can still log a turn that blew up.
    const usageTotals = { inputTokens: 0, outputTokens: 0 };
    let iter = 0;
    let toolCallCount = 0;
    let mutatingToolCalls = 0;
    let validationErrorCount = 0;
    let usageLogged = false;
    const logTurnUsage = (outcome) => {
        if (usageLogged) return; // one row per turn, even if both paths fire
        usageLogged = true;
        const durationMs = Date.now() - turnStartedAt;
        const metadata = {
            siteId,
            sessionId: draftWrap.builderSessionId,
            tier: resolvedTier,
            iterations: iter,
            toolCallCount,
            mutatingToolCalls,
            validationErrorCount,
            createdPages: draftWrap.createdPageIds.length,
            touchedPages: draftWrap.touchedPageIds.size,
            outcome,
            durationMs,
        };
        // ai_usage_log has no metadata column, so fold the identifying fields
        // into real columns (agent_id=siteId, conversation_id=session,
        // stop_reason=outcome) and ship the full metadata as a structured
        // stdout line → OpenObserve. Fire-and-forget: usage logging must
        // never break a turn.
        Promise.resolve(
            usageStore.logUsage({
                user_id: userId,
                organization_id: draftWrap.orgId || null,
                agent_id: siteId,
                agent_name: `CMS builder: ${draftWrap.site?.name || 'Untitled site'}`,
                agent_type: 'cms_builder',
                model: modelId,
                prompt_tokens: usageTotals.inputTokens,
                completion_tokens: usageTotals.outputTokens,
                total_tokens: usageTotals.inputTokens + usageTotals.outputTokens,
                duration_ms: durationMs,
                source: 'cms_builder',
                conversation_id: draftWrap.builderSessionId || siteId,
                stop_reason: outcome,
            }),
        ).catch((e) => log.error('[CmsBuilder] usage log failed (non-fatal):', e.message));
        log.info(`[CmsBuilder] usage ${JSON.stringify(metadata)}`);
    };

    try {
        send('builder_session', { sessionId: draftWrap.builderSessionId, siteId });
        send('model_selected', { modelId, tier: resolvedTier });

        const profile = getProfileForModel(modelId);
        const sys = buildSystemPrompt();
        const tools = TOOL_SCHEMAS;

        // Prior conversation from the persisted snapshot (server-owned — the
        // client does not resend history). Machine notes are stripped.
        const history = sanitizeHistory(priorSnapshot?.messages);

        // Live site state — ONE LATE role:'user' machine message (never in
        // the cached system prompt; see the cache-discipline note on top).
        // The editor-context line rides inside the same message.
        const messages = [
            { role: 'system', content: sys },
            ...history,
            { role: 'user', content: renderDraftStateNote(draftWrap, editorContext) },
            { role: 'user', content: String(message) },
        ];

        const iterationBudget = Math.min(profile.maxIterations || MAX_ITERATIONS, MAX_ITERATIONS);

        // Stop the loop the moment the client disconnects — no point burning
        // tokens with nowhere to send the output. The flag ends the LOOP; the
        // signal ends the request that is in flight RIGHT NOW, which is what
        // frees a single-slot local model instead of leaving it generating an
        // answer nobody will read.
        let clientGone = false;
        const clientAbort = new AbortController();
        req.on('close', () => {
            clientGone = true;
            try { clientAbort.abort(); } catch (_) { /* already aborted */ }
        });

        let lastValidation = null;
        let escalateNextRound = false;
        let streamFailed = false;
        let sawFinalProse = false;
        const proseParts = [];

        for (iter = 0; iter < iterationBudget; iter++) {
            if (clientGone || res.writableEnded) {
                log.info('[cmsBuilder/stream] client disconnected — aborting build loop');
                break;
            }
            const turnToolChoice = (iter === 0 && profile.forceFirstToolCall) ? 'required' : 'auto';
            const turnEffort = effortForIteration(iter, escalateNextRound, profile);
            escalateNextRound = false;

            let response;
            try {
                response = await streamWithRetry(adapter, cfg, modelId, messages, {
                    maxTokens: 8192,
                    temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.2,
                    tools,
                    toolChoice: turnToolChoice,
                    reasoningEffort: turnEffort,
                    reasoningSummary: tier.reasoningSummary !== undefined ? tier.reasoningSummary : 'auto',
                    promptCacheKey: draftWrap.builderSessionId || undefined,
                    userId: String(userId),
                }, { send, signal: clientAbort.signal });
            } catch (chatErr) {
                if (clientGone || chatErr?.name === 'AbortError' || clientAbort.signal.aborted) {
                    log.info('[CmsBuilder] build cancelled by the client');
                    streamFailed = true;
                    break;
                }
                log.error('[CmsBuilder] chat failed after retries:', chatErr.message);
                sendError('transient_upstream', 'The AI provider had a temporary problem. Your site is saved — please send your message again.');
                streamFailed = true;
                break;
            }

            if (response.content) proseParts.push(response.content);
            if (response.usage) {
                usageTotals.inputTokens += Number(response.usage.prompt_tokens) || 0;
                usageTotals.outputTokens += Number(response.usage.completion_tokens) || 0;
                send('usage', { ...usageTotals });
            }

            if (!response.toolCalls || !response.toolCalls.length) { sawFinalProse = true; break; }

            // Signed thinking blocks must be replayed before the tool_use
            // blocks on the next request (Anthropic conversation integrity).
            const thinkingForReplay = (response.thinkingParts || [])
                .filter((p) => p.signature && p.text && !p.redacted)
                .map((p) => ({ text: p.text, signature: p.signature }));

            messages.push({
                role: 'assistant',
                content: response.content || null,
                ...(thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
                tool_calls: response.toolCalls.map((tc) => ({
                    id: tc.id, type: 'function',
                    function: {
                        name: tc.function.name,
                        arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
                    },
                    _thought_signature: tc._thought_signature || undefined,
                })),
            });

            let mutatedThisIter = false;
            const droppedBlockFeedback = [];
            for (const tc of response.toolCalls) {
                toolCallCount += 1;
                const name = tc.function.name;
                const { args, truncated } = parseToolArgs(tc.function.arguments, name);
                let toolResult;
                if (truncated) {
                    // Truncated-JSON self-repair: a machine message, not a crash.
                    toolResult = { error: `Your arguments for ${name} were not valid JSON (likely truncated mid-call). Resend just THIS single tool call with complete, valid JSON arguments.` };
                    escalateNextRound = true;
                } else {
                    toolResult = await applyToolCall(draftWrap, name, args);
                }
                const ok = !(toolResult && typeof toolResult === 'object' && toolResult.error);
                send('tool_call', { name, label: labelForTool(name), ok, summary: summariseToolResult(name, args, toolResult) });

                // Draft events after every successful mutation (tools persist
                // through cmsStore themselves) — page first (the doc), then
                // site (the index), so the client can hydrate in one pass.
                if (ok && MUTATING_TOOLS.has(name)) {
                    mutatingToolCalls += 1;
                    mutatedThisIter = true;
                    if (PAGE_DRAFT_TOOLS.has(name)) {
                        const pageId = toolResult.pageId || args?.pageId || null;
                        const page = pageId ? draftWrap.pages.get(pageId) : null;
                        if (pageId && page) send('draft', { siteId, kind: 'page', pageId, page });
                    }
                    if (SITE_DRAFT_TOOLS.has(name)) {
                        send('draft', { siteId, kind: 'site', site: draftWrap.site });
                    }
                }
                // Dropped blocks are a teaching signal: besides the tool
                // result, they get a machine feedback message next round.
                if (name === 'cms_add_blocks' && toolResult && Array.isArray(toolResult.dropped) && toolResult.dropped.length) {
                    droppedBlockFeedback.push(...toolResult.dropped.map((d) => d.type).filter(Boolean));
                    escalateNextRound = true;
                }
                if (!ok) escalateNextRound = true;

                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: typeof toolResult === 'string' ? toolResult : truncateJson(toolResult),
                });
            }

            if (droppedBlockFeedback.length) {
                messages.push({ role: 'user', content: renderBlockFeedbackNote(droppedBlockFeedback) });
            }

            // Validation feedback loop: after any mutation, validate the whole
            // draft, surface the records to the client, and feed errors back
            // to the model as a clearly-framed role:'user' report (NOT
            // role:'system' — system messages get hoisted/concatenated by the
            // Claude/Gemini adapters and would invalidate the prompt cache
            // mid-turn).
            if (mutatedThisIter) {
                lastValidation = validateSiteDraft(draftWrap);
                send('validation_errors', { errors: lastValidation.errors, warnings: lastValidation.warnings });
                if (lastValidation.errors.length) {
                    messages.push({ role: 'user', content: renderValidationNote(lastValidation) });
                    escalateNextRound = true;
                }
            }
        }

        // Budget exhausted without the model wrapping up. Everything the
        // model built is already persisted (tools write through), so this is
        // informational — the user just sends another message to continue.
        const budgetExhausted = !sawFinalProse && !streamFailed && !clientGone && iter >= iterationBudget;
        if (budgetExhausted) {
            sendError('budget_exhausted', 'I ran out of build turns — everything so far is saved. Send another message and I\'ll keep going.');
        }

        // Session snapshot for rehydration (site-scoped, shared between
        // admins; the store trims >64KB dropping oldest messages first).
        try {
            const conversationTail = [
                ...history,
                { role: 'user', content: String(message) },
                ...(proseParts.length ? [{ role: 'assistant', content: proseParts.join('') }] : []),
            ].slice(-40);
            await cmsStore.setBuilderSession(siteId, {
                sessionId: draftWrap.builderSessionId,
                siteId,
                messages: conversationTail,
                lastValidation: lastValidation || null,
                updatedAt: new Date().toISOString(),
                lastTier: resolvedTier,
            });
        } catch (_) { /* non-fatal */ }

        validationErrorCount = Array.isArray(lastValidation?.errors) ? lastValidation.errors.length : 0;
        const outcome = streamFailed ? 'transient_upstream'
            : budgetExhausted ? 'budget_exhausted'
                : clientGone ? 'client_disconnected'
                    : 'completed';
        logTurnUsage(outcome);

        send('done', {
            siteId,
            createdPageIds: draftWrap.createdPageIds,
            touchedPageIds: [...draftWrap.touchedPageIds],
        });
        stopHeartbeat();
        res.end();
    } catch (e) {
        log.error('[cmsBuilder/stream] error:', e);
        sendError('internal', e.message);
        // Still record the turn's usage — a turn that died mid-stream burned
        // tokens too. logTurnUsage is idempotent, so a done-path log that
        // already ran wins; this only fires when we never reached it.
        try { logTurnUsage('internal'); } catch (_) { /* never block cleanup */ }
        stopHeartbeat();
        res.end();
    }
});

// ── Helpers ─────────────────────────────────────────────────────────

// Marker prefixes for the synthetic machine messages — framed as
// machine-generated (not the human) and stripped from cross-turn history.
const VALIDATION_NOTE_PREFIX = '[VALIDATION REPORT — machine-generated, not from the human user]';
const DRAFT_STATE_PREFIX = '[SITE STATE — machine-generated: the site\'s current pages and blocks with their REAL ids]';
const EDITOR_CONTEXT_PREFIX = '[EDITOR CONTEXT — machine-generated: what the user is looking at]';
const BLOCK_FEEDBACK_PREFIX = '[BLOCK FEEDBACK — machine-generated]';

function renderValidationNote(validation) {
    const errors = Array.isArray(validation.errors) ? validation.errors : [];
    const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
    const warnLine = warnings.length
        ? `\nwarnings(${warnings.length}): ${[...new Set(warnings.map((w) => w && w.code).filter(Boolean))].join(', ')}`
        : '';
    return `${VALIDATION_NOTE_PREFIX}\nFix every error below before you finish. Each record has {code, path, message, hint}; the hint tells you what to do next.\n${JSON.stringify(errors)}${warnLine}`;
}

function renderBlockFeedbackNote(droppedTypes) {
    const { BLOCK_TYPE_IDS } = require('../../i18n/defaults/cmsDefaults');
    return `${BLOCK_FEEDBACK_PREFIX}\nYour cms_add_blocks call included unknown block type(s): ${[...new Set(droppedTypes)].map((t) => JSON.stringify(t)).join(', ')} — those blocks were DROPPED and are NOT on the page. Re-add that content using only the valid types: ${BLOCK_TYPE_IDS.join(', ')}.`;
}

/** Draft state + editor context, folded into one late machine message. */
function renderDraftStateNote(draftWrap, editorContext) {
    const parts = [`${DRAFT_STATE_PREFIX}\n${renderDraftState(draftWrap, editorContext)}`];
    const contextNote = renderEditorContextNote(editorContext);
    if (contextNote) parts.push(contextNote);
    return parts.join('\n');
}

// ── Editor context — whitelisted, bounded projection of body.context ──

const CONTEXT_STRING_KEYS = ['activePageId', 'activeBlockId', 'activeLocale'];
const MAX_CONTEXT_ID_LEN = 64;

/** Whitelist + bound the client's editor context; null when nothing usable. */
function sanitizeEditorContext(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const key of CONTEXT_STRING_KEYS) {
        const v = raw[key];
        if (typeof v === 'string' && v && v.length <= MAX_CONTEXT_ID_LEN) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
}

function renderEditorContextNote(context) {
    if (!context) return null;
    const lines = [EDITOR_CONTEXT_PREFIX];
    if (context.activePageId) lines.push(`open page: ${context.activePageId}`);
    if (context.activeBlockId) lines.push(`selected block: ${context.activeBlockId}`);
    if (context.activeLocale) lines.push(`viewing locale: ${context.activeLocale}`);
    lines.push('When the user says "this"/"here", they most likely mean the ids above.');
    return lines.join('\n');
}

/** Prose-only history from a session snapshot; loop-internal notes stripped. */
function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .filter((m) => !m.content.startsWith(VALIDATION_NOTE_PREFIX)
            && !m.content.startsWith(DRAFT_STATE_PREFIX)
            && !m.content.startsWith(EDITOR_CONTEXT_PREFIX)
            && !m.content.startsWith(BLOCK_FEEDBACK_PREFIX))
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-40);
}

// Product-language labels for the tool_call SSE event.
const TOOL_LABELS = {
    cms_create_page: 'Created page',
    cms_update_page_meta: 'Updated page settings',
    cms_update_page_seo: 'Updated SEO',
    cms_add_blocks: 'Added blocks',
    cms_update_block: 'Edited block',
    cms_remove_block: 'Removed block',
    cms_reorder_blocks: 'Reordered blocks',
    cms_set_homepage: 'Set homepage',
    cms_reorder_pages: 'Reordered pages',
    cms_update_header_nav: 'Updated header menu',
    cms_update_design: 'Updated design',
    cms_list_site: 'Read site',
    cms_get_page: 'Read page',
};

function labelForTool(name) {
    return TOOL_LABELS[name] || name;
}

/** One short human line per tool result — feeds the tool_call SSE event. */
function summariseToolResult(name, args, result) {
    const cap = (s) => {
        const str = String(s || '').replace(/\s+/g, ' ').trim();
        return str.length > 140 ? `${str.slice(0, 140)}…` : str;
    };
    if (result && typeof result === 'object' && result.error) return cap(result.error);
    switch (name) {
        case 'cms_list_site': return cap(`${Array.isArray(result?.pages) ? result.pages.length : 0} page(s) on the site`);
        case 'cms_get_page': return cap(`Read page ${result?.meta?.slug ? `/${result.meta.slug}` : args?.pageId}`);
        case 'cms_create_page': return cap(`Created "${result?.title || args?.title}" at /${result?.slug}`);
        case 'cms_update_page_meta': return cap(`Updated settings for ${result?.page?.slug ? `/${result.page.slug}` : args?.pageId}`);
        case 'cms_update_page_seo': return cap(`Updated SEO for ${args?.pageId}`);
        case 'cms_add_blocks': {
            const added = Array.isArray(result?.blockIds) ? result.blockIds.length : 0;
            const dropped = Array.isArray(result?.dropped) ? result.dropped.length : 0;
            return cap(`Added ${added} block(s)${dropped ? `, ${dropped} dropped (unknown type)` : ''}`);
        }
        case 'cms_update_block': return cap(`Edited ${result?.type || 'block'} ${args?.blockId}${result?.enabled === false ? ' (hidden)' : ''}`);
        case 'cms_remove_block': return cap(`Removed block ${result?.removed || args?.blockId}`);
        case 'cms_reorder_blocks': return cap(`Reordered ${Array.isArray(result?.order) ? result.order.length : 0} block(s)`);
        case 'cms_set_homepage': return cap(`Homepage is now ${result?.homepageId || args?.pageId}`);
        case 'cms_reorder_pages': return cap(`Reordered ${Array.isArray(result?.order) ? result.order.length : 0} page(s)`);
        case 'cms_update_header_nav': return cap(`${Number.isFinite(result?.navCount) ? result.navCount : 0} menu item(s) in the header`);
        // The summary is built from the PERSISTED design (builderTools
        // re-reads after the write), so this line never over-promises.
        case 'cms_update_design': return cap(result?.summary || 'Design updated');
        default: return '';
    }
}

// Tools that legitimately take NO arguments — empty args must not be treated
// as a truncated call.
const PARAMLESS_TOOLS = new Set(['cms_list_site']);

/**
 * Parse a tool call's `arguments` defensively → { args, truncated }.
 * `truncated` only fires when a NON-EMPTY string fails to parse for a tool
 * that takes parameters (the signature of a response cut off mid-call).
 */
function parseToolArgs(raw, toolName) {
    if (raw && typeof raw === 'object') return { args: raw, truncated: false };
    if (typeof raw !== 'string') return { args: {}, truncated: false };
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '{}') return { args: {}, truncated: false };
    try { return { args: JSON.parse(trimmed), truncated: false }; }
    catch { return { args: {}, truncated: !PARAMLESS_TOOLS.has(toolName) }; }
}

/** JSON-safe truncation for model-facing tool messages (never cuts mid-JSON). */
function truncateJson(result, maxChars = 30_000) {
    let s;
    try { s = JSON.stringify(result); } catch (_) { return JSON.stringify({ error: 'unserializable tool result' }); }
    if (typeof s !== 'string') return JSON.stringify(null);
    if (s.length <= maxChars) return s;
    return JSON.stringify({ _truncated: true, preview: s.slice(0, Math.max(0, maxChars - 200)) });
}

// THIS route's SSE thinking shapes: no partId on start/stop; deltas go out
// as { delta } (the frontend renders a single rolling thinking bubble).
const CMS_SSE_THINKING = {
    start: (send) => send('thinking_start', {}),
    delta: (send, { text }) => send('thinking', { delta: text }),
    stop: (send) => send('thinking_stop', {}),
};

// Retry/assembly shell shared with the other builders (builderShared.js);
// this wrapper pins the route's thinking emitter and log prefix.
function streamWithRetry(adapter, cfg, modelId, messages, options, opts = {}) {
    return sharedStreamWithRetry(adapter, cfg, modelId, messages, options, {
        emitThinking: CMS_SSE_THINKING,
        logPrefix: '[CmsBuilder]',
        ...opts,
    });
}

module.exports = router;
// Internals exposed for unit tests (server/routes/ai/cmsBuilder.test.js).
module.exports._test = {
    parseToolArgs,
    isTransientChatError,
    streamWithRetry,
    applyBuilderTierFloor,
    sanitizeHistory,
    sanitizeEditorContext,
    renderEditorContextNote,
    renderValidationNote,
    renderBlockFeedbackNote,
    summariseToolResult,
    labelForTool,
    truncateJson,
    VALIDATION_NOTE_PREFIX,
    DRAFT_STATE_PREFIX,
    EDITOR_CONTEXT_PREFIX,
    BLOCK_FEEDBACK_PREFIX,
};
