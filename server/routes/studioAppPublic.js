/**
 * App Studio — the PUBLIC surface of an app.
 *
 * Everything else in App Studio is behind `requireAuth`: studioApps,
 * studioAppsRun, studioAppData and studioAppFiles all resolve a session user,
 * and publishing shares with org groups — never with the open internet. This
 * router is the one exception, and it exists so an intake form and the
 * back-office that processes it can be ONE app instead of an app plus a hosted
 * automation form with a bridge between them.
 *
 * Mounted at /api/public-app, BEFORE the auth chain (like routes/automation/
 * formPublic.js). Under /api on purpose: nginx's `@render` location rewrites
 * non-2xx responses to the SPA shell, so a top-level path would turn a 400 into
 * an HTML page.
 *
 *   GET    /:token                                  render config + visitor identity
 *   POST   /:token/actions/:actionId/step           one server step of a public action
 *   GET    /:token/data/tables/:tableId/records     list, RLS-scoped to the visitor
 *   POST   /:token/data/query                       aggregate/dataset, RLS-scoped
 *   POST   /:token/data/batch                       many reads, one request (per-read statuses)
 *   POST   /:token/data/attachments                 upload one scanned file
 *   GET    /:token/data/attachments/:fileId         stream a file the visitor may read
 *   DELETE /:token/data/attachments/:fileId         discard an UNLINKED upload
 *
 * ── SECURITY MODEL ──────────────────────────────────────────────────
 *   • The URL token is the credential (studio_app_public_pages.id, 192 bits).
 *     An unknown token, a revoked page, an unpublished app and an app that
 *     never opted in all answer the SAME 404 — probing must not distinguish
 *     them.
 *   • Anonymous visitors ALWAYS get the frozen `published_definition`. There is
 *     no ?draft here at all: the bytes served to the internet are the ones that
 *     passed publish-time validation.
 *   • WHAT is public is a whitelist of SCREENS (definition.publicAccess), from
 *     which appStudio/publicAccess.js derives the only actions that may run.
 *     Back-office screens, the nav tree that names them, and every action wired
 *     only there never leave the process.
 *   • WHO the visitor is: a server-minted anonymous viewer id inside a signed
 *     visitor token (auth/publicShareToken `visitor` purpose), presented as a
 *     bearer. It becomes `created_by`, so RLS `own` scope isolates one visitor
 *     from the next. It is never client-supplied.
 *   • WHAT they may touch is the RLS gateway's answer for `publicAccess.roleKey`
 *     — this router never widens data access, and holds no opinion about tables.
 *     An app that grants that role nothing is simply a form that cannot write.
 *   • The visitor belongs to NO organisation: viewer.organizationId is null, so
 *     a row filter comparing against it cannot accidentally match the owner's
 *     org rows.
 *   • Every body and query is a closed schema except POST /data/query, whose
 *     body IS a read descriptor (or `{ datasetId }`): the query compiler
 *     checks it field by field against the table, the same as on the
 *     signed-in route, and names what it refuses. Each read inside a batch
 *     goes through that compiler too.
 *   • Every model call, mail send and file write still runs acts-as-owner and
 *     spends the OWNER's budget — hence the per-IP and per-token buckets on top
 *     of the step-kind buckets, exactly as publicShareBridge.js does.
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf } = require('../core/http/schemaParts');
// The runtime's own request shapes, shared with the signed-in routes.
const R = require('./studio/appRuntimeSchemas');
const BatchBody = bodyOf({
    // The handler answers a missing or non-list `reads` itself, with its cap.
    reads: z.unknown(),
}, 'A batch of reads');
const UploadFields = bodyOf({
    fieldKey: worded('fieldKey is the key of the form field.').max(100, 'fieldKey is at most 100 characters.').optional(),
}, 'An upload');

const studioAppStore = require('../stores/studioAppStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const storageStore = require('../stores/storageStore');
const usageStore = require('../stores/usageStore');
const rlsGateway = require('../appStudio/rlsGateway');
const actionExecutor = require('../appStudio/actionExecutor');
const attachmentAccess = require('../appStudio/attachmentAccess');
const studioAppQuota = require('../appStudio/studioAppQuota');
const mailboxAttachments = require('../appStudio/mailboxAttachments');
const dataReadRunner = require('../appStudio/dataReadRunner');
const publicAccess = require('../appStudio/publicAccess');
const { DATA_MUTATING_STEP_KINDS } = require('../appStudio/componentSpecs');
const { uploadGuard, scanBuffer } = require('../middleware/uploadGuard');
const { DATA_LIMITS } = require('../appStudio/dataModel');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { issueVisitorToken, verifyVisitorToken } = require('../auth/publicShareToken');
const { flattenSteps, normalizeSequence, sanitizeBag } = require('../appStudio/actionSequence');

const { assertAttachmentTotalBytes } = mailboxAttachments;

// ── Budgets ─────────────────────────────────────────────────────────
// Two axes, like formPublic: per IP (one abuser) and per token (one form being
// hammered). Deliberately tighter than the signed-in equivalents — there is no
// account behind these calls, and every one of them spends the owner's.
const PUB_RPM_PER_IP = parseInt(process.env.STUDIO_APP_PUBLIC_RPM_PER_IP, 10) || 60;
const PUB_RPM_PER_TOKEN = parseInt(process.env.STUDIO_APP_PUBLIC_RPM_PER_TOKEN, 10) || 240;
const PUB_STEP_RPM = parseInt(process.env.STUDIO_APP_PUBLIC_STEP_RPM, 10) || 30;
// A form that checks each upload as it arrives spends one model call PER FILE,
// not one per submission: the seven-photo intake is seven calls in the couple
// of minutes someone stands at their meter cupboard, and every retaken photo is
// another. 12/min was sized for the old submit-time batch and would have
// throttled an ordinary visitor halfway through.
const PUB_AI_STEP_RPM = parseInt(process.env.STUDIO_APP_PUBLIC_AI_STEP_RPM, 10) || 30;
const PUB_UPLOAD_RPM = parseInt(process.env.STUDIO_APP_PUBLIC_UPLOAD_RPM, 10) || 20;

const ipLimiter = perUserRateLimit({ windowMs: 60_000, max: PUB_RPM_PER_IP, keyFn: (req) => `pubapp-ip:${req.ip || 'unknown'}`, name: 'studio-public-ip' });
const tokenLimiter = perUserRateLimit({ windowMs: 60_000, max: PUB_RPM_PER_TOKEN, keyFn: (req) => `pubapp-tok:${req.params.token}`, name: 'studio-public-token' });
const stepLimiter = perUserRateLimit({ windowMs: 60_000, max: PUB_STEP_RPM, keyFn: (req) => `pubapp-step:${req.params.token}:${req.ip || 'unknown'}`, name: 'studio-public-step' });
const aiStepLimiter = perUserRateLimit({ windowMs: 60_000, max: PUB_AI_STEP_RPM, keyFn: (req) => `pubapp-ai:${req.params.token}:${req.ip || 'unknown'}`, name: 'studio-public-ai' });
const uploadLimiter = perUserRateLimit({ windowMs: 60_000, max: PUB_UPLOAD_RPM, keyFn: (req) => `pubapp-up:${req.params.token}:${req.ip || 'unknown'}`, name: 'studio-public-upload' });

// A batch carries many reads in one request, so the per-request buckets above
// stop measuring the work. This one counts READS — same reasoning, and the same
// per-token+IP granularity as the step bucket, so one visitor cannot spend the
// budget of everyone else looking at the same page.
const MAX_BATCH_READS = 25;
const PUB_READ_DESCRIPTOR_RPM = parseInt(process.env.STUDIO_APP_PUBLIC_READ_DESCRIPTOR_RPM, 10) || 300;
const readDescriptorLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: PUB_READ_DESCRIPTOR_RPM,
    keyFn: (req) => `pubapp-reads:${req.params.token}:${req.ip || 'unknown'}`,
    name: 'studio-public-read-descriptors',
    costFn: (req) => (Array.isArray(req.body && req.body.reads) ? req.body.reads.length : 1),
});

const MAX_BODY_BYTES = 64 * 1024;
const jsonBody = express.json({ limit: MAX_BODY_BYTES });
const guard = uploadGuard({ maxBytes: DATA_LIMITS.MAX_ATTACHMENT_BYTES });

// A global bodyParser.json({limit:'20mb'}) runs in index.js before this router,
// so a route-local limit would never fire — measure what actually arrived.
function bodySizeGuard(req, res, next) {
    if (req.body && typeof req.body === 'object') {
        let bytes = 0;
        try { bytes = Buffer.byteLength(JSON.stringify(req.body), 'utf8'); } catch { bytes = MAX_BODY_BYTES + 1; }
        if (bytes > MAX_BODY_BYTES) return res.status(413).json({ error: 'Request body too large (max 64KB)' });
    }
    next();
}

/** No caching, no indexing — a public app URL is a credential. */
function privateHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('X-Robots-Tag', 'noindex, nofollow');
}

