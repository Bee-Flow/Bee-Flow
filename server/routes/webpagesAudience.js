/**
 * "Who sees the page, and the address" — the owner-only REST side of the
 * fourth row (Public) and of the Address card.
 *
 *   GET /:id/audience          the whole model: the internal state, the public
 *                              state, the address, the column gate and the solution
 *   PUT /:id/audience/public   public on/off, with the column choice
 *
 * The three other rows (Personal / Organisation / Groups) do NOT go through
 * here: they stay on `PATCH /:id/publish`, where they already were, including the
 * organisation validation. There is no second path to the same columns.
 *
 * ── OWNER-ONLY, AND THAT IS NOT A FORMALITY ─────────────────────────
 *
 * This screen says which COLUMNS of which table may go outside, and shows the recipient
 * list of an e-mail-gated link. An org reader of the page has no business there — by this
 * route he would learn the column names of someone else's table. Same gate as
 * webpagesGrants: owner-scoped lookup, 404 for the rest, and the code is not read before
 * that gate.
 *
 * ── WHAT "MAKE PUBLIC" PRECISELY DOES ──────────────────────────────
 *
 *   1. the column choice is applied to the bindings — ALWAYS, also with an empty choice,
 *      because a table missing from the answer goes to zero;
 *   2. the page gets an address (`ensureSlug`, idempotent);
 *   3. a canonical share is created, or the existing one stays;
 *   4. the snapshot is written BEFORE the pointer moves;
 *   5. and every OTHER live share of the same page is ALSO re-snapshotted. The column gate
 *      applies to the address AND to every loose /share/<token>: a frozen snapshot that was
 *      written before the narrowing would otherwise keep serving the withdrawn column.
 *
 * Step 4 is the order that matters. If the pointer moved first and the snapshot then failed,
 * /w/<slug> would point to a share without bytes: an address that exists and shows nothing.
 * Now, on a failed snapshot, everything stays as it was and a 500 comes back.
 */

'use strict';

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const webpageStore = require('../stores/webpageStore');
const publicAddress = require('../stores/webpage/publicAddress');
const bridgeGrants = require('../stores/webpage/bridgeGrants');
const publicShareStore = require('../stores/webpagePublicShareStore');
const webpageSnapshot = require('../services/webpageSnapshot');
const projectStore = require('../stores/projectStore');
const datatableAccess = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const audience = require('../core/webpages/webpagePublicAudience');
// This is the only path that rewrites `bridge_grants.tables`, and that list is the
// GATE from which the dependents index takes its `mode` and `columns`. So reconcile here too —
// see core/webpages/webpageUsageSync.js.
const webpageUsageSync = require('../core/webpages/webpageUsageSync');
const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { HttpError } = require('../core/http/errors');
const { z, onUnknownKeys, typeError } = require('../utils/zod');
const { worded, bodyOf, choice } = require('./webpages/schemas');
const { bestEffort } = require('../utils/bestEffort');

// ── What "public" may carry ───────────────────────────────────────
//
// This is the switch between "only within Bee Flow" and "everyone with the address", and the
// body was read with fallbacks that all fell the wrong way:
//
//   - only `on === false` switched OFF. `"false"` (a string), `0` or a forgotten `on`
//     PUBLISHED the page: share created, snapshot written, token returned, under a 200;
//   - a missing `publicColumns` set every bound table to zero columns. Whoever only wanted
//     to change the password thereby wiped the column choice;
//   - an error in `accessMode`, a password that was too short or an expiry date in the past
//     was refused only AFTER step 1. The column choice was then already stored — also a
//     WIDENED one — and the next re-snapshot of a live link (webpageShareReconciler: a save,
//     a row that changes) served the new columns, while the owner had seen a 400.
//
// Now everything that the body can show by itself is measured before step 1. What can only be
// checked against the existing share (a password share without a new password, an inherited
// e-mail mode without a list) remains with createShare, as before.
const ON_TEXT = 'Say whether the page is public: on is true or false.';
const COLUMNS_TEXT = 'publicColumns maps each table to the columns that may be shown publicly, like { "tbl_1": ["name"] }.';
const COLUMNS_NEEDED = 'Say which columns may be shown publicly (publicColumns); send {} for none.';
const MODE_TEXT = 'accessMode is unlisted, password or email.';
const PASSWORD_TEXT = 'A password is text of at least 6 characters.';
const EMAIL_TEXT = 'Every allowed address is text.';
const EMAILS_NEEDED = 'An e-mail gated page needs at least one allowed address (allowedEmails).';
const EXPIRY_TEXT = 'expiresAt is a date, or null for no expiry.';

