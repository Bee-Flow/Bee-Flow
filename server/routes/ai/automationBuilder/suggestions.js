/**
 * Automation Builder — "Find repeating work": the bounded, read-only agentic
 * scan of the user's connected tools (POST /suggest), the last cached scan
 * (GET /suggest/last), and the dismissed / built / asked reactions that
 * suppress ideas in future scans (POST /feedback).
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Both bodies are zod schemas, behind the beta gate so a 403 stays a 403.
 * What the hand-rolled reads let through under a 200:
 *
 *   - `integrationIds` that was not an array — one app as a string, a
 *     misspelled key, a list of blanks — became "no selection", and no
 *     selection means EVERY connected app: someone who picked Gmail had
 *     Drive, Outlook and the rest read into a model as well. `[]` still
 *     means all apps (the meeting-notes panel sends it on purpose); anything
 *     that is not a list of app ids is a 400;
 *   - `focus` was cut at 280 characters without a word. The meeting-notes
 *     panel sends a ~200-character preamble before "Wanted: <what the user
 *     typed>", so about 80 characters of the user's own ask reached the
 *     model. The cap is 2000 now, and past it is a 400, not a cut;
 *   - `focus` that was not text, or `force` as anything but a boolean (the
 *     text 'true' / 'false' is still read as one), was ignored.
 *
 * The feedback `suggestion` is the scan's own object echoed back, so it may
 * carry keys this route never reads (evidence, value, triggerKind, …): it is
 * `.passthrough()`, and the five fields that ARE stored are picked by name.
 */

const express = require('express');
const { z } = require('zod');
const log = require('../../../telemetry/log');
const router = express.Router();

const automationStore = require('../../../stores/automationStore');
const { isEUModeActive, resolveModelForTierName } = require('../../../core/llm/modelResolver');
const llmClient = require('../../../core/llm/llmClient');
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { suggestRateLimit, feedbackRateLimit } = require('./rateLimits');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const FOCUS_MAX_CHARS = 2000;
const INTEGRATIONS_TEXT = 'integrationIds is a list of app ids, like ["gmail", "google-drive"] — or [] for all of them.';
const SuggestBody = z.object({
    integrationIds: z.array(worded(INTEGRATIONS_TEXT).trim().min(1, INTEGRATIONS_TEXT).max(100, INTEGRATIONS_TEXT),
        { invalid_type_error: INTEGRATIONS_TEXT }).max(200, INTEGRATIONS_TEXT),
    focus: worded('focus is text: what the scan should look for.')
        .max(FOCUS_MAX_CHARS, `A focus is at most ${FOCUS_MAX_CHARS} characters.`),
    // Re-scan / Try-again bypasses the server-side cache.
    force: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v),
        z.boolean({ invalid_type_error: 'force is true or false.' })),
}).partial().strict();

const ACTION_TEXT = 'action is dismissed, built or asked.';
const TITLE_TEXT = 'suggestion.title is required.';
const LIST_TEXT = 'suggestion.requiredIntegrations is a list of app ids.';
const FeedbackBody = z.object({
    // The store's own list is the source of truth, read when it is needed.
    action: worded(ACTION_TEXT).trim()
        .refine((a) => require('../../../stores/suggestionFeedbackStore').VALID_ACTIONS.includes(a), ACTION_TEXT),
    suggestion: z.object({
        id: z.string({ invalid_type_error: 'suggestion.id must be text.' }).max(200).nullish(),
        title: worded(TITLE_TEXT).min(1, TITLE_TEXT).max(200, 'suggestion.title is at most 200 characters.'),
        buildPrompt: z.string({ invalid_type_error: 'suggestion.buildPrompt must be text.' }).max(20_000).nullish(),
        complexity: z.string({ invalid_type_error: 'suggestion.complexity must be text.' }).max(40).nullish(),
        requiredIntegrations: z.array(z.string({ invalid_type_error: LIST_TEXT }), { invalid_type_error: LIST_TEXT }).max(100).nullish(),
        groundedIn: z.string({ invalid_type_error: 'suggestion.groundedIn must be text.' }).max(40).nullish(),
    }, { required_error: TITLE_TEXT, invalid_type_error: 'suggestion is the suggestion the scan returned.' }).passthrough(),
    reason: z.string({ invalid_type_error: 'reason must be text.' }).max(300, 'A reason is at most 300 characters.').nullish(),
}).strict();