const TOKEN_RE = /^[a-f0-9]{24,64}$/;

// Heavy kinds, mirroring studioAppsRun.js. They touch no table, so RLS never
// sees them — but they spend the owner's model quota, mail allowance or
// storage, which is exactly what an anonymous caller must not be able to drain.
const HEAVY_STEP_KINDS = ['run_automation', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake'];
const AI_STEP_KINDS = ['ai_extract', 'ai_generate', 'kb_query', 'redact_pdf'];

/**
 * Resolve `:token` to { page, app, definition, surface } or answer 404 and
 * return null.
 *
 * A revoked page, a deleted app, an unpublished app, an app whose definition
 * dropped `publicAccess`, and a token that never existed are ALL the same 404.
 * The token is the credential, so probing must learn nothing.
 */
async function loadPublicApp(req, res) {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) { res.status(404).json({ error: 'Not found' }); return null; }

    const page = await studioAppStore.getPublicPage(token);
    if (!page) { res.status(404).json({ error: 'Not found' }); return null; }

    const app = await studioAppStore.getStudioApp(page.appId);
    if (!app) { res.status(404).json({ error: 'Not found' }); return null; }

    // Anonymous visitors only ever see the frozen published copy — the bytes
    // that passed publish-time validation. No draft escape hatch exists here.
    const definition = app.isPublished ? app.publishedDefinition : null;
    if (!definition) { res.status(404).json({ error: 'Not found' }); return null; }

    const surface = publicAccess.resolvePublicSurface(definition);
    if (!surface.ok) { res.status(404).json({ error: 'Not found' }); return null; }

    return { token, page, app, definition, surface };
}