const NO_QUERY = z.object({}, { error: onUnknownKeys('This takes no query parameters.') }).strict();
const PublicBody = bodyOf({
    on: z.boolean({ error: ON_TEXT }),
    publicColumns: z.record(
        z.string(), z.array(worded(COLUMNS_TEXT), { error: typeError({ invalid: COLUMNS_TEXT }) }),
        { error: typeError({ invalid: COLUMNS_TEXT }) },
    ).optional(),
    accessMode: choice(['unlisted', 'password', 'email'], MODE_TEXT).optional(),
    password: worded(PASSWORD_TEXT).min(6, PASSWORD_TEXT).optional(),
    allowedEmails: z.array(worded(EMAIL_TEXT).trim().min(1, EMAIL_TEXT), { error: typeError({ invalid: EMAIL_TEXT }) }).optional(),
    expiresAt: z.union([z.string(), z.number(), z.null()], { error: () => EXPIRY_TEXT }).optional(),
}).superRefine((b, ctx) => {
    if (!b || b.on !== true) return;
    if (b.publicColumns === undefined) ctx.addIssue({ code: 'custom', path: ['publicColumns'], message: COLUMNS_NEEDED });
    if (b.accessMode === 'email' && !(b.allowedEmails && b.allowedEmails.length)) {
        ctx.addIssue({ code: 'custom', path: ['allowedEmails'], message: EMAILS_NEEDED });
    }
    if (b.expiresAt !== undefined) {
        try { parseExpiry(b.expiresAt, null); }
        catch (e) { ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: /future/.test(e.message) ? 'expiresAt must be in the future.' : EXPIRY_TEXT }); }
    }
});

/**
 * The base on which /w/<slug> is written out. The same preference as the share URL
 * builder: an explicit env wins, otherwise the origin of the request — so that a link from a
 * server environment does not point to localhost.
 */
function publicBaseUrl(req) {
    const configured = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL || '';
    if (configured) return configured.replace(/\/+$/, '');
    return `${req.protocol}://${req.get('host') || ''}`.replace(/\/+$/, '');
}

/** Eigenaar-gescoopte lookup; stuurt zelf de 404 en geeft dan null terug. */
async function ownedWebpage(req, res) {
    const wp = await webpageStore.getWebpage(req.params.id, req.session.user.id);
    if (!wp) {
        res.status(404).json({ error: 'Webpage not found' });
        return null;
    }
    return wp;
}

/**
 * The LIVE canonical share, or null.
 *
 * Goes via `findLiveShareById`, the same gate as /share/<token>: a pointer to a withdrawn or
 * expired share reads here as "not public", exactly as the visitor sees it. The alternative — showing
 * the row with a "withdrawn" flag — would let the screen say that the page is public while the
 * address answers 404.
 */
async function liveCanonicalShare(webpage) {
    if (!webpage?.publicShareId) return { share: null, known: true };
    try {
        return { share: await publicShareStore.findLiveShareById(webpage.publicShareId), known: true };
    } catch (e) {
        // NOT silently to null: "not public" is a statement about exposure, and that must not come
        // from a failed read.
        log.warn('[Webpages/audience] could not read the canonical share:', e.message);
        return { share: null, known: false };
    }
}

/**
 * All LIVE shares of the page — the N-share model remains.
 *
 * Live means here the same as for the visitor (`liveShareOrNull`): neither withdrawn nor
 * expired. An expired link therefore does not count, because the screen uses this number to say
 * what is still open.
 *
 * `null` for an unreadable list, NOT 0. "Nothing else is open" is a statement about exposure,
 * and it must no more come from a failed read than `liveCanonicalShare`'s "not public".
 */
