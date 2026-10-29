// @typecheck noImplicitAny
/**
 * Publishing and what the public gets to see: the thumbnail and the
 * org/group visibility, with the version that is pinned to it.
 *
 * GET /:id/thumbnail  ·  PATCH /:id/publish
 */

const webpageStore = require('../../stores/webpageStore');
const userStore = require('../../stores/userStore');
const { resolveAudienceContext } = require('../../auth/audience');
const { hasPermission, validateSharedGroupsForOrg } = require('../../auth');
const { requireAuth } = require('../../auth/permissions');
const webpageUsageSync = require('../../core/webpages/webpageUsageSync');
const { liveMatchesPin, pinPublishedVersion } = require('./publishedSnapshot');
const { validate } = require('../../core/http/validate');
const { z, onUnknownKeys, typeError } = require('../../utils/zod');
const { bodyOf, idList, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { sessionUser } = require('../../core/http/sessionUser');

// ── What a publication may carry ────────────────────────────────────
//
// `isPublished` is REQUIRED and a real boolean, and that is the reason this file got
// a schema. The store writes `!!isPublished` — it ALWAYS writes that column — so:
//
//   • `{"isPublished": "false"}` was true. The page was PUBLISHED, a snapshot pinned,
//     and the answer said `isPublished: "false"`. Someone who thought they were taking
//     a page off the organisation had actually put it there.
//   • `{}` or a misspelled key was false. The page was UNPUBLISHED and its pinned pointer
//     cleared, under `{success:true}`.
//
// Neither is a shape that a client should be able to send without noticing, so the
// body now carries exactly four keys.
const PUBLISHED_TEXT = 'Zeg of de pagina gepubliceerd moet zijn: isPublished is true of false.';
const GROUP_TEXT = 'sharedGroups is een lijst met groep-id\'s.';
const PublishBody = bodyOf({
    isPublished: z.boolean({ error: PUBLISHED_TEXT }),
    // Omitted means "leave as is" — that distinction must stay, so
    // `.optional()` and not an empty list as the default.
    sharedGroups: idList(GROUP_TEXT).optional(),
    // The explicit action from the header: freeze what stands NOW. Ticking a group is not that,
    // and must not push the owner's newest unpublished state live.
    republish: z.boolean({ error: typeError({ invalid: 'republish is true of false.' }) }).optional(),
});

// The card asks for `?v=<thumbnailSha>` so a new screenshot gets a new URL
// past the browser cache. The route answers by ETag and never reads it.
const ThumbnailQuery = z.object({
    v: z.string().optional(),
}, { error: onUnknownKeys('Dit accepteert alleen ?v als queryparameter.') }).strict();

/** @type {(router: import('express').Router, deps?: import('./index').WebpageRouteDeps) => void} shared multipart gate is passed by index.js */
function register(router) {
    // ── Thumbnail (rendered preview) ────────────────────────────────────

    router.get('/:id/thumbnail', requireAuth, validate({ query: ThumbnailQuery }), /** @param {import('express').Request<{ id: string }>} req @param {import('express').Response} res */ async (req, res) => {
        const userId = sessionUser(req).id;
        // Same visibility logic as GET /:id — owner OR org/group-published.
        let webpage = await webpageStore.getWebpage(req.params.id, userId);
        if (!webpage) {
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && await webpageStore.canReadWebpageAsync(raw, userId, userGroups, orgIdArr)) {
                webpage = raw;
            }
        }
        if (!webpage) return res.status(404).end();
        if (!webpage.thumbnailSha) return res.status(404).end();
        // The thumbnail is a screenshot of the LIVE page — versions do not
        // snapshot one. So a non-owner may only see it while the live files
        // still ARE the published files; the moment the owner edits on, the
        // image would show unpublished work. Nothing to show beats a picture
        // of something that was never published (404 → the card's own icon).
        if (webpage.userId !== userId) {
            const { versionId } = webpageStore.resolveReadVersion(webpage, userId);
            if (versionId) {
                const meta = await webpageStore.getVersionMeta(versionId);
                if (!liveMatchesPin(webpage, meta)) return res.status(404).end();
            }
        }
        const bytes = await webpageStore.readThumbnail(webpage.userId, webpage.id);
        if (!bytes) return res.status(404).end();
        // We may have written a JPEG (sharp path) or a raw PNG (no-sharp
        // fallback). Sniff the first byte to pick the right Content-Type.
        const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
        res.setHeader('Content-Type', isJpeg ? 'image/jpeg' : 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.setHeader('ETag', `"${webpage.thumbnailSha}"`);
        if (req.headers['if-none-match'] === `"${webpage.thumbnailSha}"`) {
            return res.status(304).end();
        }
        return res.end(bytes);
    });

    // ── Publish (org/group visibility) ──────────────────────────────────

    router.patch('/:id/publish', requireAuth, validate({ body: PublishBody, query: NO_QUERY }), /** @param {import('express').Request<{ id: string }>} req @param {import('express').Response} res */ async (req, res) => {
        const userId = sessionUser(req).id;
        const wp = await webpageStore.getWebpageRaw(req.params.id);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // Non-owners need manage_webpages OR admin role.
        const isAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
        if (wp.userId !== userId && !isAdmin) {
            const ok = await hasPermission(userId, 'manage_webpages', req.session);
            if (!ok) return res.status(403).json({ error: 'Permission denied' });
        }

        const { isPublished, sharedGroups } = req.body;

        // NOTE: React + Material UI pages ARE publishable to an org/group. That
        // audience views the page as authenticated users through the same
        // framework-aware, sandboxed preview the owner uses (WebpagePreview →
        // buildWebpagePreview), which bundles + runs the React app. The JS-
        // stripping that would blank a React page applies ONLY to the anonymous
        // `/share/:token` snapshot (webpageSnapshot.writeSnapshot omits JS by
        // design) — a separate, opt-in external-share flow, not this publish.

        // Stamp organization_id on first publish. When publishing to specific
        // groups, derive the org from THOSE groups — not from the owner's
        // primary org. The owner can be in multiple orgs; the groups define
        // which org's audience the page is visible to. Without this, group
        // members in a non-primary org of the owner silently never see the
        // page because the visibility SQL requires an exact org match.
        let organizationId;
        if (isPublished && !wp.organizationId) {
            const incomingGroups = Array.isArray(sharedGroups) ? sharedGroups.filter(Boolean) : [];

            if (incomingGroups.length > 0) {
                // Specific-groups publish — the groups dictate the org. Validate
                // that every sharedGroup exists and that they all share a single
                // org; otherwise the visibility model breaks (one row = one org).
                const allGroups = await userStore.getAllGroups();
                const byId = new Map(allGroups.map(g => [g.id, g]));
                const orgs = new Set();
                for (const gid of incomingGroups) {
                    const g = byId.get(gid);
                    if (!g) return res.status(400).json({ error: `Unknown group: ${gid}` });
                    if (g.organizationId) orgs.add(g.organizationId);
                }
                if (orgs.size === 0) {
                    return res.status(400).json({ error: 'Cannot publish: shared groups have no organisation' });
                }
                if (orgs.size > 1) {
                    return res.status(400).json({ error: 'Cannot publish to groups across multiple organisations' });
                }
                organizationId = [...orgs][0];
            } else {
                // Entire-org publish (sharedGroups empty / undefined) — fall back
                // to the owner's primary org, then their first group's org if
                // the user record has no direct organizationId set.
                const owner = await userStore.getUser(wp.userId);
                organizationId = owner?.organizationId || null;
                if (!organizationId) {
                    const groups = Array.isArray(owner?.groups) ? owner.groups
                        : (() => { try { return JSON.parse(owner?.groups || '[]'); } catch { return []; } })();
                    if (groups.length > 0) {
                        const allGroups = await userStore.getAllGroups();
                        const g = allGroups.find(x => groups.includes(x.id) && x.organizationId);
                        organizationId = g?.organizationId || null;
                    }
                }
                if (!organizationId) {
                    return res.status(400).json({ error: 'Cannot publish: owner has no organisation' });
                }
            }
        }

        // Validate sharedGroups belong to the webpage's org (existing org
        // sticks; new org applies on first publish). Undefined → leave as-is.
        const effectiveOrg = wp.organizationId || organizationId || null;
        let cleanedGroups;
        cleanedGroups = await validateSharedGroupsForOrg(effectiveOrg, sharedGroups);

        // ── Pin what the audience reads ─────────────────────────────────
        // Publishing FREEZES the current content; changing the audience does
        // not. Both arrive on this one route, so they are told apart here:
        //
        //   isPublished:false          → clear the pointer. A page with no
        //                                audience must not keep one claiming
        //                                otherwise. The version row survives
        //                                (source 'published' is never pruned).
        //   no pointer yet             → pin. A first publish MUST pin, or the
        //                                read path takes its documented
        //                                fall-back to the live row.
        //   `republish: true`          → pin. The header's explicit action.
        //   anything else (a group     → keep the existing pin. Ticking a group
        //   toggle on a live page)       is not a re-publish, and re-pinning on
        //                                every checkbox would both spam history
        //                                and silently push out unpublished work.
        // ORDER IS THE WHOLE POINT HERE, in both directions.
        //
        // PUBLISHING pins BEFORE it flips the flag. The other way round has a
        // window — and a failure mode that outlives it: if the snapshot or the
        // pointer write fails after the flag is up, the page is published with
        // published_version_id NULL, and resolveReadVersion's documented
        // fall-back then serves the audience the LIVE row. That is the exact
        // state this whole lifecycle exists to prevent, reached by a 500. So
        // nothing is made visible until there is something frozen to show.
        //
        // UNPUBLISHING clears the pointer AFTER the flag is down, for the
        // mirror-image reason: a page that is still visible must never be
        // pointer-less, even for one statement.
        //
        // A MANAGED page (a Solution stage) is the exception to all of the
        // above: the deploy commit owns its pointer and always pins the
        // release it deployed. Publishing only flips the audience, never
        // freezes the live row, and unpublishing leaves the pointer alone.
        const managed = await webpageStore.managedInfoOf(wp);
        let publishedVersionId = wp.publishedVersionId || null;
        if (managed && isPublished && !publishedVersionId) {
            return res.status(409).json({
                error: 'This page has not been deployed to this stage yet, so there is nothing to publish.',
                code: 'managed_part_not_deployed',
            });
        }
        if (!managed && isPublished && (!publishedVersionId || req.body.republish === true)) {
            try {
                publishedVersionId = await pinPublishedVersion(req.params.id, wp.userId);
            } catch (e) {
                log.error('[Webpages] Pin published version failed:', e);
                publishedVersionId = null;
            }
            if (!publishedVersionId) {
                // Nothing has been published yet, so this is a clean refusal:
                // the page is exactly as the caller found it.
                throw new HttpError(500, 'snapshot_failed', 'Could not freeze a snapshot — nothing was published');
            }
        }

        const ok = await webpageStore.setWebpagePublished(
            req.params.id, isPublished, wp.userId, cleanedGroups, organizationId
        );
        if (!ok) throw new HttpError(500, 'publish_failed', 'Failed to update published status');

        if (!isPublished && !managed) {
            // Tidy-up, not a gate: the page is already invisible, so a failure
            // here leaves a stale pointer on an unpublished row — harmless, and
            // overwritten by the next publish.
            try {
                await webpageStore.setPublishedVersion(req.params.id, wp.userId, null);
                publishedVersionId = null;
            } catch (e) {
                log.warn('[Webpages] Could not clear published pointer after unpublish:', /** @type {Error} */ (e).message);
            }
        }

        // Publishing writes `organization_id` — the only place where that happens. The index does
        // not read that column (it goes via the OWNER, see the header of core/webpages/webpageUsageSync.js),
        // but this is the moment at which a page that has never been reconciled — a page that after its
        // last save is only published — should for the first time appear in the Used-by list of the
        // tables below. Debounced and detached, like every save.
        webpageUsageSync.reconcileWebpageUsageDetached(req.params.id);

        res.json({ success: true, isPublished, sharedGroups: cleanedGroups, publishedVersionId });
    });
}

module.exports = { register };
