// @typecheck
/**
 * Automation Builder — "Find repeating work": the scan (POST /suggest, SSE),
 * the sources it can read (GET /suggest/sources), the viewer's last scan
 * (GET /suggest/last) and the reactions that hide a result next time
 * (POST /feedback).
 *
 * A thin adapter. The work lives in automation/patterns/:
 *   mode 'patterns' (default)  pipeline.js: a deterministic miner over the
 *                              user's own activity; the model only names what
 *                              it found, from de-identified evidence cards
 *   mode 'ideas'               ideation.js: the model-led tool loop, for the
 *                              meeting-notes RulesPanel and the "Suggest ideas
 *                              instead" link
 * Both read through one scan reader (patterns/scanReader.js): the Shield's
 * tool block lists, the egress ledger under source `pattern_scan`.
 *
 * Privacy, decided here:
 *   - the policy is resolved with honourAutomationOptOut: false. The scan is
 *     not an automation, so an org's "Apply to automations: off" does not unshield it;
 *   - cache and feedback are per USER (`user:<id>`), and the user is in the
 *     cache key too: /suggest/last never serves a colleague's scan;
 *   - suppression runs after the cache read, so a pattern snoozed or built
 *     since the scan does not come back from the cache;
 *   - the client's disconnect aborts the sources and the model call.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Both bodies are zod schemas, behind the beta gate so a 403 stays a 403:
 *   - `mode` is patterns or ideas; `sources` names source groups or apps
 *     ([] or absent: every connected one). The older `integrationIds` is
 *     still read: as the ideas mode's app list, and as `sources` when a
 *     patterns scan sends no `sources`;
 *   - `integrationIds` that is not a list of app ids is a 400 (it used to
 *     become "no selection", which means EVERY app);
 *   - `focus` is at most 2000 characters (the RulesPanel sends a ~200-character
 *     preamble before the user's own words); past it is a 400, not a cut;
 *   - `timezone` is the viewer's IANA zone (the browser's). A patterns scan
 *     counts weekdays and hours in it, so a card says "Mon 09–10" for the
 *     hour the person keeps. A zone this server does not know, or none,
 *     means UTC; it is never a 400, because an odd browser zone must not cost
 *     the scan.
 *
 * The feedback `suggestion` is the scan's own object echoed back, so it may
 * carry keys this route never reads: it is `.passthrough()`, and what IS
 * stored is picked field by field.
 *
 * Collaborators are injected (createSuggestionsRouter(deps)); the default
 * export is the router on the real ones.
 */

const express = require('express');
const { z } = require('zod');
const log = require('../../../telemetry/log');
const { depsWith } = require('../../../automation/patterns/depsWith');
const { validate } = require('../../../core/http/validate');
const { HttpError } = require('../../../core/http/errors');
const { scanCacheKey } = require('../../../automation/patterns/pipeline');
const { isTimeZone } = require('../../../automation/patterns/periodicity');
const { asToolExecutor } = require('../../../automation/patterns/scanReader');
const { integrationOf } = require('../../../automation/patterns/ideation');
const { fingerprintTitle } = require('../../../automation/suggestions');
const { usageLogFields } = require('../../../core/providers/usageNormalizer');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const MODES = ['patterns', 'ideas'];
const FOCUS_MAX_CHARS = 2000;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const INTEGRATIONS_TEXT = 'integrationIds is a list of app ids, like ["gmail", "google-drive"] — or [] for all of them.';
const SOURCES_TEXT = 'sources is a list of source ids, like ["mail", "files"] — or [] for all of them.';
const MODE_TEXT = 'mode is patterns or ideas.';
const TIMEZONE_TEXT = 'timezone is an IANA zone name, like Europe/Amsterdam.';
const idList = (text, max) => z.array(worded(text).trim().min(1, text).max(100, text), { invalid_type_error: text }).max(max, text);