/** The Automations beta gate, ahead of the schema so a 403 stays a 403. */
async function requireAutomationsBeta(req, res, next) {
    const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
    if (!await userHasBetaFeature(req.session.user.id, 'automations', req.session)) {
        return res.status(403).json({ error: 'The Automations beta is not enabled for your organisation.' });
    }
    return next();
}

// Bounds for the read-only scan loop. The model must actually READ the user's
// recent data to find concrete repeating work — the activity digest only tells
// it which tools to prioritise, not what's in them. Keep enough rounds/reads
// for that; the efficiency win is the forced structured synthesis + the 4h
// cache, NOT skipping reads.
const SUGGEST_MAX_ROUNDS = 6;
const SUGGEST_MAX_TOOL_CALLS = 12;
const SUGGEST_MAX_SUGGESTIONS = 6;
// Per-integration read cap. A scan only needs a few samples of an app to see its
// repeating patterns; without this, the model fixates on its highest-volume tool
// (e.g. Gmail) and burns the whole budget re-searching one inbox while never
// looking at the other selected apps. Capping per app keeps the scan EFFICIENT
// and BROAD. Deterministic — it doesn't rely on the model obeying a prose hint.
const SUGGEST_MAX_READS_PER_INTEGRATION = 4;

/**
 * POST /suggest — "Find repeating work" automation suggestions (SSE).
 *
 * Body: { integrationIds?: string[], focus?: string }
 *
 * Streams a bounded, READ-ONLY agentic scan of the user's connected tools
 * (search recent emails, list recent files, …). Every tool result is guarded
 * through the org/user Privacy Shield (server/core/automationRunner/safety.js) —
 * tokenize/redact/block per policy — BEFORE the model sees it, and each read is
 * audit-logged. Returns specs only — no automation definition is built here; the
 * client feeds a chosen suggestion's `buildPrompt` into the existing /stream
 * builder ("build directly" or "ask for changes").
 *
 * SSE events:
 *   phase     — { phase: 'scanning' | 'synthesising' }
 *   model     — { eu: boolean }                          (transparency)
 *   scan_step — { tool, integration, phase: 'start' | 'done', ok?, piiCategories? }
 *   done      — { suggestions, reason?, summary: { integrations, toolCalls, piiCategories } }
 *   error     — { error }
 *
 * Model output is untrusted: complexity is re-derived and required integrations
 * are intersected with what the user can use (server/automation/suggestions.js).
 */
