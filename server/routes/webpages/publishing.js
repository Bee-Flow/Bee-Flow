/**
 * Publiceren en wat het publiek te zien krijgt: de thumbnail en de
 * org/groep-zichtbaarheid met de versie die eraan vastgepind wordt.
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
const { z } = require('zod');
const { bodyOf, idList, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');

// ── Wat een publicatie mag dragen ───────────────────────────────────
//
// `isPublished` is VERPLICHT en een échte boolean, en dat is de reden dat dit
// bestand een schema kreeg. De store schrijft `!!isPublished` — hij schrijft
// die kolom ALTIJD — dus:
//
//   • `{"isPublished": "false"}` was waar. De pagina werd GEPUBLICEERD, een
//     momentopname vastgepind, en het antwoord zei `isPublished: "false"`.
//     Iemand die dacht een pagina van de organisatie af te halen zette hem er
//     juist op.
//   • `{}` of een verkeerd gespelde sleutel was onwaar. De pagina werd
//     DEPUBLICEERD en haar gepinde wijzer gewist, onder `{success:true}`.
//
// Geen van beide is een vorm die een client hoort te kunnen versturen zonder
// het te horen, dus draagt de body nu precies vier sleutels.
const PUBLISHED_TEXT = 'Zeg of de pagina gepubliceerd moet zijn: isPublished is true of false.';
const GROUP_TEXT = 'sharedGroups is een lijst met groep-id\'s.';
const PublishBody = bodyOf({
    isPublished: z.boolean({ required_error: PUBLISHED_TEXT, invalid_type_error: PUBLISHED_TEXT }),
    // Weggelaten betekent "laat staan" — dat onderscheid moet blijven, dus
    // `.optional()` en niet een lege lijst als standaard.
    sharedGroups: idList(GROUP_TEXT).optional(),
    // De expliciete actie uit de kop: bevries wat er NU staat. Een groepje
    // aanvinken is dat niet, en mag de nieuwste onuitgegeven staat van de
    // eigenaar niet live duwen.
    republish: z.boolean({ invalid_type_error: 'republish is true of false.' }).optional(),
});

// The card asks for `?v=<thumbnailSha>` so a new screenshot gets a new URL
// past the browser cache. The route answers by ETag and never reads it.
const ThumbnailQuery = z.object({
    v: z.string().optional(),
}).strict('Dit accepteert alleen ?v als queryparameter.');

function register(router) {
    // ── Thumbnail (rendered preview) ────────────────────────────────────

    router.get('/:id/thumbnail', requireAuth, validate({ query: ThumbnailQuery }), async (req, res) => {
        try {
            const userId = req.session.user.id;
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
        } catch (err) {
            if (err?.status && err.status < 500) throw err;
            log.error('[Webpages] Thumbnail fetch failed:', err);
            return res.status(500).end();
        }
    });

    // ── Publish (org/group visibility) ──────────────────────────────────

    router.patch('/:id/publish', requireAuth, validate({ body: PublishBody, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
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
            try {
                cleanedGroups = await validateSharedGroupsForOrg(effectiveOrg, sharedGroups);
            } catch (e) {
                return res.status(e.status || 500).json({ error: e.message });
            }

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
                    return res.status(500).json({ error: 'Could not freeze a snapshot — nothing was published' });
                }
            }

            const ok = await webpageStore.setWebpagePublished(
                req.params.id, isPublished, wp.userId, cleanedGroups, organizationId
            );
            if (!ok) return res.status(500).json({ error: 'Failed to update published status' });

            if (!isPublished && !managed) {
                // Tidy-up, not a gate: the page is already invisible, so a failure
                // here leaves a stale pointer on an unpublished row — harmless, and
                // overwritten by the next publish.
                try {
                    await webpageStore.setPublishedVersion(req.params.id, wp.userId, null);
                    publishedVersionId = null;
                } catch (e) {
                    log.warn('[Webpages] Could not clear published pointer after unpublish:', e.message);
                }
            }

            // Publiceren schrijft `organization_id` — de enige plek waar dat
            // gebeurt. De index leest die kolom niet (hij gaat langs de EIGENAAR,
            // zie de kop van core/webpages/webpageUsageSync.js), maar dit is wel
            // het moment waarop een pagina die nog nooit is gereconcilieerd — een
            // pagina die na haar laatste save alleen nog gepubliceerd wordt — voor
            // het eerst zichtbaar hoort te zijn in de Wordt-gebruikt-door-lijst van
            // de tabellen eronder. Gedebouncet en detached, net als elke save.
            webpageUsageSync.reconcileWebpageUsageDetached(req.params.id);

            res.json({ success: true, isPublished, sharedGroups: cleanedGroups, publishedVersionId });
        } catch (err) {
            // A refusal the store words for the caller (409 managed_part) goes
            // to the terminal handler, which passes its code through.
            if (err?.status && err.status < 500) throw err;
            log.error('[Webpages] Publish failed:', err);
            res.status(500).json({ error: 'Failed to update publish state' });
        }
    });
}

module.exports = { register };
