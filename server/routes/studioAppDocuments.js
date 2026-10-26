// @typecheck strict
/**
 * App Studio — Studio documents inside an app (document_viewer,
 * input_document, document_compare). Mounted at /api/studio-apps with the
 * other studio routers (module + app_studio capability gate at the mount).
 *
 *   GET  /:id/documents?node=&q=                 the options of an input_document
 *   GET  /:id/documents/:docId?node=&version=    one document, read-only (preview HTML or sheet values)
 *   GET  /:id/documents/:docId/versions?node=    its revisions, for a version compare
 *   POST /:id/documents/compare  { node, left, right }   what changed (appDocuments/reader + core/documents/compare)
 *
 * All take `?draft=1` (the owner testing the draft; anyone else gets the
 * published app). Every request names the component (`node`) that shows the
 * document, and the gates run in this order:
 *
 *   auth → app visible to the viewer (loadVisibleApp, 404 otherwise) →
 *   the viewer's role → the node is a document component the role can see →
 *   the app's document pool for that role (appDocuments/pool.mts) →
 *   the document read AS THE OWNER, the owner's own (or an org team template),
 *   not archived, and in the pool or made by this app (appDocuments/reader.mts).
 *
 * Every refusal of a document is the same 404, so a document id never tells a
 * viewer whether somebody else's document exists. Compare is rate-limited per
 * viewer and app (STUDIO_APP_DOCUMENT_COMPARE_RPM, default 60, 0 = unlimited).
 *
 * A FACTORY (`makeAppDocumentsRouter(deps)`) so the tests run every gate on
 * fakes; the default export is over the real modules.
 */

'use strict';

const express = require('express');
const { validate } = require('../core/http/validate');
const { HttpError } = require('../core/http/errors');
const { z, bodyOf, queryOf, worded, choice } = require('../core/http/schemaParts');
const { sessionUser } = require('../core/http/sessionUser');
const { documentPool, findDocumentNode, pickerScope } = require('../appStudio/appDocuments/pool.mts');
const reader = require('../appStudio/appDocuments/reader.mts');

const ID_TEXT = 'A document id is letters, digits, "-" and "_" (at most 100).';
const NODE_TEXT = 'node is the id of the component that shows the document.';
const id = (/** @type {string} */ text) => worded(text).regex(/^[A-Za-z0-9_-]{1,100}$/, text);
const draft = choice(['1', 'true', '0', 'false'], 'draft is "1" or "true" for the draft, "0" or "false" (or nothing) for the published app.').optional();

const ListQuery = queryOf({ node: id(NODE_TEXT), draft, q: worded('q is the text to search for.').max(100, 'Search for at most 100 characters.').optional() }, 'Listing documents');
const ViewQuery = queryOf({ node: id(NODE_TEXT), draft, version: id('version is the id of one of the document\'s versions.').optional() }, 'Reading a document');
const VersionsQuery = queryOf({ node: id(NODE_TEXT), draft }, 'Listing versions');
const CompareQuery = queryOf({ draft }, 'Comparing documents');
const DocParams = z.object({ id: z.string(), docId: id(ID_TEXT) });
const Side = z.object({
    documentId: id(ID_TEXT),
    versionId: id('versionId is the id of one of the document\'s versions.').nullish(),
}, { error: () => 'Each side is { documentId, versionId? }.' }).strict();
const CompareBody = bodyOf({ node: id(NODE_TEXT), left: Side, right: Side }, 'Comparing documents');