// The beta gate and the schema run BEFORE the response switches to SSE, so
// their refusals stay clean JSON.
router.post('/suggest', requireAuth, suggestRateLimit, requireAutomationsBeta, validate({ body: SuggestBody }), async (req, res) => {
    const userId = req.session.user.id;
    const session = req.session;
    const orgId = req.session?.user?.organizationId || null;

    const { setupSSE, startSseHeartbeat } = require('../../../core/http/sseHelpers');
    const { sendEvent, abortController, markEnded } = setupSSE(res);
    const stopHeartbeat = startSseHeartbeat(res);
    const finish = () => { stopHeartbeat(); markEnded(); try { res.end(); } catch (_) { /* already closed */ } };

    try {
        const {
            buildScanSystemPrompt, buildScanDigest, parseSuggestionsJson, extractSuggestionsFromToolCall,
            normaliseSuggestions, buildActivityIndex, computeScanCacheKey, resolveActivityFilter, SUGGESTIONS_TOOL,
        } = require('../../../automation/suggestions');
        const suggestionScanCache = require('../../../stores/suggestionScanCache');
        const suggestionFeedbackStore = require('../../../stores/suggestionFeedbackStore');
        const integrationActivityStore = require('../../../stores/integrationActivityStore');
        const { getIntegrationTools } = require('../../../core/integrations/integrationTools');
        const { isSideEffect } = require('../../../automation/sideEffectMap');
        const { resolveIntegration } = require('../../../core/integrations/integrationToolMap');
        const { executeTool } = require('../../../core/tools/toolDispatcher');
        const { captureCall } = require('../../../core/http/captureCall');
        const safety = require('../../../core/automationRunner/safety');

        // ── Inputs (shape-checked by SuggestBody) ──
        const { integrationIds = [], force = false } = req.body;
        const selectedSet = new Set(integrationIds.map(s => s.toLowerCase()));
        const focus = (req.body.focus || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();

        const integOf = (toolName) => (resolveIntegration(toolName)?.integration || String(toolName).split('_')[0] || '').toLowerCase();

        // ── Build the user's tool sets ──
        let toolResult;
        try {
            toolResult = await getIntegrationTools({ userId, session, isAdmin: !!req.session?.isAdmin, routineStep: true });
        } catch (_) {
            toolResult = { tools: [] };
        }
        const allTools = Array.isArray(toolResult?.tools) ? toolResult.tools : [];

        // Full available integration set (read + write) — used to flag a
        // suggestion that references an app the user does not have at all.
        const availableIntegrationIds = new Set();
        for (const t of allTools) {
            const name = t?.function?.name;
            if (name) availableIntegrationIds.add(integOf(name));
        }
        if (availableIntegrationIds.size === 0) {
            sendEvent('done', { suggestions: [], reason: 'no_integrations' });
            return finish();
        }

        // Resolve which integrations to focus on (default: everything available).
        const focusInteg = selectedSet.size > 0
            ? [...availableIntegrationIds].filter(id => selectedSet.has(id))
            : [...availableIntegrationIds];
        if (focusInteg.length === 0) {
            sendEvent('done', { suggestions: [], reason: 'no_integrations' });
            return finish();
        }
        const focusSet = new Set(focusInteg);

        // Read-only tools within the focus set — what the model may actually call
        // while scanning. May be empty (e.g. a write-only app) → pure ideation.
        const scanTools = allTools.filter(t => {
            const name = t?.function?.name;
            return name && !isSideEffect(name) && focusSet.has(integOf(name));
        });

        // ── Cheap secondary signals (parallelised) ──
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const activityFilter = { ...resolveActivityFilter({ organizationId: orgId, userId }), startDate: since };
        const [activityRowsRaw, automationList, suppressedTitlesRaw] = await Promise.all([
            integrationActivityStore.getIntegrationByTool(activityFilter).catch(() => []),
            automationStore.getAutomationsForUser(userId).catch(() => []),
            suggestionFeedbackStore.getRecentSuppressedTitles({ organizationId: orgId, userId }).catch(() => []),
        ]);

        // Activity rows scoped to the focused integrations → grounding digest + scoring index.
        const activityByTool = (activityRowsRaw || []).filter(r =>
            r && r.tool_name && Number(r.total) > 0 && focusSet.has(String(r.integration_type || '').toLowerCase()));
        const activityIndex = buildActivityIndex(activityByTool);

        // Suppress ideas the user already automated AND ones they dismissed/built/asked about.
        const ownTitles = (automationList || []).map(a => a.title).filter(Boolean).slice(0, 50);
        const existingTitles = [...new Set([...ownTitles, ...(suppressedTitlesRaw || [])])];

        // ── Cache scope/key (the rate limiter already gated this request) ──
        const scopeKey = suggestionScanCache.deriveScopeKey({ organizationId: orgId, userId });
        const cacheKey = computeScanCacheKey({ focusInteg, focus, existingTitles });

        // EU routing transparency (mirrored into the cache row).
        let euActive = false;
        try { const eu = await isEUModeActive({ userOrgId: orgId, userId }); euActive = !!(eu && eu.isEU); } catch (_) { /* transparency only */ }

        // ── Cache read: a fresh hit returns instantly (no model call) unless force ──
        if (!force) {
            try {
                const hit = await suggestionScanCache.getCachedScan({ scopeKey, cacheKey });
                if (hit && Array.isArray(hit.suggestions)) {
                    sendEvent('model', { eu: euActive });
                    sendEvent('done', {
                        suggestions: hit.suggestions,
                        summary: hit.summary || { integrations: [], toolCalls: 0, piiCategories: [] },
                        reason: hit.reason || undefined,
                        cached: true,
                        scannedAt: hit.scannedAt,
                    });
                    return finish();
                }
            } catch (_) { /* cache miss / store hiccup → fall through to a live scan */ }
        }

        // ── Privacy Shield guard policy (same pipeline the routine runner uses) ──
        const guardCtx = { orgId, userId, automationId: null, automationTitle: 'Suggestion scan', runId: null };
        const policy = await safety.resolveAutomationPolicy(guardCtx);
        const auditBase = safety.buildAuditBase(guardCtx, { id: 'scan' });
        const guardMode = 'live';

        // ── Model: 'fast' tier — re-derives complexity itself. The model does
        // live reads to find concrete patterns; the activity digest below only
        // tells it which tools are worth reading first. (EU routing honoured by
        // the resolver.) ──
        const modelId = await resolveModelForTierName('fast', { userOrgId: orgId, userId, fallback: 'gemini-2.0-flash-lite' });
        sendEvent('model', { eu: euActive });

        // Compact, PII-safe digest of the user's recent tool activity — a priority
        // hint for which tools to sample first, NOT a replacement for live reads.
        const digest = buildScanDigest({ activityByTool, existingTitles: [], focus: '', toolShapes: {} });

        const sys = buildScanSystemPrompt({
            selectedIntegrations: focusInteg, activityHints: [], existingTitles, focus, maxSuggestions: SUGGEST_MAX_SUGGESTIONS,
        });
        const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: `Recent tool activity (frequency signal):\n\n${digest}\n\nScan my connected tools for repeating work and call return_suggestions with up to ${SUGGEST_MAX_SUGGESTIONS} automation ideas.` },
        ];

        // ── Scan ──
        const scannedIntegrations = new Set();
        const allCategories = new Set();
        const readsByIntegration = new Map();
        // Apps the model can actually READ (have read-only tools in the focus set).
        // The breadth-first steer only ever points the model at apps it can sample.
        const readableIntegrations = new Set(
            scanTools.map(t => integOf(t?.function?.name)).filter(Boolean));
        let toolCalls = 0;

        // The Privacy Shield tool block lists ("Outside tools" / "Own server")
        // on the scan's reads, as in chat (BFSF-354). policy.shield is null
        // when the org keeps routines out of the shield, as the guard above.
        const shieldGate = require('../../../core/privacy/toolPiiGate').toolLoopGate({
            shield: policy.shield, tag: 'SuggestionScan',
            audit: (fields) => require('../../../stores/guardrailEventStore').logGuardrailEvent({ ...auditBase, ...fields }),
        });

        const boundedExecute = async (name, args) => {
            if (abortController.signal.aborted) return 'Scan cancelled.';
            // Defence in depth: never run a side-effecting tool during the scan.
            if (isSideEffect(name)) {
                return `Error: ${name} is a write action and is not allowed during a read-only scan.`;
            }
            const integration = integOf(name);
            const usedForInteg = readsByIntegration.get(integration) || 0;

            // Breadth-first: before a SECOND read of any app, make sure every other
            // readable selected app has been sampled at least once. Without this the
            // model fixates on its highest-volume app (Gmail) and burns the whole
            // budget there, never looking at the others the user explicitly selected.
            // A steer is a redirect — no scan_step, no global-budget spend.
            if (usedForInteg >= 1) {
                const unsampled = [...readableIntegrations]
                    .filter(i => i !== integration && !readsByIntegration.has(i));
                if (unsampled.length > 0) {
                    return `You've already looked at ${integration}. Take ONE quick look at each selected app you haven't checked yet first: ${unsampled.join(', ')}. Read one of those now, then come back to ${integration} only if you still need more signal.`;
                }
            }
            // Per-app backstop: once breadth is done, don't re-search one inbox forever.
            if (usedForInteg >= SUGGEST_MAX_READS_PER_INTEGRATION) {
                return `You've sampled ${integration} enough (${usedForInteg} reads) to see its patterns. Read a different app, or if you have enough signal, stop and call return_suggestions now.`;
            }
            toolCalls++;
            if (toolCalls > SUGGEST_MAX_TOOL_CALLS) {
                return 'Tool-call budget reached — stop scanning and call return_suggestions now.';
            }
            // Mark sampled before executing so a failed read still counts (no retry
            // loop on a broken tool, and breadth-first moves on).
            readsByIntegration.set(integration, usedForInteg + 1);
            sendEvent('scan_step', { tool: name, integration, phase: 'start' });

            const refusal = await shieldGate.refuse(name, args);
            if (refusal) {
                sendEvent('scan_step', { tool: name, integration, phase: 'done', ok: false });
                return JSON.stringify({ error: refusal.modelError });
            }

            // Inside its own capture context, so the ledger row below names
            // where the read went (and the dispatcher does not write a second).
            const readT0 = Date.now();
            const call = await captureCall(() => executeTool(name, args, { userId, session, orgId }));
            if (!call.ok) {
                const e = call.error;
                try {
                    await safety.logEgress({ toolName: name, toolArgs: args, error: e, probe: call.probe, policy, auditBase, mode: guardMode, durationMs: Date.now() - readT0 });
                } catch (_) { /* never fail the scan on logging */ }
                sendEvent('scan_step', { tool: name, integration, phase: 'done', ok: false });
                return `Error: ${e && e.message}`;
            }
            const out = call.value;

            // Guard the tool OUTPUT through the Privacy Shield before the model
            // sees it. In 'block' mode guardToolOutput throws on PII — we keep the
            // content from the model but let the scan continue on what's allowed.
            let guardedText;
            let categories = [];
            let blocked = false;
            try {
                // guardCtx is passed so every tool result in ONE scan shares a
                // token namespace: the same person read from Gmail and from
                // Drive must reach the model as the same placeholder, or it
                // will read them as two different people.
                const g = await safety.guardToolOutput(out, policy, auditBase, guardMode, guardCtx);
                guardedText = typeof g.result === 'string' ? g.result : JSON.stringify(g.result);
                categories = g.categories || [];
            } catch (e) {
                blocked = true;
                categories = (e && e.categories) || [];
                guardedText = `[withheld: contains sensitive data${categories.length ? ` (${categories.join(', ')})` : ''}]`;
            }

            // Audit-log the read (records PII categories, not raw content).
            try {
                await safety.logEgress({ toolName: name, toolArgs: args, result: out, probe: call.probe, policy, auditBase, mode: guardMode, durationMs: Date.now() - readT0 });
            } catch (_) { /* never fail the scan on logging */ }

            scannedIntegrations.add(integration);
            for (const c of categories) allCategories.add(c);
            sendEvent('scan_step', { tool: name, integration, phase: 'done', ok: !blocked, piiCategories: categories });
            // What the model reads, with the categories this tool's class
            // forbids stripped out (BFSF-354).
            return shieldGate.forModel(guardedText, name);
        };

        // The model must READ the user's actual data to find concrete repeating
        // work — the digest only says which tools to prioritise. So whenever there
        // are read-only tools, run the agentic loop (live reads) and force the
        // structured synthesis at the end. Only when there's NOTHING readable
        // (write-only apps) do we fall back to a single ideation call.
        let rounds = 0;
        let structuredOk = false;
        let rawSuggestions = [];

        sendEvent('phase', { phase: 'scanning' });
        if (scanTools.length === 0) {
            // 4096 (not 2500): the forced synthesis emits up to 6 suggestions, each
            // with a detailed buildPrompt (~1200 chars) — at 2500 the tool-call
            // JSON args can truncate mid-array and fail to parse (structured=null →
            // zero suggestions). The headroom is a ceiling, not a target.
            // reasoningEffort 'none' (like stepLabels / mapJsonFields): without
            // it a self-hosted Qwen3 thinks by template default and spends the
            // whole 4096 on reasoning → structured null → zero suggestions,
            // while burning the GPU right after every build.
            const { structured, content } = await llmClient.chatForcedTool(
                modelId, messages, SUGGESTIONS_TOOL, { maxTokens: 4096, temperature: 0.2, reasoningEffort: 'none' });
            structuredOk = !!structured;
            rawSuggestions = structured ? extractSuggestionsFromToolCall(structured) : parseSuggestionsJson(content);
        } else {
            const loop = await llmClient.runToolLoop(
                modelId, messages, scanTools,
                { maxTokens: 4096, temperature: 0.2, reasoningEffort: 'none', finalTool: SUGGESTIONS_TOOL },
                boundedExecute, SUGGEST_MAX_ROUNDS);
            rounds = loop?.toolCallRounds ?? 0;
            structuredOk = !!loop?.structured;
            rawSuggestions = loop?.structured
                ? extractSuggestionsFromToolCall(loop.structured)
                : parseSuggestionsJson(loop?.content);
        }
        sendEvent('phase', { phase: 'synthesising' });

        // Untrusted model output: re-derive complexity, clamp, dedupe, attach
        // server-computed evidence/value, and rank by value (activityIndex).
        const suggestions = normaliseSuggestions(rawSuggestions, {
            availableIntegrationIds, existingTitles, max: SUGGEST_MAX_SUGGESTIONS, activityIndex,
        });

        // Diagnostic: makes an empty result debuggable at a glance — raw=0 means
        // the model returned nothing; raw>0 but final=0 means suppression/repair
        // filtered everything.
        log.info('[automationBuilder/suggest] user=%s model=%s rounds=%s reads=%s raw=%s structured=%s final=%s existingTitles=%s',
            userId, modelId, rounds, toolCalls, Array.isArray(rawSuggestions) ? rawSuggestions.length : 0, structuredOk, suggestions.length, existingTitles.length);

        const summary = {
            integrations: [...scannedIntegrations],
            toolCalls,
            piiCategories: [...allCategories],
            rounds,
            structured: structuredOk,
        };
        const scannedAt = new Date().toISOString();
        const reason = suggestions.length ? undefined : 'no_patterns';

        // ── Cache write (best-effort; 4h TTL) ──
        try {
            await suggestionScanCache.upsertScan({
                scopeKey, cacheKey, userId, organizationId: orgId, focus,
                integrationIds: focusInteg, suggestions, summary,
                reason: reason || null, model: modelId, eu: euActive,
                expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
            });
        } catch (_) { /* cache write is best-effort */ }

        sendEvent('done', { suggestions, summary, reason, cached: false, scannedAt });
        finish();
    } catch (e) {
        log.error('[automationBuilder/suggest] error:', e.message);
        try { sendEvent('error', { error: 'Could not generate ideas right now. Please try again.' }); } catch (_) { /* stream gone */ }
        finish();
    }
});

