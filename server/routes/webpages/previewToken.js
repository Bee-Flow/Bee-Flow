/**
 * Het kortlevende token waarmee de gesandboxte preview-iframe de API bereikt.
 *
 * POST /:id/preview-token
 */

const webpageStore = require('../../stores/webpageStore');
const { resolveAudienceContext } = require('../../auth/audience');
const { requireAuth } = require('../../auth/permissions');
const { issuePreviewToken } = require('../../auth/webpagePreviewToken');
const { validate } = require('../../core/http/validate');
const { NO_QUERY, NOTHING } = require('./schemas');
const log = require('../../telemetry/log');

function register(router) {
    // ── Preview token (for sandboxed iframe → API calls) ────────────────
    //
    // The preview iframe runs with `sandbox="allow-scripts"` (no
    // `allow-same-origin`) so it can't carry the user's session cookie. The
    // editor calls this endpoint over the normal session-authenticated channel,
    // receives a short-lived HMAC token, and bakes it into the iframe document.
    // The iframe then sends `Authorization: Bearer <token>` on cross-origin
    // calls to /api/webpages-preview/...
    // Neemt niets aan dan de pagina in het pad: het token wordt op de EIGENAAR
    // gescoopt en op de kijker, allebei uit de sessie. Een body-sleutel die
    // eruitziet alsof hij dat kan verschuiven (`userId`, `scope`) hoort een 400
    // te krijgen en niet genegeerd te worden.
    router.post('/:id/preview-token', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            // Owner OR org/group-published reader — same visibility as GET /:id, so
            // shared-page viewers get a token and their React preview can call the
            // bridges (without it, dbToken=null and the preview renders blank).
            let wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) {
                const raw = await webpageStore.getWebpageRaw(req.params.id);
                const { orgIds, userGroups } = await resolveAudienceContext(req);
                const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
                if (raw && await webpageStore.canReadWebpageAsync(raw, userId, userGroups, orgIdArr)) {
                    wp = raw;
                }
            }
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            // Scope the token to the page OWNER so all authorized viewers read/write
            // the SAME per-page database (webpageDbStore keys by the token's userId).
            // AI/automations/integrations already act as the author independently.
            // `userId` = de eigenaar (paginadatabase + acts-as-author-bruggen),
            // `viewerUserId` = wie er nu kijkt. De tabelroutes gebruiken alleen de
            // tweede: een datatable heeft graden per persoon, en een gedeelde
            // pagina mag de tabelrechten van de auteur niet uitlenen.
            const { token, expiresAt } = issuePreviewToken({
                userId: wp.userId, webpageId: wp.id, viewerUserId: userId,
            });
            res.json({ token, expiresAt, webpageId: wp.id });
        } catch (err) {
            log.error('[Webpages] Preview token failed:', err);
            res.status(500).json({ error: 'Failed to issue preview token' });
        }
    });
}

module.exports = { register };
