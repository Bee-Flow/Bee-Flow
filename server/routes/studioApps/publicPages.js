// @typecheck strict
/**
 * Public pages: anonymous entry points to an app (routes/studioApps/).
 */

const express = require('express');
const studioAppStore = require('../../stores/studioAppStore');
const { requireAuth } = require('../../auth/permissions');
const publicAccess = require('../../appStudio/publicAccess');
// Who can reach an app is an access-control fact, so a change to it is an
// audit event — see appStudio/publicationAudit.js.
const publicationAudit = require('../../appStudio/publicationAudit');
const { publicAppUrlForToken } = require('../../automation/publicUrl');
const { requireManageApps, audienceFor } = require('./access');
const { sessionUser } = require('../../core/http/sessionUser');

const router = express.Router();

// One app, one live public URL by default. Rotating one means revoking the old
// explicitly, so a link already sent to customers never dies by accident.
const MAX_PUBLIC_PAGES_PER_APP = 3;

// ── Public pages (anonymous entry points) ───────────────────────────
//
// A public page is a URL that opens the screens named in the app definition's
// `publicAccess` block to anyone, with no session — see appStudio/
// publicAccess.js and routes/studioAppPublic.js. Owner-only, all three: minting
// one is publishing part of an app to the open internet.
//
//   GET    /:id/public-pages           → { pages: [{ token, url, visits, … }], publicAccess }
//   POST   /:id/public-pages           → mint one
//   DELETE /:id/public-pages/:token    → revoke one

/** @typedef {NonNullable<Awaited<ReturnType<typeof studioAppStore.getStudioApp>>>} StudioApp */
/** @typedef {NonNullable<Awaited<ReturnType<typeof studioAppStore.getPublicPage>>>} PublicPage */

/**
 * Owner-only gate: a readable non-owner gets 403, a stranger the uniform 404.
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function loadOwnedAppForPublic(req, res) {
    const userId = sessionUser(req).id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) { res.status(404).json({ error: 'App not found' }); return null; }
    if (!studioAppStore.canWriteStudioApp(app, userId)) {
        const { orgIdArr, userGroups } = await audienceFor(req);
        if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
            res.status(403).json({ error: 'Only the owner can manage public pages' });
            return null;
        }
        res.status(404).json({ error: 'App not found' });
        return null;
    }
    return app;
}

/**
 * Why a page can be minted but not yet live. Surfaced to the owner as a
 * `blockers` array so the UI can say what to fix — the anonymous route itself
 * answers a uniform 404 and explains nothing, which is right for a visitor and
 * useless for the person who built the app.
 * @param {StudioApp} app
 */
function publicPageBlockers(app) {
    /** @type {{ code: string; message: string; }[]} */
    const blockers = [];
    const draft = app.definition && typeof app.definition === 'object' ? app.definition : null;
    const published = app.publishedDefinition && typeof app.publishedDefinition === 'object' ? app.publishedDefinition : null;

    if (!draft || !draft.publicAccess) {
        blockers.push({ code: 'no_public_access', message: 'The app has no publicAccess block — name the screen an anonymous visitor may open.' });
    }
    if (!app.isPublished || !published) {
        blockers.push({ code: 'not_published', message: 'Publish the app: anonymous visitors are always served the frozen published definition.' });
    } else if (!published.publicAccess) {
        blockers.push({ code: 'not_in_published', message: 'The published copy has no publicAccess block — publish again so the change goes live.' });
    } else if (!publicAccess.resolvePublicSurface(published).ok) {
        blockers.push({ code: 'surface_unresolved', message: 'The published publicAccess block does not resolve to a screen — check entryScreenId.' });
    }
    return blockers;
}

/**
 * @param {PublicPage} page
 * @param {import('express').Request} req
 */
function publicPageView(page, req) {
    return {
        token: page.token,
        url: publicAppUrlForToken(page.token, req),
        createdAt: page.createdAt,
        lastSeenAt: page.lastSeenAt,
        visits: page.visits,
    };
}

router.get('/:id/public-pages', requireAuth, /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    const app = await loadOwnedAppForPublic(req, res);
    if (!app) return undefined;
    const pages = await studioAppStore.listPublicPages(app.id);
    return res.json({
        pages: pages.map((/** @type {PublicPage} */ p) => publicPageView(p, req)),
        publicAccess: (app.definition && app.definition.publicAccess) || null,
        blockers: publicPageBlockers(app),
    });
});

router.post('/:id/public-pages', requireAuth, requireManageApps, /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    const app = await loadOwnedAppForPublic(req, res);
    if (!app) return undefined;
    // One live URL per app is the shape the UI needs; rotating means
    // revoking the old one explicitly, so a link already handed out never
    // dies by accident.
    const existing = await studioAppStore.listPublicPages(app.id);
    if (existing.length >= MAX_PUBLIC_PAGES_PER_APP) {
        return res.status(409).json({ error: `An app can have at most ${MAX_PUBLIC_PAGES_PER_APP} public URLs — revoke one first.` });
    }
    const page = await studioAppStore.createPublicPage(app.id, sessionUser(req).id);
    // The single largest exposure change the studio can make: from here the
    // app answers to anyone on the internet with the link, with no account.
    await publicationAudit.auditPublicPage({
        app, actorId: sessionUser(req).id, token: page?.token, created: true,
    });
    return res.status(201).json({
        page: publicPageView({ ...page, createdAt: new Date().toISOString(), lastSeenAt: null }, req),
        blockers: publicPageBlockers(app),
    });
});

router.delete('/:id/public-pages/:token', requireAuth, requireManageApps, /** @param {import('express').Request<{ id: string, token: string }>} req */ async (req, res) => {
    const app = await loadOwnedAppForPublic(req, res);
    if (!app) return undefined;
    const ok = await studioAppStore.deletePublicPage(req.params.token, app.id);
    if (!ok) return res.status(404).json({ error: 'Public page not found' });
    await publicationAudit.auditPublicPage({
        app, actorId: sessionUser(req).id, token: req.params.token, created: false,
    });
    return res.json({ success: true });
});

module.exports = router;
