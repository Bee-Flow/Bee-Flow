/**
 * A webpage's draft as one ready-to-run HTML document, for every framework.
 *
 * GET /:id/draft-document
 *
 * The web editor composes its preview in the browser (React is bundled there
 * with esbuild-wasm) and bakes a preview token into it. A client that cannot
 * do that — the phone — asks for the finished document instead, so a page
 * made on the web opens on the phone the same way, React or plain HTML.
 *
 * Same visibility as GET /:id and POST /:id/preview-token: the owner, or a
 * reader the page is published to (canReadWebpageAsync). A reader gets the
 * slots the owner pinned by publishing, never the owner's unpublished work
 * (publishedSnapshot.readSlotsForReader), exactly like GET /:id.
 *
 * The baked token is the one POST /:id/preview-token would issue: scoped to
 * the page OWNER (page database, acts-as-author bridges) with the requester as
 * `viewerUserId` (datatables grade per person). It only ever authorises
 * /api/webpages-preview/<this page>/..., the surface the web preview already
 * hands to a sandboxed page.
 *
 * Answers JSON — { status, html, framework, runtime, updatedAt, buildError,
 * expiresAt } — because the phone reads every response through its API
 * client. `html` is set only when `status` is 'ready'.
 */

const rateLimit = require('express-rate-limit');

const webpageStore = require('../../stores/webpageStore');
const { resolveAudienceContext } = require('../../auth/audience');
const { requireAuth } = require('../../auth/permissions');
const { issuePreviewToken } = require('../../auth/webpagePreviewToken');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { buildDraftDocument } = require('../../services/webpageDraftDocument');
const { buildBridgeHeadScripts } = require('../../services/webpagePreviewBridges');
const { readSlotsForReader } = require('./publishedSnapshot');
const { NO_QUERY } = require('./schemas');

/**
 * Every `status` this route answers (the phone's reader knows exactly these):
 * 'ready' with `html`; 'empty' (a React page with no src/main.jsx yet);
 * 'stranded' (React source in a page set to plain HTML); 'build_error' with
 * `buildError`.
 */
const DRAFT_STATUSES = Object.freeze(['ready', 'empty', 'stranded', 'build_error']);

// A React draft is bundled on the server (cached per draft, but a changed
// draft is a fresh esbuild run), so the route gets a per-person ceiling that
// a person reloading a preview never reaches.
const draftDocumentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `draft-doc:${req.session?.user?.id || 'anon'}`,
    message: { error: 'Too many preview requests, please wait a moment.' },
});

/** The owner's row, or one the requester may read as a published reader. */
async function findReadableWebpage(req, userId) {
    const own = await webpageStore.getWebpage(req.params.id, userId);
    if (own) return own;
    const raw = await webpageStore.getWebpageRaw(req.params.id);
    if (!raw) return null;
    const { orgIds, userGroups } = await resolveAudienceContext(req);
    const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
    return (await webpageStore.canReadWebpageAsync(raw, userId, userGroups, orgIdArr)) ? raw : null;
}

/**
 * The API origin the document's bridges call: the origin this request came in
 * on, which is the address the client itself reaches the server at (behind
 * the ingress, `trust proxy` makes req.protocol the forwarded one).
 */
function requestOrigin(req) {
    return `${req.protocol}://${req.get('host') || ''}`;
}

function register(router) {
    router.get('/:id/draft-document', requireAuth, draftDocumentLimiter, validate({ query: NO_QUERY }), async (req, res) => {
        const userId = req.session.user.id;
        const webpage = await findReadableWebpage(req, userId);
        if (!webpage) throw new HttpError(404, 'not_found', 'Webpage not found');

        const { token, expiresAt } = issuePreviewToken({
            userId: webpage.userId, webpageId: webpage.id, viewerUserId: userId,
        });
        const headScripts = buildBridgeHeadScripts({
            dbToken: token, dbApiBase: requestOrigin(req), dbWebpageId: webpage.id,
        });
        const { files: slots } = await readSlotsForReader(webpage, userId);
        const doc = await buildDraftDocument({ webpage, slots, headScripts });

        const status = DRAFT_STATUSES.includes(doc.status) ? doc.status : 'build_error';
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({
            status,
            html: status === 'ready' ? doc.html : null,
            framework: doc.framework,
            runtime: doc.runtime,
            updatedAt: webpage.updatedAt ?? null,
            buildError: doc.buildError ?? null,
            expiresAt: status === 'ready' ? expiresAt : null,
        });
    });
}

module.exports = { register, DRAFT_STATUSES, _internals: { findReadableWebpage, requestOrigin } };