async function countLiveShares(webpageId, ownerId) {
    try {
        const list = await publicShareStore.listSharesForWebpage(webpageId, ownerId);
        const now = Date.now();
        return (list || []).filter(s => !s.revokedAt
            && !(s.expiresAt && new Date(s.expiresAt).getTime() < now)).length;
    } catch (e) {
        log.warn('[Webpages/audience] could not count the live shares:', e.message);
        return null;
    }
}

/**
 * Narrow the OTHER live shares of this page as well.
 *
 * A snapshot is frozen: the rows in it are written server-side from the `publicColumns` of the
 * moment it was made. If after a narrowing we only rewrote the canonical share, every loose
 * /share/<token> of the same page would keep serving the withdrawn column — while this screen
 * says that column is out. The N-share model is not an edge case here: POST /:id/public-shares
 * creates such loose shares, and withdrawing them deliberately does not touch the address.
 *
 * Without a createdBy filter, so ALL shares of the page: every live link carries the same gate,
 * regardless of who created it.
 *
 * Throws as soon as the list is unreadable or one share could not be rewritten. That is deliberately
 * loud: a link would then be open with the old, wider columns, and the answer may not claim a
 * narrower state than what is being served.
 */
async function reSnapshotOtherLiveShares(wp, canonicalShareId) {
    const shares = await publicShareStore.listSharesForWebpage(wp.id, null);
    const failed = [];
    for (const sh of (shares || [])) {
        if (!sh || sh.revokedAt || sh.id === canonicalShareId) continue;
        try {
            await webpageSnapshot.writeSnapshot({ shareId: sh.id, webpageId: wp.id, ownerId: wp.userId });
        } catch (e) {
            log.error(`[Webpages/audience] re-snapshot failed for share ${sh.id}:`, e.message);
            failed.push(sh.id);
        }
    }
    if (failed.length > 0) {
        throw new Error(`${failed.length} other public link(s) still show the previous columns`);
    }
}

/** "Onderdeel van oplossing" — project_id omgekeerd gelezen. */
async function solutionOf(webpage) {
    if (!webpage?.projectId) return null;
    try {
        const p = await projectStore.getProject(webpage.projectId);
        return p ? { id: p.id, name: p.name || '' } : null;
    } catch {
        return null;
    }
}

/**
 * Attach a readable name to every bound table — best-effort.
 *
 * The column-choice screen asks "which columns of THIS table may go outside", and `tbl_9f2a…` is no
 * answer to that. If the lookup fails (the owner may no longer read the table, the table is gone),
 * `label` stays null and the screen shows the id. Never an invented name, and never an error:
 * the gate must remain usable even when a binding is skewed.
 */
async function decorateTableLabels(model, userId) {
    const rows = model?.columnGate?.tables || [];
    if (rows.length === 0) return model;
    let principal = null;
    try { principal = await datatableAccess.resolveDatatablePrincipalForUser(userId); }
    catch { return model; }
    for (const row of rows) {
        try {
            const resolved = await datatableRuntime.resolveForPrincipal(row.datatableId, principal, { needed: 'viewer' });
            row.label = resolved?.table?.name || null;
        } catch {
            row.label = null;
        }
    }
    return model;
}

async function buildModel(req, wp) {
    const grants = await bridgeGrants.getBridgeGrants(wp.id);
    const [canonical, shareCount, solution] = await Promise.all([
        liveCanonicalShare(wp),
        countLiveShares(wp.id, wp.userId),
        solutionOf(wp),
    ]);
    const model = audience.buildAudienceModel({
        webpage: wp,
        canonicalShare: canonical.share,
        canonicalShareKnown: canonical.known,
        shareCount,
        tables: grants.tables,
        // The same reading, another slice: `ai` carries the public AI switch.
        // No extra I/O — `grants` is already above — and without this line the model would fall
        // back to "not read", not to "off".
        ai: grants.ai,
        solution,
        baseUrl: publicBaseUrl(req),
    });
    return decorateTableLabels(model, wp.userId);
}