/**
 * GET /suggest/last — the user's most recent cached scan (if any), so the
 * Routines studio can show "Last scanned X ago" + the prior results without
 * re-running the scan. 204 when there's no cached scan. Beta-gated.
 */
router.get('/suggest/last', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const orgId = req.session?.user?.organizationId || null;
        const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
        const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
        if (!hasFeature) return res.status(204).end();
        const suggestionScanCache = require('../../../stores/suggestionScanCache');
        const scopeKey = suggestionScanCache.deriveScopeKey({ organizationId: orgId, userId });
        const last = await suggestionScanCache.getLatestScan({ scopeKey });
        if (!last || !Array.isArray(last.suggestions)) return res.status(204).end();
        res.json({
            suggestions: last.suggestions,
            summary: last.summary || { integrations: [], toolCalls: 0, piiCategories: [] },
            reason: last.reason || undefined,
            scannedAt: last.scannedAt,
            eu: !!last.eu,
            cached: true,
        });
    } catch (_) {
        res.status(204).end();
    }
});

/**
 * POST /feedback — record a user's reaction to a suggestion (dismissed / built /
 * asked). Persisted as a title fingerprint so future scans suppress dismissed
 * ideas and don't re-suggest ones already acted on. Untrusted input — validated
 * + clamped. Beta-gated + rate-limited.
 */
