/**
 * App Studio — the streaming AI-browse bridge.
 *
 * ONE endpoint, POST /:id/actions/:actionId/step/stream, mounted at
 * /api/studio-apps alongside the other studio routers (inherits the app_studio
 * capability gate). It runs EXACTLY ONE server step, which must resolve by
 * pre-order index to an `ai_browse` kind, and forwards the browse driver's
 * screenshot/action events to the client over SSE while it runs.
 *
 * Transport is SSE-over-POST with `data:`-only JSON frames — the exact shape
 * routes/studioAppsRun.js /ai/chat uses — plus a 15 s heartbeat (a browse can
 * wait up to 45 s for a browser slot, longer than any proxy idle timeout).
 * Client disconnect flips a cancelled flag the driver honours, which frees the
 * shared browser slot.
 *
 * Gates copy /step's order (auth → limiters → visibility → draft rule → step
 * resolved from the DEFINITION by index → role gate → per-app aiBrowsing gate,
 * the last inside browseStep). Wire contract:
 *   {type:'queued'|'start'|'frame'|'action'|'end'|'ping'|'result'|'done', …}
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * The body is the one useActionRunner.dispatchBrowseStep builds —
 * `{ stepIndex, formValues, vars, item?, index?, value? }` — and `?draft=1`.
 * Both are `.strict()` now, and writing them down showed three keys this route
 * never read:
 *
 *   - `item`, `index` and `value` arrived and were DROPPED. They are declared
 *     scope roots (buildServerScope), so an ai_browse step inside a loop —
 *     "for each supplier, open `item.website` and find the price" — resolved
 *     its task and URL with `item` undefined, and the owner's browser slot and
 *     model quota went on browsing nothing. The /step route passes all three;
 *     this one does now too.
 *   - `?draft=yes` (anything but '1' / 'true') silently ran the PUBLISHED
 *     definition while the owner was testing their draft.
 *   - `stepIndex: 1.5` or `"1abc"` went through parseInt and ran step 1.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { HttpError } = require('../core/http/errors');
const { z } = require('zod');

const studioAppDataStore = require('../stores/studioAppDataStore');
const rlsGateway = require('../appStudio/rlsGateway');
const actionExecutor = require('../appStudio/actionExecutor');
const { normalizeSequence, flattenSteps, sanitizeBag } = require('../appStudio/actionSequence');
const { loadVisibleApp, assertActionRoleAccess } = require('./studioAppRunGate');
const { resolveAudienceContext } = require('../auth/audience');
const { requireAuth } = require('../auth/permissions');
const { browseStepLimiter, aiStepLimiter } = require('./studioAppRateLimits');

const MAX_BODY_BYTES = 64 * 1024;
const jsonBody = express.json({ limit: MAX_BODY_BYTES });
// A browse holds a browser slot up to 90 s + up to 45 s queue wait; the hard
// server cap is above that sum so a real browse finishes and only a hang is cut.
const BROWSE_HARD_MS = parseInt(process.env.STUDIO_APP_BROWSE_HARD_MS, 10) || 240_000;
const HEARTBEAT_MS = 15_000;

// The driver's event names → the step-stream wire types. Frame/action payloads
// are byte-identical to what agent-hub/useChatEngine already consumes.
const EVENT_MAP = {
    browser_session_queued: 'queued',
    browser_session_start: 'start',
    browser_frame: 'frame',
    browser_action: 'action',
    browser_session_end: 'end',
};

/** An object that also accepts nothing at all — an absent part reads as `{}`. */
const partOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape).strict(),
);

const STEP_TEXT = 'stepIndex is the position of the step in the action (0, 1, 2, …).';
const DRAFT_TEXT = 'draft is "1" or "true" to run the draft, "0" or "false" (or nothing) for the published app.';
const BAG_TEXT = (name) => `${name} is an object of values, keyed by name.`;

const BrowseQuery = partOf({
    draft: z.enum(['1', 'true', '0', 'false'], { errorMap: () => ({ message: DRAFT_TEXT }) }).optional(),
});

const BrowseBody = partOf({
    // A number, or its digits as text — never parseInt's reading of "1abc".
    // Every branch carries the sentence: a union answers with the first branch
    // that reached a CHECK, so the errorMap alone would leak "Expected integer".
    stepIndex: z.union([
        z.number().int(STEP_TEXT).min(0, STEP_TEXT),
        z.string().regex(/^\d+$/, STEP_TEXT).transform(Number),
    ], { errorMap: () => ({ message: STEP_TEXT }) }),
    // Their contents are sanitizeBag's to bound; the schema only asks for a map.
    formValues: z.record(z.unknown(), { invalid_type_error: BAG_TEXT('formValues') }).nullish(),
    vars: z.record(z.unknown(), { invalid_type_error: BAG_TEXT('vars') }).nullish(),
    // The loop's row, its position and the trigger's value: client-supplied
    // scope roots, bounded by the 64KB body cap like everything else here.
    item: z.unknown(),
    index: z.number({ invalid_type_error: 'index is the loop position (0, 1, 2, …).' })
        .int('index is the loop position (0, 1, 2, …).').min(0, 'index is the loop position (0, 1, 2, …).').optional(),
    value: z.unknown(),
});