const SuggestBody = z.object({
    mode: z.enum(/** @type {[string, ...string[]]} */ (MODES), { errorMap: () => ({ message: MODE_TEXT }) }),
    sources: idList(SOURCES_TEXT, 50),
    integrationIds: idList(INTEGRATIONS_TEXT, 200),
    focus: worded('focus is text: what the scan should look for.')
        .max(FOCUS_MAX_CHARS, `A focus is at most ${FOCUS_MAX_CHARS} characters.`),
    timezone: worded(TIMEZONE_TEXT).trim().max(64, TIMEZONE_TEXT),
    // Re-scan / Try-again bypasses the server-side cache.
    force: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v),
        z.boolean({ invalid_type_error: 'force is true or false.' })),
}).partial().strict();

const LastQuery = z.object({
    mode: z.enum(/** @type {[string, ...string[]]} */ (MODES), { errorMap: () => ({ message: MODE_TEXT }) }).optional(),
});

// The store's own lists are the source of truth, read when they are needed.
const feedbackLists = () => require('../../../stores/suggestionFeedbackStore');
const ACTION_TEXT = 'action is dismissed, built, asked, snoozed or opened.';
const REASON_CODE_TEXT = 'reasonCode is wrong_grouping, do_myself, already_automated or privacy.';
const TITLE_TEXT = 'suggestion.title is required.';
const LIST_TEXT = 'suggestion.requiredIntegrations is a list of app ids.';
const SIGNATURE_TEXT = 'signature is the pattern signature the scan returned.';
const FeedbackBody = z.object({
    action: worded(ACTION_TEXT).trim().refine((a) => feedbackLists().VALID_ACTIONS.includes(a), ACTION_TEXT),
    signature: worded(SIGNATURE_TEXT).trim().regex(/^[A-Za-z0-9_-]{8,128}$/, SIGNATURE_TEXT).nullish(),
    reasonCode: worded(REASON_CODE_TEXT).trim().refine((c) => feedbackLists().VALID_REASON_CODES.includes(c), REASON_CODE_TEXT).nullish(),
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

/** Every collaborator, loaded on first use unless a test passed its own. */
const LOADERS = {
    requireAuth: () => require('../../../auth/permissions').requireAuth,
    suggestRateLimit: () => require('./rateLimits').suggestRateLimit,
    feedbackRateLimit: () => require('./rateLimits').feedbackRateLimit,
    userHasBetaFeature: () => require('../../../core/entitlements/betaFeatures').userHasBetaFeature,
    setupSSE: () => require('../../../core/http/sseHelpers').setupSSE,
    startSseHeartbeat: () => require('../../../core/http/sseHelpers').startSseHeartbeat,
    getIntegrationTools: () => require('../../../core/integrations/integrationTools').getIntegrationTools,
    resolveIntegration: () => require('../../../core/integrations/integrationToolMap').resolveIntegration,
    isEUModeActive: () => require('../../../core/llm/modelResolver').isEUModeActive,
    resolveModelForTierName: () => require('../../../core/llm/modelResolver').resolveModelForTierName,
    llmClient: () => require('../../../core/llm/llmClient'),
    safety: () => require('../../../core/automationRunner/safety'),
    scanCache: () => require('../../../stores/suggestionScanCache'),
    feedbackStore: () => require('../../../stores/suggestionFeedbackStore'),
    logUsage: () => require('../../../stores/usageStore').logUsage,
    listSourceGroups: () => require('../../../automation/patterns/sources').listSourceGroups,
    makeScanReader: () => require('../../../automation/patterns/scanReader').makeScanReader,
    runPatternScan: () => require('../../../automation/patterns/pipeline').runPatternScan,
    suppressSuggestions: () => require('../../../automation/patterns/pipeline').suppressSuggestions,
    runIdeasScan: () => require('../../../automation/patterns/ideation').runIdeasScan,
    suppressIdeas: () => require('../../../automation/patterns/ideation').suppressIdeas,
    now: () => Date.now,
};

const cleanFocus = (focus) => String(focus || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanIds = (list) => [...new Set((list || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];

/** The user's tools: the definitions, their names and the integrations they belong to. */
async function loadTools(d, req) {
    let tools = [];
    try {
        const r = await d.getIntegrationTools({ userId: req.session.user.id, session: req.session, isAdmin: !!req.session?.isAdmin, automationStep: true });
        tools = Array.isArray(r?.tools) ? r.tools : [];
    } catch (err) {
        log.warn('[RepeatingWork] could not load the user\'s tools:', err?.message);
    }
    const names = new Set();
    const integrationIds = new Set();
    for (const t of tools) {
        const name = t?.function?.name;
        if (!name) continue;
        names.add(name);
        integrationIds.add(integrationOf(d.resolveIntegration, name));
    }
    return { tools, names, integrationIds };
}

/** One usage row per scan model call: chatForcedTool and runToolLoop log nothing themselves. */
async function recordUsage(d, { userId, orgId, modelId, usage, mode, startedAt }) {
    if (!usage) return;
    try {
        await d.logUsage({
            user_id: userId, organization_id: orgId || null, agent_name: `repeating-work-${mode}`, agent_type: 'system',
            model: modelId, ...usageLogFields(usage), source: 'pattern_scan', duration_ms: d.now() - startedAt,
        });
    } catch (err) {
        log.warn('[RepeatingWork] usage not logged:', err?.message);
    }
}

/**
 * @param {Record<string, any>|null} [deps] collaborators to replace (tests)
 */
function createSuggestionsRouter(deps = null) {
    const d = depsWith(LOADERS, deps);
    const router = express.Router();

    const hasBeta = (req) => d.userHasBetaFeature(req.session.user.id, 'automations', req.session);
    /** The Automations beta gate, ahead of the schema so a 403 stays a 403. */
    const requireAutomationsBeta = async (req, res, next) => {
        if (!await hasBeta(req)) {
            return res.status(403).json({ error: 'The Automations beta is not enabled for your organisation.' });
        }
        return next();
    };

    const suppressFor = (mode, suggestions, userId) => (mode === 'ideas'
        ? d.suppressIdeas(suggestions, { userId })
        : d.suppressSuggestions(suggestions, { userId, now: d.now() }));

    /** A fresh cache hit, re-checked against the user's feedback; null on a miss or a store hiccup. */
    async function cachedScan({ scopeKey, cacheKey, mode, userId }) {
        try {
            // The clock that set expiresAt on the write decides freshness on the read.
            const hit = await d.scanCache.getCachedScan({ scopeKey, cacheKey, now: d.now() });
            if (!hit || !Array.isArray(hit.suggestions)) return null;
            return { ...hit, suggestions: await suppressFor(mode, hit.suggestions, userId) };
        } catch (err) {
            log.warn('[RepeatingWork] cache read failed, scanning live:', err?.message);
            return null;
        }
    }

    /**
     * GET /suggest/sources — the source groups a patterns scan can read, with
     * each app's connection state.
     */
    router.get('/suggest/sources', d.requireAuth, requireAutomationsBeta, async (req, res) => {
        const { names } = await loadTools(d, req);
        res.json(d.listSourceGroups(names));
    });

    /**
     * POST /suggest — one scan, streamed (SSE).
     *
     * Events: model {eu}; phase {phase}; patterns: source_step, stats,
     * suggestion {suggestion}; ideas: scan_step; then done {suggestions,
     * summary, reason?, cached, scannedAt, mode} or error {error}.
     */
    router.post('/suggest', d.requireAuth, d.suggestRateLimit, requireAutomationsBeta, validate({ body: SuggestBody }), async (req, res) => {
        const userId = req.session.user.id;
        const orgId = req.session?.user?.organizationId || null;
        const mode = req.body.mode || 'patterns';
        const force = !!req.body.force;
        const focus = cleanFocus(req.body.focus);
        const timeZone = isTimeZone(req.body.timezone) ? req.body.timezone : null;
        const integrationIds = cleanIds(req.body.integrationIds);
        const sources = mode === 'patterns' ? cleanIds(req.body.sources ?? integrationIds) : [];
        const keyList = mode === 'patterns' ? sources : integrationIds;

        const { sendEvent, abortController, markEnded } = d.setupSSE(res);
        const stopHeartbeat = d.startSseHeartbeat(res);
        const signal = abortController.signal;
        const finish = () => { stopHeartbeat(); markEnded(); try { res.end(); } catch (_) { /* already closed */ } };
        const framing = { mode, ...(mode === 'patterns' ? { sources } : {}), focus };

        try {
            const tools = await loadTools(d, req);
            if (mode === 'ideas' && tools.integrationIds.size === 0) {
                sendEvent('done', { suggestions: [], reason: 'no_integrations', cached: false, ...framing });
                return finish();
            }

            const scopeKey = d.scanCache.deriveScopeKey({ userId });
            const cacheKey = scanCacheKey({ userId, mode, sources: keyList, focus, now: d.now(), timeZone: mode === 'patterns' ? timeZone : null });
            let eu = false;
            try { eu = !!(await d.isEUModeActive({ userOrgId: orgId, userId }))?.isEU; } catch (_) { /* transparency only */ }

            if (!force) {
                const hit = await cachedScan({ scopeKey, cacheKey, mode, userId });
                if (hit) {
                    sendEvent('model', { eu });
                    sendEvent('done', {
                        suggestions: hit.suggestions, summary: hit.summary || null, reason: hit.reason || undefined,
                        cached: true, scannedAt: hit.scannedAt, ...framing,
                    });
                    return finish();
                }
            }

            // ── Shield policy: always on for the scan, whatever automations do ──
            const guardCtx = { orgId, userId, automationId: null, automationTitle: 'Suggestion scan', runId: null };
            const policy = await d.safety.resolveAutomationPolicy(guardCtx, { honourAutomationOptOut: false });
            const auditBase = d.safety.buildAuditBase(guardCtx, { id: 'scan' }, { source: 'pattern_scan' });
            const reader = d.makeScanReader({ userId, orgId, session: req.session, policy, auditBase, signal });
            const modelId = await d.resolveModelForTierName('fast', { userOrgId: orgId, userId, fallback: 'gemini-2.0-flash-lite' });
            sendEvent('model', { eu });

            const startedAt = d.now();
            const usageOf = (usage) => recordUsage(d, { userId, orgId, modelId, usage, mode, startedAt });
            let result = null;
            if (mode === 'ideas') {
                result = await d.runIdeasScan({
                    userId, orgId, integrationIds, focus, tools: tools.tools, availableIntegrationIds: tools.integrationIds,
                    modelId, policy, auditBase, guardCtx, reader, send: sendEvent, signal,
                });
                if (result) await usageOf(result.usage);
            } else {
                const scan = d.runPatternScan({
                    userId, sources, focus, signal, timeZone,
                    availableToolNames: tools.names, availableIntegrationIds: tools.integrationIds,
                    executeTool: asToolExecutor(reader),
                    nextcloudUid: req.session?.nextcloudUid || null,
                    naming: {
                        modelId, llmClient: d.llmClient,
                        guard: (messages) => d.safety.guardAiInput(messages, policy, auditBase, 'live', guardCtx),
                    },
                });
                for await (const { event, data } of scan) {
                    if (event === 'result') result = data;
                    else sendEvent(event, data);
                }
                if (result) await usageOf(result.usage);
            }
            if (!result || signal.aborted) return finish();

            const { suggestions, summary, reason } = result;
            const scannedAt = new Date(d.now()).toISOString();
            log.info('[RepeatingWork] scan user=%s mode=%s model=%s suggestions=%s reason=%s',
                userId, mode, modelId, suggestions.length, reason || '-');
            try {
                await d.scanCache.upsertScan({
                    scopeKey, cacheKey, userId, organizationId: orgId, mode, focus,
                    integrationIds: keyList, suggestions, summary, reason: reason || null,
                    model: modelId, eu, expiresAt: new Date(d.now() + CACHE_TTL_MS),
                });
            } catch (err) {
                log.warn('[RepeatingWork] cache write failed:', err?.message);
            }
            sendEvent('done', { suggestions, summary, reason: reason || undefined, cached: false, scannedAt, ...framing });
            finish();
        } catch (e) {
            if (!signal.aborted) log.error('[RepeatingWork] scan failed:', e?.message);
            try {
                sendEvent('error', { error: mode === 'ideas'
                    ? 'Could not generate ideas right now. Please try again.'
                    : 'Could not finish the scan right now. Please try again.' });
            } catch (_) { /* stream gone */ }
            finish();
        }
    });

    /**
     * GET /suggest/last?mode= — the viewer's most recent scan of that mode
     * (patterns by default), re-checked against their feedback. 204 when there
     * is none, the beta is off, or the store is unavailable: the page then
     * simply starts empty.
     */
    router.get('/suggest/last', d.requireAuth, validate({ query: LastQuery }), async (req, res) => {
        const userId = req.session.user.id;
        const mode = req.query.mode || 'patterns';
        let last = null;
        let suggestions = [];
        try {
            if (!await hasBeta(req)) return res.status(204).end();
            last = await d.scanCache.getLatestScan({ scopeKey: d.scanCache.deriveScopeKey({ userId }), mode });
            if (!last || !Array.isArray(last.suggestions)) return res.status(204).end();
            suggestions = await suppressFor(mode, last.suggestions, userId);
        } catch (err) {
            log.warn('[RepeatingWork] last scan unavailable:', err?.message);
            return res.status(204).end();
        }
        const stored = typeof last.integrationIds === 'string' ? last.integrationIds.split(',').filter(Boolean) : [];
        res.json({
            suggestions,
            summary: last.summary || null,
            reason: last.reason || undefined,
            scannedAt: last.scannedAt,
            eu: !!last.eu,
            cached: true,
            mode,
            ...(mode === 'patterns' ? { sources: stored } : {}),
            focus: last.focus || '',
        });
    });

    /**
     * POST /feedback — the viewer's reaction to a result. Keyed by the
     * pattern's signature when there is one (stable across the model's
     * wording), else by the title (ideas). `dismissed`, `snoozed` and
     * `opened` lapse after 30 days; `built` and `asked` stay. A dismiss or a
     * snooze also strips the result from the viewer's cached scans.
     */
    router.post('/feedback', d.requireAuth, d.feedbackRateLimit, requireAutomationsBeta, validate({ body: FeedbackBody }), async (req, res) => {
        const userId = req.session.user.id;
        const orgId = req.session?.user?.organizationId || null;
        const { action, suggestion: s } = req.body;
        const signature = req.body.signature || null;
        const reasonCode = req.body.reasonCode || null;
        if (reasonCode && action !== 'dismissed') {
            throw new HttpError(400, 'reason_code_needs_dismiss', 'A reasonCode goes with action dismissed only.');
        }
        const pattern = s.pattern && typeof s.pattern === 'object' ? s.pattern : {};
        const titleFingerprint = fingerprintTitle(s.title, s.buildPrompt || '');
        await d.feedbackStore.saveSuggestionFeedback({
            userId, organizationId: orgId, action, reason: req.body.reason || null, reasonCode, signature, titleFingerprint,
            ttlDays: undefined, // the store's default: 30 days for the actions that lapse
            // Template-safe fields only: never the build prompt, the
            // description or the evidence the client echoed back.
            suggestion: {
                title: s.title,
                kind: pattern.kind,
                signature,
                apps: Array.isArray(pattern.apps) ? pattern.apps : s.requiredIntegrations,
                template: pattern.template,
            },
        });

        if (action === 'dismissed' || action === 'snoozed') {
            const delId = typeof s.id === 'string' ? s.id : null;
            try {
                await d.scanCache.removeSuggestionsFromScope({
                    scopeKey: d.scanCache.deriveScopeKey({ userId }),
                    predicate: (stored) => {
                        if (!stored) return false;
                        if (delId && stored.id === delId) return true;
                        if (signature && stored.pattern?.signature === signature) return true;
                        return !signature && fingerprintTitle(stored.title || '', stored.buildPrompt || '') === titleFingerprint;
                    },
                });
            } catch (err) {
                // The feedback row already hides it from the next scan.
                log.warn('[RepeatingWork] cached result not stripped:', err?.message);
            }
        }
        res.json({ ok: true });
    });

    return router;
}

// The real router is built on its first request, so requiring this module
// (a test after createSuggestionsRouter) loads no auth, store or model code.
/** @type {import('express').Router|null} */
let defaultRouter = null;
function suggestionsRouter(req, res, next) {
    if (!defaultRouter) defaultRouter = createSuggestionsRouter();
    return defaultRouter(req, res, next);
}

module.exports = suggestionsRouter;
module.exports.createSuggestionsRouter = createSuggestionsRouter;