router.post('/feedback', requireAuth, feedbackRateLimit, requireAutomationsBeta, validate({ body: FeedbackBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const orgId = req.session?.user?.organizationId || null;

        const suggestionFeedbackStore = require('../../../stores/suggestionFeedbackStore');
        const { fingerprintTitle } = require('../../../automation/suggestions');
        const { action, suggestion: s } = req.body;
        const title = s.title;
        const reason = req.body.reason || null;
        const buildPrompt = s.buildPrompt || '';
        const titleFingerprint = fingerprintTitle(title, buildPrompt);
        await suggestionFeedbackStore.saveSuggestionFeedback({
            userId, organizationId: orgId, action, reason,
            suggestion: { title, buildPrompt, complexity: s.complexity, requiredIntegrations: s.requiredIntegrations, groundedIn: s.groundedIn },
            titleFingerprint,
            ttlDays: action === 'dismissed' ? 30 : undefined,
        });

        // A "dismissed" reaction is the Delete action: also strip the suggestion
        // from the persisted scan rows so it doesn't resurface from getLatestScan
        // after a reload/restart (the feedback row above only suppresses it in
        // FUTURE scans). Best-effort — never fail the request on this.
        if (action === 'dismissed') {
            try {
                const suggestionScanCache = require('../../../stores/suggestionScanCache');
                const scopeKey = suggestionScanCache.deriveScopeKey({ organizationId: orgId, userId });
                const delId = typeof s.id === 'string' ? s.id : null;
                await suggestionScanCache.removeSuggestionsFromScope({
                    scopeKey,
                    predicate: (stored) => {
                        if (!stored) return false;
                        if (delId && stored.id === delId) return true;
                        return fingerprintTitle(stored.title || '', stored.buildPrompt || '') === titleFingerprint;
                    },
                });
            } catch (_) { /* best-effort persisted-list cleanup */ }
        }
        res.json({ ok: true });
    } catch (e) {
        log.error('[automationBuilder/feedback] error:', e.message);
        res.status(500).json({ error: 'Could not record feedback.' });
    }
});

module.exports = router;