/**
 * The column choice is already saved when the other live links are rewritten,
 * so a failure there is not a plain "something went wrong": the answer says
 * what did and did not happen. The cause goes to the log, not to the client.
 */
function linksNotNarrowed(e) {
    log.error('[Webpages/audience] not every public link was narrowed:', e);
    throw new HttpError(500, 'links_not_narrowed', 'Column choice saved, but not every public link could be updated');
}

router.get('/:id/audience', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    const wp = await ownedWebpage(req, res);
    if (!wp) return;
    res.json(await buildModel(req, wp));
});

/**
 * Public on or off.
 *
 * Body:
 *   on             true | false
 *   publicColumns  { [datatableId]: string[] } — the gate. If a bound table is missing,
 *                  that one goes to ZERO columns.
 *   accessMode     'unlisted' | 'password' | 'email'
 *   password       only with 'password'
 *   allowedEmails  only with 'email'
 *   expiresAt      ISO string or null
 */
router.put('/:id/audience/public', requireAuth, validate({ body: PublicBody }), async (req, res) => {
    const wp = await ownedWebpage(req, res);
    if (!wp) return;
    const userId = req.session.user.id;
    const body = req.body || {};

    if (body.on === false) {
        const share = wp.publicShareId ? await publicShareStore.getShareById(wp.publicShareId) : null;
        // Pointer away first, then withdraw: if the withdrawal fails, the page is at least
        // no longer "public" according to the address.
        await publicAddress.setCanonicalShare(wp.id, userId, null);
        if (share && share.webpageId === wp.id && !share.revokedAt) {
            await publicShareStore.revokeShare(share.id, share.createdBy);
            await publicShareStore.deleteShare(share.id, share.createdBy).catch((e) => bestEffort('routes/webpagesAudience:anon', e));
        }
        const fresh = await webpageStore.getWebpage(wp.id, userId);
        return res.json(await buildModel(req, fresh || { ...wp, publicShareId: null }));
    }

    // ── public ON ───────────────────────────────────────────────────
    // 1. the gate. Always, and before everything: the snapshot further on renders
    //    bf-table from exactly this list, so this must already be stored before
    //    even one byte goes outside.
    const current = await bridgeGrants.getBridgeGrants(wp.id);
    const narrowed = audience.applyColumnChoice(current.tables, body.publicColumns);
    const saved = await bridgeGrants.updateBridgeGrants(wp.id, userId, { tables: narrowed });
    if (!saved) return res.status(404).json({ error: 'Webpage not found' });
    // `applyColumnChoice` today only narrows `publicColumns` and leaves the rest of the
    // binding as it is, so the index usually does not change because of it. The call is there
    // all the same: the rule is "every path that records the bindings", not "every path that we
    // know today matters".
    webpageUsageSync.reconcileWebpageUsageDetached(wp.id);

    // 2. the address. Idempotent — a page that was public before keeps the same /w/<slug>.
    const slug = await publicAddress.ensureSlug(wp.id, userId, wp.name);
    if (!slug) return res.status(404).json({ error: 'Webpage not found' });

    // 3. the share. If a live canonical one already exists with the same access setting, it stays —
    //    a new token would break every shared link without anyone having asked for it.
    const { share: existing, known: canonicalKnown } = await liveCanonicalShare(wp);
    // UNKNOWN IS NOT HERE "there is none yet". If the current canonical share could not be read,
    // then `existing === null` below reads as "just make one": a SECOND live link is added and the
    // withdrawal of the old one is skipped — so it stays in place with the OLD password or the old
    // recipient list, while the screen promises that links people already have will stop working.
    // Unknown narrows: publish nothing, and say so. The column choice from step 1 is already stored —
    // that direction (narrower) is safe, and the answer claims nothing else.
    if (!canonicalKnown) {
        throw new HttpError(500, 'public_link_unreadable',
            'Could not read the current public link for this page, so nothing was published. The column choice was saved; the existing link is unchanged. Please try again.');
    }
    const accessMode = body.accessMode || (existing ? existing.accessMode : 'unlisted');
    const requested = {
        accessMode,
        // Only a password share has any use for this. `accessOptionsChanged` counts every
        // password sent along as a change, and the panel keeps a previously typed password after the
        // choice has been set back to "unlisted" — so every save afterwards stored a NEW token and
        // broke every link that people already had.
        password: accessMode === 'password' ? body.password : undefined,
        allowedEmails: body.allowedEmails,
    };
    let expiresAt;
    try { expiresAt = parseExpiry(body.expiresAt, existing); }
    catch (e) { throw new HttpError(400, 'bad_request', e.message); }

    if (existing && !audience.accessOptionsChanged(existing, requested)) {
        if (body.expiresAt !== undefined) {
            await publicShareStore.updateExpiry(existing.id, existing.createdBy, expiresAt);
        }
        await webpageSnapshot.writeSnapshot({ shareId: existing.id, webpageId: wp.id, ownerId: wp.userId });
        // The gate applies to EVERY live link of this page, not only to the address — otherwise a loose
        // /share/<token> would keep serving the column that was just unticked.
        await reSnapshotOtherLiveShares(wp, existing.id).catch(linksNotNarrowed);
        const fresh = await webpageStore.getWebpage(wp.id, userId);
        return res.json(await buildModel(req, fresh || wp));
    }

    let created;
    try {
        created = await publicShareStore.createShare({
            webpageId: wp.id,
            createdBy: userId,
            organizationId: wp.organizationId || null,
            accessMode: requested.accessMode,
            password: requested.password,
            allowedEmails: audience.normalizeEmails(requested.allowedEmails),
            expiresAt,
            title: wp.name || '',
        });
    } catch (e) {
        // createShare throws on an invalid mode, a password that is too short, or an empty recipient
        // list — all input errors from this screen, so 400 with its own text.
        return res.status(400).json({ error: e.message || 'Could not create the public link' });
    }

    // 4. bytes vóór wijzer.
    try {
        await webpageSnapshot.writeSnapshot({ shareId: created.share.id, webpageId: wp.id, ownerId: wp.userId });
    } catch (e) {
        await publicShareStore.deleteShare(created.share.id, userId).catch((e) => bestEffort('routes/webpagesAudience:anon#2', e));
        throw e;
    }
    await publicAddress.setCanonicalShare(wp.id, userId, created.share.id);
    // Withdraw the old canonical only after this: up to this point it was the working address,
    // and an error above must not take it along.
    if (existing) {
        await publicShareStore.revokeShare(existing.id, existing.createdBy).catch(() => {});
        await publicShareStore.deleteShare(existing.id, existing.createdBy).catch((e) => bestEffort('routes/webpagesAudience:anon#3', e));
    }
    // Only after this, the other live shares: the just-withdrawn old canonical no longer needs to be
    // rewritten, but the loose shares do.
    await reSnapshotOtherLiveShares(wp, created.share.id).catch(linksNotNarrowed);

    const fresh = await webpageStore.getWebpage(wp.id, userId);
    const model = await buildModel(req, fresh || { ...wp, slug, publicShareId: created.share.id });
    // The raw token goes back once, just as with POST /:id/public-shares: there is a second,
        // token-based address (/share/<token>), and for the owner that is the only chance to see it.
        // The ADDRESS that the screen shows remains /w/<slug>.
    res.json({ ...model, rawToken: created.rawToken });
});

/**
 * `expiresAt` from the body, or that of the existing share if the field is missing.
 * The same rules as routes/webpages.js: empty = no expiry date, and a date in the past
 * is an input error, not a dead link.
 */
function parseExpiry(input, existing) {
    if (input === undefined) return existing?.expiresAt ? new Date(existing.expiresAt) : null;
    if (input === null || input === '') return null;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid expires_at');
    if (d.getTime() < Date.now() + 60_000) throw new Error('expires_at must be in the future');
    return d;
}

module.exports = router;
module.exports.parseExpiry = parseExpiry;
