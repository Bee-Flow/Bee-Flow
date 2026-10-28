// @typecheck
/**
 * External (public) share links and their snapshots.
 *
 * GET/POST /:id/public-shares  ·  POST /:id/public-shares/:shareId/refresh
 * PATCH/DELETE /:id/public-shares/:shareId
 *
 * `reSnapshotWebpageShares` lives here and not with the save routes that call it:
 * refreshing a published snapshot is a verdict about THESE share links, not about saving.
 */

const webpageStore = require('../../stores/webpageStore');
const publicShareStore = require('../../stores/webpagePublicShareStore');
const publicAddress = require('../../stores/webpage/publicAddress');
const webpageSnapshot = require('../../services/webpageSnapshot');
const { resolveAudienceContext } = require('../../auth/audience');
const { requireAuth } = require('../../auth/permissions');
const shareUrls = require('../webpageShareUrls');
const shareReconciler = require('../../core/webpages/webpageShareReconciler');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded, bodyOf, choice, NOTHING, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { bestEffort } = require('../../utils/bestEffort');
const { sessionUser } = require('../../core/http/sessionUser');

// ── What a share link may carry ────────────────────────────────────
//
// This is the WIDEST audience there is: an address that anyone with the link opens,
// without an account. Two things have therefore changed.
//
// `.strict()`, because `accessMode` stood there with a default value:
// `{accessMode = 'unlisted'} = req.body`. One letter wrong —
// `{"accesMode":"password","password":"…"}` — and the NARROWEST choice on the screen
// became the WIDEST: a link without a password, with a 200 and the URL beneath it to
// copy. Exactly the pattern that the datatable sharing route above has already removed
// from its body.
//
// And `accessMode` is now REQUIRED instead of defaulting to 'unlisted'. A public address
// should not be something you get by staying silent. The screen (ExternalShareSection)
// always sends it along.
const MODE_TEXT = 'Kies hoe de link beschermd is: unlisted, password of email.';
const PASSWORD_TEXT = 'Een wachtwoord is tekst van minstens 6 tekens.';
const EMAIL_TEXT = 'Elk toegelaten adres is tekst.';
const ShareBody = bodyOf({
    accessMode: choice(publicShareStore.ACCESS_MODES, MODE_TEXT),
    // The length is ALSO stored in the store (which is the only one that may hash), but a
    // number got past there unhindered: `(123456).length` is undefined and `undefined < 6`
    // is false. The type is therefore not a formality here.
    password: worded(PASSWORD_TEXT).min(6, PASSWORD_TEXT).optional(),
    // Leeg-na-trimmen viel in de store weg en liet een e-mailpoort met een
    // LEGE lijst achter: een link die niemand meer kan openen, onder een 200
    // met de URL erbij.
    allowedEmails: z.array(worded(EMAIL_TEXT).trim().min(1, EMAIL_TEXT), { error: typeError({ invalid: EMAIL_TEXT }) }).optional(),
    // parseExpiresAt hieronder leest hem: null/'' betekent geen vervaldatum.
    expiresAt: z.union([z.string(), z.number(), z.null()], { error: () => 'expiresAt is een tijdstip of null.' }).optional(),
    title: worded('Een titel is tekst.').max(300, 'Een titel is hoogstens 300 tekens.').optional(),
});

// Only the expiry date. `{"expiresA": …}` was a 200 with the unchanged row next to it —
// a change that the reader took as successful and that never took place.
const ExpiryBody = bodyOf({
    expiresAt: z.union([z.string(), z.number(), z.null()], { error: () => 'expiresAt is een tijdstip of null.' }),
});

// Re-snapshot every active public share for a webpage so published pages
// reflect the latest content. Fire-and-forget — never blocks the response.
// Originally only the primary-slot save (PUT /:id) triggered this, but a
// react-mui app lives ENTIRELY in extra files, so it must also run on
// extra-file edits or react shares would render the version captured at share
// creation forever. `ownerId` is the page owner (all callers here are
// owner-only mutations).
//
// The implementation has since W3 step 4 lived in core/webpages/webpageShareReconciler:
// an owner save is no longer the only trigger. A row that disappears from a bound table
// (retention, DSR, an automation) must also disappear publicly, and that hook hangs on
// datatableStore. One implementation, two triggers — two copies would sooner or later
// come to disagree about withdrawn shares.
/**
 * @param {string} webpageId
 * @param {string} ownerId
 */