/**
 * The visitor bearer → { viewerId }. Every endpoint except GET /:token needs
 * one: it is the identity RLS scopes rows by, so a call without it has no
 * business writing or reading anything.
 */
function requireVisitor(req, res, next) {
    const auth = req.headers['authorization'];
    const m = (typeof auth === 'string' ? auth : '').match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing visitor token' });
    const claims = verifyVisitorToken(m[1].trim(), String(req.params.token || ''));
    if (!claims) return res.status(401).json({ error: 'Your session expired — reload the page to continue.' });
    req.visitor = claims;
    next();
}

/**
 * The full anonymous data context: the same shape resolveDataContext builds on
 * the authenticated route, with the role fixed to `publicAccess.roleKey` and
 * the viewer id fixed to the token's anonymous id.
 */
async function publicDataContext(found, req, res, { tableId } = {}) {
    const { app, surface } = found;
    // The visitor token names an app; a token minted for a different app must
    // not resolve here even if both pages were somehow confused.
    if (req.visitor.appId !== app.id) { res.status(401).json({ error: 'Invalid visitor token' }); return null; }

    const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
    const model = (meta && meta.model && typeof meta.model === 'object') ? meta.model : null;
    if (!model || !Array.isArray(model.tables)) { res.status(404).json({ error: 'App has no data model' }); return null; }

    const role = surface.roleKey;
    // organizationId is null ON PURPOSE: an anonymous visitor is in no
    // organisation, and a row filter comparing viewer.organizationId must not
    // accidentally match the owner's org rows.
    const viewer = { id: req.visitor.viewerId, role, organizationId: null };

    const ctx = { app, ownerScope: app.userId, viewerId: req.visitor.viewerId, model, role, viewer };
    if (tableId) {
        const table = model.tables.find((t) => t && (t.id === tableId || t.key === tableId));
        if (!table) { res.status(404).json({ error: 'Table not found' }); return null; }
        ctx.table = table;
    }
    return ctx;
}