/** Requests per minute per viewer and app; 0 switches the limit off. */
function compareRpm() {
    const n = Number.parseInt(String(process.env.STUDIO_APP_DOCUMENT_COMPARE_RPM ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : 60;
}

/** The reader and the engine refuse with { status, code }; said again as an HttpError so the client gets the code. */
function asHttp(/** @type {unknown} */ e) {
    const err = /** @type {{ status?: unknown, code?: unknown, message?: string } | null} */ (e);
    if (err && !(err instanceof HttpError) && Number(err.status) >= 400 && Number(err.status) < 500 && typeof err.code === 'string') {
        return new HttpError(Number(err.status), err.code, err.message);
    }
    return e;
}

/** A validated query value as a string ('' when absent). */
const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');

/**
 * @typedef {import('express').Request} Req
 * @typedef {import('express').Response} Res
 * @typedef {import('express').NextFunction} Next
 * @typedef {{ screens?: unknown, actions?: unknown }} Definition
 * @typedef {{ id: string, userId: string, organizationId?: string|null, definition?: unknown, publishedDefinition?: unknown }} App
 * @typedef {{ documentId: string, versionId?: string|null }} SideRef
 * @typedef {{
 *   reader?: import('../appStudio/appDocuments/reader.mts').ReaderDeps,
 *   loadVisibleApp?: (req: Req, res: Res) => Promise<App | null>,
 *   resolveRole?: (req: Req, app: App, userId: string) => Promise<string | null>,
 *   documentChecks?: (def: Definition, role: string | null) => import('../appStudio/appDocuments/pool.mts').PoolChecks,
 *   limiter?: { check: (req: Req, res: Res) => Promise<boolean> } | null,
 *   requireAuth?: (req: Req, res: Res, next: Next) => unknown,
 * }} Deps
 */

/** @param {Deps} [deps] */
function makeAppDocumentsRouter(deps = {}) {
    const router = express.Router();
    const gate = () => require('./studioAppRunGate');
    const requireAuth = deps.requireAuth || ((/** @type {Req} */ req, /** @type {Res} */ res, /** @type {Next} */ next) => require('../auth/permissions').requireAuth(req, res, next));
    const d = {
        reader: () => deps.reader || require('../appStudio/appDocuments/deps.mts').realReaderDeps(),
        loadVisibleApp: deps.loadVisibleApp || ((/** @type {Req} */ req, /** @type {Res} */ res) => gate().loadVisibleApp(/** @type {import('express').Request<{ id: string }>} */ (/** @type {unknown} */ (req)), res)),
        resolveRole: deps.resolveRole || (async (/** @type {Req} */ req, /** @type {App} */ app, /** @type {string} */ userId) => {
            const { resolveAudienceContext } = require('../auth/audience');
            const { userGroups } = await resolveAudienceContext(req);
            const meta = await require('../stores/studioAppDataStore').getDataModel(app.id, app.userId);
            return require('../appStudio/rlsGateway').resolveViewerRole(app, userId, meta && meta.model ? meta.model : null, { userGroups });
        }),
        documentChecks: deps.documentChecks || ((/** @type {Definition} */ def, /** @type {string|null} */ role) => gate().documentChecks(def, role)),
    };
    const rpm = compareRpm();
    const limiter = deps.limiter !== undefined ? deps.limiter : (rpm > 0
        ? require('../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: rpm, keyFn: require('./studioAppRateLimits').actionRunKey, name: 'studio-doc-compare' })
        : null);
    let readerDeps = /** @type {import('../appStudio/appDocuments/reader.mts').ReaderDeps | null} */ (null);
    const readerOf = () => (readerDeps ||= d.reader());

    /**
     * The app, the node and the pool for this viewer — or null when loadVisibleApp already answered.
     * @param {Req} req @param {Res} res @param {string} nodeId @param {string} draftFlag
     */
    async function contextFor(req, res, nodeId, draftFlag) {
        const app = await d.loadVisibleApp(req, res);
        if (!app) return null;
        const userId = sessionUser(req).id;
        const isOwner = app.userId === userId;
        const wantDraft = isOwner && (draftFlag === '1' || draftFlag === 'true');
        const raw = wantDraft ? app.definition : app.publishedDefinition;
        if (!raw || typeof raw !== 'object') throw new HttpError(404, 'app_not_published', 'This app has no published version yet.');
        const def = /** @type {Definition} */ (raw);
        const role = isOwner ? 'owner' : await d.resolveRole(req, app, userId);
        const checks = d.documentChecks(def, role);
        const node = findDocumentNode(def, nodeId, checks);
        if (!node) throw new HttpError(404, 'document_component_not_found', 'This app shows no documents here.');
        return { app, node, pool: documentPool(def, checks) };
    }

    /** @param {(req: Req, res: Res) => Promise<unknown>} fn */
    const handle = (fn) => async (/** @type {Req} */ req, /** @type {Res} */ res) => {
        res.set('Cache-Control', 'no-store');
        try { await fn(req, res); } catch (e) { throw asHttp(e); }
    };
    /** @param {SideRef} s */
    const ref = (s) => ({ documentId: s.documentId, versionId: s.versionId || null });

    router.get('/:id/documents', requireAuth, validate({ query: ListQuery }), handle(async (req, res) => {
        const ctx = await contextFor(req, res, str(req.query.node), str(req.query.draft));
        if (!ctx) return;
        if (ctx.node.type !== 'input_document') throw new HttpError(400, 'not_a_document_picker', 'Only a document picker lists documents.');
        const documents = await reader.pickerOptions(readerOf(), ctx.app, pickerScope(ctx.node), str(req.query.q));
        res.json({ documents });
    }));

    router.post('/:id/documents/compare', requireAuth, express.json({ limit: '16kb' }), validate({ query: CompareQuery, body: CompareBody }), handle(async (req, res) => {
        if (limiter && !(await limiter.check(req, res))) return;
        const body = /** @type {{ node: string, left: SideRef, right: SideRef }} */ (req.body);
        const ctx = await contextFor(req, res, body.node, str(req.query.draft));
        if (!ctx) return;
        if (ctx.node.type !== 'document_compare') throw new HttpError(400, 'not_a_document_compare', 'Only a document compare compares documents.');
        const left = await reader.loadForApp(readerOf(), ctx.app, ctx.pool, ref(body.left));
        const right = await reader.loadForApp(readerOf(), ctx.app, ctx.pool, ref(body.right));
        res.json(await reader.compareForApp(readerOf(), ctx.app, left, right));
    }));

    router.get('/:id/documents/:docId', requireAuth, validate({ params: DocParams, query: ViewQuery }), handle(async (req, res) => {
        const ctx = await contextFor(req, res, str(req.query.node), str(req.query.draft));
        if (!ctx) return;
        const doc = await reader.loadForApp(readerOf(), ctx.app, ctx.pool, { documentId: str(req.params.docId), versionId: str(req.query.version) || null });
        res.json(await reader.documentView(readerOf(), ctx.app, doc));
    }));

    router.get('/:id/documents/:docId/versions', requireAuth, validate({ params: DocParams, query: VersionsQuery }), handle(async (req, res) => {
        const ctx = await contextFor(req, res, str(req.query.node), str(req.query.draft));
        if (!ctx) return;
        const doc = await reader.loadForApp(readerOf(), ctx.app, ctx.pool, { documentId: str(req.params.docId), versionId: null });
        res.json(await reader.documentVersions(readerOf(), ctx.app, doc));
    }));

    return router;
}

module.exports = Object.assign(makeAppDocumentsRouter(), { makeAppDocumentsRouter });