function reSnapshotWebpageShares(webpageId, ownerId) {
    shareReconciler.reSnapshotWebpageSharesDetached(webpageId, ownerId);
}

// ── External (public) shares ────────────────────────────────────────
//
// Owner-managed share links that publish a sanitized snapshot of the page to
// anonymous viewers. Strictly opt-in per share: every link is a separate row
// with its own access mode, expiry, and audit trail. Recipients are NOT Bee
// Flow users; the public viewer route at /share/:token handles them.

const PUBLIC_SHARE_BASE_URL = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_APP_URL || '';
/**
 * @param {import('express').Request} req
 * @param {string} rawToken
 */
function buildShareUrl(req, rawToken) {
    // Prefer an explicit env override (e.g. https://beeflow.nl) so that
    // links emailed from server-side environments don't end up pointing at
    // localhost. Fall back to the request's own origin so dev works.
    const base = PUBLIC_SHARE_BASE_URL
        || `${req.protocol}://${req.get('host') || ''}`;
    return `${base.replace(/\/+$/, '')}/share/${rawToken}`;
}

/** @param {string | number | Date | null | undefined} input */
function parseExpiresAt(input) {
    if (input === null || input === '' || input === undefined) return null;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid expires_at');
    if (d.getTime() < Date.now() + 60_000) throw new Error('expires_at must be in the future');
    return d;
}