/** Same error contract as studioAppData.js — safe messages only, generic 500s. */
function handleErr(res, err, where) {
    const status = err && typeof err.status === 'number' ? err.status : null;
    // dataReadRunner marks its own refusals `safe` — the same 'Table not found'
    // / 'Forbidden' text these handlers used to return inline.
    if (err && err.safe === true && status) {
        return res.status(status).json({ error: err.message });
    }
    if (status === 409) {
        return res.status(409).json({ error: err.message, code: err.code || 'quota_exceeded', limit: err.limit, used: err.used });
    }
    if (status === 422 || status === 400 || status === 403) {
        return res.status(status).json({ error: err.message });
    }
    log.error(`[StudioAppPublic/${where}] ${err && err.message}`);
    return res.status(500).json({ error: 'Request failed' });
}

// ═══════════════════════════════════════════════════════════════════
// GET /:token — what to render, and who the visitor is
// ═══════════════════════════════════════════════════════════════════

router.get('/:token', ipLimiter, tokenLimiter, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadPublicApp(req, res);
        if (!found) return undefined;

        // A fresh identity per page load. The browser persists it for the
        // duration of the visit (sessionStorage) so a reload mid-form keeps the
        // rows the visitor already wrote visible to them.
        const viewerId = publicAccess.ANON_VIEWER_PREFIX + crypto.randomBytes(12).toString('hex');
        const visitorToken = issueVisitorToken({ pageToken: found.token, appId: found.app.id, viewerId });

        studioAppStore.touchPublicPage(found.token);

        return res.json({
            app: {
                id: found.app.id,
                name: found.surface.title || found.app.name || 'Formulier',
                icon: found.app.icon || null,
            },
            definition: publicAccess.buildPublicDefinition(found.definition, found.surface),
            entryScreenId: found.surface.entryScreenId,
            visitorToken,
        });
    } catch (err) {
        log.error(`[StudioAppPublic/load] ${err.message}`);
        return res.status(500).json({ error: 'Could not load this page' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// POST /:token/actions/:actionId/step — one server step
// ═══════════════════════════════════════════════════════════════════
//
// The anonymous twin of studioAppsRun.js's /step. Same discipline: the step is
// resolved FROM THE DEFINITION by its pre-order index (never trusted from the
// body), must be a data-mutating kind, and executes acts-as-owner. The extra
// gate is reachability — the action must be wired to a component on a PUBLIC
// screen, so posting a back-office action id resolves to nothing.

router.post('/:token/actions/:actionId/step', ipLimiter, tokenLimiter, jsonBody, bodySizeGuard, requireVisitor, validate({ body: R.StepBody }), async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadPublicApp(req, res);
        if (!found) return undefined;

        const actionId = req.params.actionId;
        if (!found.surface.actionIds.has(actionId)) {
            // Not reachable from a public screen — indistinguishable from an
            // action that does not exist.
            return res.status(404).json({ error: 'Action not found' });
        }
        const actions = found.definition.actions;
        const action = (actions && typeof actions === 'object' && Object.hasOwn(actions, actionId)) ? actions[actionId] : null;
        if (!action) return res.status(404).json({ error: 'Action not found' });

        const rawIndex = req.body?.stepIndex;
        const stepIndex = Number.isInteger(rawIndex) ? rawIndex : parseInt(rawIndex, 10);
        const steps = flattenSteps(normalizeSequence(action));
        const step = (Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex < steps.length) ? steps[stepIndex] : null;
        if (!step || typeof step.kind !== 'string') return res.status(404).json({ error: 'Step not found' });
        if (!DATA_MUTATING_STEP_KINDS.includes(step.kind)) {
            return res.status(400).json({ error: 'This step does not run on the server' });
        }

        // Budget by kind, before any work. A model call gets its own bucket —
        // an action legitimately repeats one per uploaded photo.
        let allowed = false;
        if (AI_STEP_KINDS.includes(step.kind)) {
            aiStepLimiter(req, res, () => { allowed = true; });
        } else if (HEAVY_STEP_KINDS.includes(step.kind)) {
            stepLimiter(req, res, () => { allowed = true; });
        } else {
            stepLimiter(req, res, () => { allowed = true; });
        }
        if (!allowed) return undefined;

        const ctx = await publicDataContext(found, req, res);
        if (!ctx) return undefined;

        const t0 = Date.now();
        const result = await actionExecutor.executeDataStep(found.app, ctx.model, step, {
            viewerId: ctx.viewerId,
            // Audit stamp for steps that create durable records (request_approval).
            actionId,
            // No name, no email: there is no person behind this id, and a
            // `currentUser.name` formula must render empty rather than invent one.
            viewerName: null,
            viewerEmail: null,
            role: ctx.role,
            orgId: found.app.organizationId || null,
            formValues: sanitizeBag(req.body?.formValues),
            vars: sanitizeBag(req.body?.vars),
            variables: Array.isArray(found.definition.variables) ? found.definition.variables : null,
            item: req.body?.item,
            index: Number.isInteger(Number(req.body?.index)) && Number(req.body?.index) >= 0 ? Number(req.body.index) : undefined,
            value: req.body?.value,
            viewer: ctx.viewer,
        });

        // The work happened under the OWNER — attribute it to them, as /step does.
        usageStore.logUsage({
            user_id: found.app.userId,
            organization_id: found.app.organizationId || null,
            agent_id: found.app.id,
            agent_name: `App: ${found.app.name || 'Untitled app'}`,
            agent_type: 'studio_app',
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            duration_ms: Date.now() - t0,
            source: 'studio_app_public',
            conversation_id: found.app.id,
        }).catch(() => {});

        if (result && result.ok) return res.json({ ok: true, result: result.result ?? null });
        return res.json({
            ok: false,
            error: (result && result.error) || 'Step failed',
            ...(result?.code ? { code: result.code, limit: result.limit, used: result.used } : {}),
            result: result?.result ?? null,
        });
    } catch (err) {
        log.error(`[StudioAppPublic/step] ${err.message}`);
        return res.status(500).json({ error: 'Step failed to run' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// Reads — RLS-scoped to this visitor
// ═══════════════════════════════════════════════════════════════════

router.get('/:token/data/tables/:tableId/records', ipLimiter, tokenLimiter, requireVisitor, validate({ query: R.RecordsQuery }), async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadPublicApp(req, res);
        if (!found) return undefined;
        const ctx = await publicDataContext(found, req, res, { tableId: req.params.tableId });
        if (!ctx) return undefined;
        if (!rlsGateway.canRead(ctx.table, ctx.role)) return res.status(403).json({ error: 'Forbidden' });

        let filters;
        let sort;
        if (typeof req.query.filter === 'string' && req.query.filter) { try { filters = JSON.parse(req.query.filter); } catch { /* compiler validates */ } }
        if (typeof req.query.sort === 'string' && req.query.sort) { try { sort = JSON.parse(req.query.sort); } catch { /* compiler validates */ } }
        if (filters !== undefined && !Array.isArray(filters)) filters = [filters];

        const out = await dataReadRunner.runRecordList(ctx, ctx.table, {
            filters, sort, cursor: req.query.cursor, limit: req.query.limit,
        });
        return res.json(out);
    } catch (err) { return handleErr(res, err, 'records.list'); }
});

router.post('/:token/data/query', ipLimiter, tokenLimiter, jsonBody, bodySizeGuard, requireVisitor, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadPublicApp(req, res);
        if (!found) return undefined;
        const ctx = await publicDataContext(found, req, res);
        if (!ctx) return undefined;

        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        // sys_org_members is the ORGANISATION's member directory. There is no
        // conceivable reason an anonymous visitor needs it, so it is refused
        // here rather than gated.
        if (body.datasetId === 'sys_org_members') return res.status(403).json({ error: 'Forbidden' });

        if (typeof body.datasetId === 'string' && body.datasetId) {
            const out = await dataReadRunner.runSavedDataset(ctx, body.datasetId, { refresh: false });
            return res.json({ ...out, result: out.rows });
        }

        const descriptor = (body.aggregate && typeof body.aggregate === 'object') ? body.aggregate : body;
        const table = dataReadRunner.requireReadableTable(ctx, body.tableId);
        return res.json(await dataReadRunner.runInlineAggregate(ctx, table, descriptor));
    } catch (err) { return handleErr(res, err, 'query'); }
});

// ═══════════════════════════════════════════════════════════════════
// POST /:token/data/batch — many reads, one request
// ═══════════════════════════════════════════════════════════════════
//
// The authenticated twin of this route (studioAppData.js) is where the
// reasoning lives. This one exists so the public surface is not the surface
// that gets left behind: the runtime's transport rewrites every call to
// /api/public-app and FAILS CLOSED on any suffix it does not recognise, so a
// batch endpoint that only existed on the authenticated router would answer
// 404 here — and a client that mistook that 404 for "no rows" would render
// every public page blank. The client is written not to make that mistake
// (a batch-level failure downgrades to individual requests, never to data),
// but the honest fix is for the route to be here, so it is.
//
// Same three guarantees as the authenticated route: always 200 with
// `{ results }` once the page resolves, per-descriptor statuses, and no
// access control of its own — dataReadRunner is the single implementation,
// and `ctx` here is the anonymous one publicDataContext builds.
//
// sys_org_members is refused for the same reason it is on /data/query: the
// organisation's member directory is not this visitor's business. It is
// caught before the runner sees it, because the runner would look it up as an
// ordinary dataset and answer a truthful 404 that reads as "try again".
router.post('/:token/data/batch', ipLimiter, tokenLimiter, jsonBody, bodySizeGuard, requireVisitor, validate({ body: BatchBody }), readDescriptorLimiter, async (req, res) => {
    try {
        privateHeaders(res);
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const reads = Array.isArray(body.reads) ? body.reads : null;
        if (!reads) return res.status(400).json({ error: '`reads` must be an array' });
        if (reads.length > MAX_BATCH_READS) {
            return res.status(400).json({ error: `At most ${MAX_BATCH_READS} reads per batch` });
        }
        if (reads.some((r) => r && r.datasetId === 'sys_org_members')) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (reads.length === 0) return res.json({ results: [] });

        const found = await loadPublicApp(req, res);
        if (!found) return undefined;
        const ctx = await publicDataContext(found, req, res);
        if (!ctx) return undefined;

        return res.json({ results: await dataReadRunner.runBatch(ctx, reads) });
    } catch (err) { return handleErr(res, err, 'batch'); }
});

// ═══════════════════════════════════════════════════════════════════
// Attachments
// ═══════════════════════════════════════════════════════════════════

function attachmentKey(ownerId, appId, sha256) {
    return storageStore.buildStudioAppAttachmentKey(ownerId, appId, sha256);
}

/** Uploading is a WRITE into the OWNER's storage envelope: the public role has
 *  to be able to create or update SOMEWHERE, or a form that cannot write can't
 *  fill the owner's quota either. Mirrors viewerMayUpload in studioAppFiles. */
function roleMayUpload(model, role) {
    return model.tables.some((t) => rlsGateway.resolveScope(t, role, 'create') === true
        || rlsGateway.resolveScope(t, role, 'update') !== 'none');
}

router.post('/:token/data/attachments', ipLimiter, uploadLimiter, guard, requireVisitor, validate({ body: UploadFields }), async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadPublicApp(req, res);
        if (!found) return undefined;
        const ctx = await publicDataContext(found, req, res);
        if (!ctx) return undefined;
        if (!roleMayUpload(ctx.model, ctx.role)) return res.status(403).json({ error: 'Forbidden' });

        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });
        if (!storageStore.isAvailable()) return res.status(503).json({ error: 'File storage is not available' });

        try {
            await studioAppQuota.assertAttachmentQuota(found.app, file.size);
            await assertAttachmentTotalBytes(found.app, file.size);
        } catch (err) {
            if (err && err.status === 409) {
                return res.status(409).json({ error: err.message, code: err.code, limit: err.limit, used: err.used });
            }
            throw err;
        }

        const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const key = attachmentKey(found.app.userId, found.app.id, sha);

        // Put the blob, THEN scan — the ledger row is written only on a clean
        // verdict, so unscanned bytes are never linked to a record.
        await storageStore.uploadFile(key, file.buffer, file.mimetype, file.sanitized ? { sanitized: 'true' } : null);
        const scan = await scanBuffer(file.buffer);
        if (!scan.clean) {
            try { await storageStore.deleteFile(key); } catch (_) { /* best-effort */ }
            return res.status(422).json({ error: 'File failed a malware scan', signature: scan.signature || null });
        }

        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const attachment = await studioAppDataStore.addAttachment(found.app.id, found.app.userId, {
            recordId: null, // the record does not exist yet — the form is still open
            fieldKey: typeof body.fieldKey === 'string' && body.fieldKey ? body.fieldKey.slice(0, 100) : null,
            mimeType: file.mimetype,
            sha256: sha,
            size: file.size,
        });
        await studioAppDataStore.setAttachmentScan(attachment.id, found.app.id, found.app.userId, { scanned: true, quarantined: false })
            .catch(() => { /* advisory */ });

        return res.json({
            success: true,
            attachment: {
                id: attachment.id,
                recordId: null,
                fieldKey: attachment.fieldKey,
                mime: attachment.mimeType,
                size: attachment.size,
                sha: attachment.sha256,
                scanned: true,
            },
        });
    } catch (err) {
        log.error(`[StudioAppPublic/upload] ${err.message}`);
        return res.status(500).json({ error: 'Upload failed' });
    }
});