router.post('/:id/actions/:actionId/step/stream', requireAuth, jsonBody, validate({ query: BrowseQuery, body: BrowseBody }), async (req, res) => {
    // Body cap (mirrors bodySizeGuard) before anything else.
    try {
        if (req.body && typeof req.body === 'object' && Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_BODY_BYTES) {
            return res.status(413).json({ error: 'Request body too large (max 64KB)' });
        }
    } catch { return res.status(413).json({ error: 'Request body too large (max 64KB)' }); }

    // Rate limits: the tight browse bucket + the shared AI-step bucket (a browse
    // is a model-driven agent loop).
    let allowed = false;
    browseStepLimiter(req, res, () => { allowed = true; });
    if (!allowed) return;
    allowed = false;
    aiStepLimiter(req, res, () => { allowed = true; });
    if (!allowed) return;

    try {
        const userId = req.session.user.id;
        const actionId = req.params.actionId;
        const app = await loadVisibleApp(req, res);
        if (!app) return;

        const isOwner = app.userId === userId;
        const wantDraft = req.query.draft === '1' || req.query.draft === 'true';
        const def = (isOwner && wantDraft) ? app.definition : app.publishedDefinition;

        const action = (def && typeof def === 'object' && def.actions && typeof def.actions === 'object'
            && Object.hasOwn(def.actions, actionId)) ? def.actions[actionId] : null;
        if (!action) return res.status(404).json({ error: 'Action not found' });

        const { stepIndex } = req.body;
        const steps = flattenSteps(normalizeSequence(action));
        const step = stepIndex < steps.length ? steps[stepIndex] : null;
        if (!step || typeof step.kind !== 'string') return res.status(404).json({ error: 'Step not found' });
        // This endpoint runs ONLY ai_browse. Anything else belongs on /step.
        if (step.kind !== 'ai_browse') return res.status(400).json({ error: 'This endpoint only runs ai_browse steps' });

        // Role gate BEFORE opening the stream — a 403 is JSON, not an SSE frame.
        const { userGroups } = await resolveAudienceContext(req);
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
        const dataModel = (meta && meta.model) ? meta.model : null;
        const role = await rlsGateway.resolveViewerRole(app, userId, dataModel, { userGroups });
        if (!assertActionRoleAccess(res, def, actionId, role, { isOwner })) return;
        // A role-less viewer must not spend the owner's browser slot / model quota.
        if (!isOwner && !role) return res.status(403).json({ error: 'You do not have access to this app yet' });

        // ── Open the SSE stream ──────────────────────────────────────────
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ } };
        const bridge = (event, data) => {
            const type = EVENT_MAP[event];
            if (type) send({ type, ...data });
        };

        let cancelled = false;
        const onClose = () => { cancelled = true; };
        req.on('close', onClose);
        const hardTimer = setTimeout(() => { cancelled = true; }, BROWSE_HARD_MS);
        const heartbeat = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS);

        try {
            const formValues = sanitizeBag(req.body.formValues);
            const vars = sanitizeBag(req.body.vars);
            const result = await actionExecutor.executeDataStep(app, dataModel, step, {
                viewerId: userId,
                viewerName: req.session.user.name || null,
                viewerEmail: req.session.user.email || null,
                role,
                orgId: app.organizationId || null,
                actionId,
                def,                                   // browseStep needs aiBrowsing
                formValues,
                vars,
                variables: Array.isArray(def && def.variables) ? def.variables : null,
                // The loop's scope roots, exactly as /step passes them — a
                // browse task or URL that reads `item.website` inside a loop
                // resolved against undefined before these were forwarded.
                item: req.body.item,
                index: req.body.index,
                value: req.body.value,
                browse: { send: bridge, isCancelled: () => cancelled },
            });
            send({ type: 'result', ok: !!result?.ok, result: result?.result || null, error: result?.error || null, code: result?.code || null });
            send({ type: 'done' });
        } catch (e) {
            log.error(`[StudioAppBrowse] ${e.message}`);
            send({ type: 'result', ok: false, error: 'The browse step failed' });
            send({ type: 'done' });
        } finally {
            clearInterval(heartbeat);
            clearTimeout(hardTimer);
            req.off('close', onClose);
            res.end();
        }
    } catch (err) {
        log.error(`[StudioAppBrowse] ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Browse failed' });
        else { try { res.write(`data: ${JSON.stringify({ type: 'result', ok: false, error: 'Browse failed' })}\n\n`); } catch { /* gone */ } res.end(); }
    }
});

// Body-parser failures → JSON (mirrors studioAppsRun).
router.use((err, req, res, next) => {
    // A schema refusal already names its field in words; the terminal handler
    // answers it with those details instead of this generic sentence.
    if (err instanceof HttpError) return next(err);
    if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
        return res.status(413).json({ error: 'Request body too large (max 64KB)' });
    }
    log.error(`[StudioAppBrowse] body parse error: ${err?.message}`);
    return res.status(400).json({ error: 'Invalid request body' });
});

module.exports = router;