/** @type {(router: import('express').Router, deps?: import('./index').WebpageRouteDeps) => void} shared multipart gate is passed by index.js */
function register(router) {
    // List external shares for a webpage. The owner sees their own shares in full;
    // a non-owner who can READ the page (org/group-published) sees that the page has
    // links and their status, but not the owner's chosen recipient emails.
    // Creating/refreshing/revoking links stays owner-only (handlers below).
    router.get('/:id/public-shares', requireAuth, validate({ query: NO_QUERY }), /** @param {import('express').Request<{ id: string }>} req @param {import('express').Response} res */ async (req, res) => {
        const userId = sessionUser(req).id;
        // Owner-scoped first (preserves owner-only semantics); fall back to the
        // same read-visibility check used by GET /:id for published pages.
        let wp = await webpageStore.getWebpage(req.params.id, userId);
        let isOwner = !!wp;
        if (!wp) {
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && await webpageStore.canReadWebpageAsync(raw, userId, userGroups, orgIdArr)) wp = raw;
        }
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        // The exposure rules live in ./webpageShareUrls so they can be tested
        // without loading this router. Non-owners list EVERY share
        // on the page — scoping to the caller is what made a colleague's link
        // invisible — but never see the owner's recipient allow-list.
        const shares = await publicShareStore.listSharesForWebpage(
            req.params.id, shareUrls.listingCreatorScope(isOwner, userId));
        const safeShares = shareUrls.stripOwnerOnlyFields(shares, isOwner);
        // Attach the share URL where the raw token is recoverable (encrypted
        // at rest, BFSF-188). Legacy/revoked/expired shares get url: null —
        // findByToken independently rejects dead tokens at view time anyway.
        const tokens = await publicShareStore.getRetrievableTokens(req.params.id);
        const withUrls = shareUrls.attachShareUrls(
            safeShares, tokens, (rawToken) => buildShareUrl(req, rawToken));
        res.json({ shares: withUrls });
    });

    // Create a new external share. Body: { accessMode, password?, allowedEmails?, expiresAt?, title? }
    // Returns the raw URL exactly once — the client must show it to the user;
    // the server only stores its sha256.
    router.post('/:id/public-shares', requireAuth, validate({ body: ShareBody, query: NO_QUERY }), /** @param {import('express').Request<{ id: string }>} req @param {import('express').Response} res */ async (req, res) => {
        try {
            const userId = sessionUser(req).id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });

            const { accessMode, password, allowedEmails, expiresAt, title } = req.body;
            let expiry;
            try { expiry = parseExpiresAt(expiresAt); }
            catch (e) { throw new HttpError(400, 'bad_request', e.message); }

            const { share, rawToken } = await publicShareStore.createShare({
                webpageId: wp.id,
                createdBy: userId,
                organizationId: wp.organizationId || null,
                accessMode,
                password,
                allowedEmails,
                expiresAt: expiry,
                title: title || wp.name || '',
            });

            // Capture the sanitized snapshot synchronously so the link works the
            // moment the publisher copies it. Owner of the bytes is wp.userId
            // (the webpage owner), which equals userId here — non-owner publishes
            // are blocked by the getWebpage owner-scoped lookup above.
            try {
                await webpageSnapshot.writeSnapshot({
                    shareId: share.id,
                    webpageId: wp.id,
                    ownerId: wp.userId,
                });
            } catch (snapErr) {
                // Roll back the share row so we don't leave a token pointing at
                // a missing snapshot.
                await publicShareStore.deleteShare(share.id, userId).catch((e) => bestEffort('routes/webpages/publicShares:register', e));
                throw snapErr;
            }

            res.json({
                success: true,
                share,
                url: buildShareUrl(req, rawToken),
                // The raw token is shown to the user once for copy-to-clipboard.
                // Subsequent GETs return only the share metadata, never this.
                rawToken,
            });
        } catch (err) {
            log.error('[Webpages] Create public share failed:', err);
            res.status(400).json({ error: err.message || 'Failed to create public share' });
        }
    });

    // Re-snapshot an existing share so it reflects the current webpage. Keeps
    // the same token (recipients' links stay valid) but refreshes the bytes.
    router.post('/:id/public-shares/:shareId/refresh', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), /** @param {import('express').Request<{ id: string, shareId: string }>} req @param {import('express').Response} res */ async (req, res) => {
        const userId = sessionUser(req).id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const share = await publicShareStore.getShareById(req.params.shareId);
        if (!share || share.webpageId !== wp.id || share.createdBy !== userId) {
            return res.status(404).json({ error: 'Share not found' });
        }
        if (share.revokedAt) return res.status(400).json({ error: 'Cannot refresh a revoked share' });
        await webpageSnapshot.writeSnapshot({
            shareId: share.id,
            webpageId: wp.id,
            ownerId: wp.userId,
        });
        res.json({ success: true });
    });

    // Update expiry. PATCH body: { expiresAt: ISO|null }
    router.patch('/:id/public-shares/:shareId', requireAuth, validate({ body: ExpiryBody, query: NO_QUERY }), /** @param {import('express').Request<{ id: string, shareId: string }>} req @param {import('express').Response} res */ async (req, res) => {
        const userId = sessionUser(req).id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const share = await publicShareStore.getShareById(req.params.shareId);
        if (!share || share.webpageId !== wp.id || share.createdBy !== userId) {
            return res.status(404).json({ error: 'Share not found' });
        }
        let expiry;
        try { expiry = parseExpiresAt(req.body.expiresAt); }
        catch (e) { throw new HttpError(400, 'bad_request', e.message); }
        await publicShareStore.updateExpiry(share.id, userId, expiry);
        const updated = await publicShareStore.getShareById(share.id);
        res.json({ success: true, share: updated });
    });

    // Revoke (soft-delete: marks revoked_at, snapshot is also purged).
    router.delete('/:id/public-shares/:shareId', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), /** @param {import('express').Request<{ id: string, shareId: string }>} req @param {import('express').Response} res */ async (req, res) => {
        const userId = sessionUser(req).id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const share = await publicShareStore.getShareById(req.params.shareId);
        if (!share || share.webpageId !== wp.id || share.createdBy !== userId) {
            return res.status(404).json({ error: 'Share not found' });
        }
        // Always revoke the row first so the token stops working immediately,
        // even if the snapshot purge takes time / fails.
        await publicShareStore.revokeShare(share.id, userId);
        // Was this THE canonical share, then /w/<slug> is now an address with no page. The
        // pointer must go too — otherwise the screen keeps saying "public" about a link that
        // answers 404. On share id, so withdrawing a loose share does not touch the address.
        await publicAddress.clearCanonicalShare(share.id).catch((e) => bestEffort('routes/webpages/publicShares:register#2', e));
        await publicShareStore.deleteShare(share.id, userId).catch((e) => bestEffort('routes/webpages/publicShares:register#3', e));
        res.json({ success: true });
    });
}

module.exports = { register, reSnapshotWebpageShares, buildShareUrl, parseExpiresAt };