router.get('/:token/data/attachments/:fileId', ipLimiter, tokenLimiter, requireVisitor, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadPublicApp(req, res);
        if (!found) return undefined;
        const ctx = await publicDataContext(found, req, res);
        if (!ctx) return undefined;

        const attachment = await studioAppDataStore.getAttachment(req.params.fileId, found.app.id, found.app.userId);
        if (!attachment || attachment.quarantined) return res.status(404).json({ error: 'Attachment not found' });

        // The SAME record-shaped rule the signed-in download uses: readable
        // exactly when a record it hangs off is readable under this role. An
        // upload that is not yet on a record is therefore not yet readable —
        // which is correct, and is why the uploader is never handed a
        // capability by virtue of having uploaded.
        const allowed = await attachmentAccess.viewerMayReadAttachment(found.app, attachment, {
            id: ctx.viewerId, role: ctx.role, model: ctx.model, organizationId: null,
        });
        if (!allowed) return res.status(404).json({ error: 'Attachment not found' });

        const key = attachmentKey(found.app.userId, found.app.id, attachment.sha256);
        let obj;
        try {
            obj = await storageStore.streamFile(key);
        } catch (err) {
            if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
                return res.status(404).json({ error: 'Attachment not found' });
            }
            throw err;
        }

        const mime = attachment.mimeType || obj.contentType || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const inline = /^image\//.test(mime) || mime === 'application/pdf';
        res.setHeader('Content-Disposition', inline ? 'inline' : 'attachment');
        if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);
        obj.stream.on('error', (e) => {
            log.error(`[StudioAppPublic/stream] ${e.message}`);
            if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
            else res.destroy();
        });
        return obj.stream.pipe(res);
    } catch (err) {
        log.error(`[StudioAppPublic/get] ${err.message}`);
        if (!res.headersSent) return res.status(500).json({ error: 'Failed to load attachment' });
        return undefined;
    }
});

// Re-picking a file three times must not leave three dead blobs charging
// against the owner's quota. Refuses anything already linked to a record, so
// this can only ever discard an upload that never landed anywhere.
router.delete('/:token/data/attachments/:fileId', ipLimiter, uploadLimiter, requireVisitor, async (req, res) => {
    try {
        privateHeaders(res);
        const found = await loadPublicApp(req, res);
        if (!found) return undefined;
        const ctx = await publicDataContext(found, req, res);
        if (!ctx) return undefined;
        if (!roleMayUpload(ctx.model, ctx.role)) return res.status(403).json({ error: 'Forbidden' });

        const attachment = await studioAppDataStore.getAttachment(req.params.fileId, found.app.id, found.app.userId);
        if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
        if (attachment.recordId) {
            return res.status(409).json({ error: 'This file is attached to a record.', code: 'attachment_linked' });
        }

        await studioAppDataStore.deleteAttachment(attachment.id, found.app.id, found.app.userId);
        const stillUsed = await studioAppDataStore.countAttachmentsBySha(found.app.id, found.app.userId, attachment.sha256);
        if (stillUsed === 0 && attachment.sha256 && storageStore.isAvailable()) {
            try { await storageStore.deleteFile(attachmentKey(found.app.userId, found.app.id, attachment.sha256)); } catch (_) { /* swept later */ }
        }
        return res.json({ success: true });
    } catch (err) {
        log.error(`[StudioAppPublic/delete] ${err.message}`);
        return res.status(500).json({ error: 'Failed to remove the file' });
    }
});

module.exports = router;
