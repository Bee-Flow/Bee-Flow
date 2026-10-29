// @typecheck noImplicitAny
/**
 * CMS page handlers: create / reorder / page settings / homepage / delete,
 * the full PageDoc read and write, page locale overrides, AI translation of a
 * page, and the org-wide page templates.
 *
 * Extracted verbatim from routes/cms.js, which still owns the router and wires
 * these handlers to both /admin/pages/* and /sites/:siteId/pages/*. Each
 * handler reads req.siteId and req.params.{id,locale}.
 */

const cmsStore = require('../stores/cmsStore');
const cmsTranslate = require('../core/cms/cmsTranslate');
const { localeName } = require('./cmsSiteHandlers');
const { HttpError, notFound } = require('../shared/httpErrors');
const { clientRev } = require('../stores/cms/revision');
const { mediaWarningFor } = require('../stores/cms/localeMedia');

/**
 * 404 unless `pageId` is in this site's page list. A PageDoc (or locale
 * override) written for an id the site does not list is an orphan: nothing
 * links to it, and an id like `pg_x_locale_nl` would be read back as a locale
 * override of `pg_x` by publishSite and the sitemap.
 * The check runs before the write, not inside its lock: PUT /pages/:id closes the
 * small window with its revision check (a deleted page is refused there), the
 * locale route has none, so a delete landing in between can still leave one
 * override row for the gone page.
 * @param {string} siteId
 * @param {string} pageId
 */
async function requirePageInSite(siteId, pageId) {
    const site = await cmsStore.getProject(siteId, { fresh: true });
    if (!site || !Array.isArray(site.pages) || !site.pages.some((/** @type {{ id: string; }} */ p) => p.id === pageId)) {
        throw notFound('page_not_found', 'Page not found');
    }
}

/**
 * @param {import('express').Request<{ id: string, locale: string }>} req
 * @param {import('express').Response} res
 */
async function postPageAiTranslate(req, res) {
    const locale = String(req.params.locale || '').toLowerCase();
    const defaultLocale = await cmsStore.getDefaultLocale();
    if (!locale) return res.status(400).json({ error: 'locale required' });
    if (locale === defaultLocale) {
        return res.status(400).json({ error: 'Cannot translate the default locale' });
    }
    const pageDoc = await cmsStore.getPage(req.siteId, req.params.id);
    if (!pageDoc) return res.status(404).json({ error: 'Page not found' });

    const existingOverride = await cmsStore.getPageLocaleOverride(req.siteId, req.params.id, locale);
    const result = await cmsTranslate.aiTranslatePage({
        pageDoc,
        existingOverride,
        modelTier: (req.body || {}).modelTier,
        languageName: await localeName(locale),
        locale,
        // EU-mode / org custom tiers resolve against the requesting admin.
        userId: req.session?.user?.id || null,
        userOrgId: req.session?.user?.organizationId || null,
    });
    // Applied under the page lock against a fresh read (the model call took seconds).
    const override = await cmsStore.saveTranslatedPageOverride(req.siteId, req.params.id, locale, result.override, pageDoc);
    res.json({
        success: true,
        override,
        translated: result.translated,
        total: result.total,
        errors: result.errors,
        message: result.errors > 0
            ? `Translated ${result.translated} fields with ${result.errors} batch error(s)`
            : `Translated ${result.translated} fields`,
    });
}
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function postPage(req, res) {
    try {
        const { slug, title, copyFromId, templateId } = req.body || {};
        const result = await cmsStore.createPage(req.siteId, { slug, title, copyFromId, templateId });
        res.json({ success: true, ...result });
    } catch (err) { throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message); }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function putPagesOrder(req, res) {
    try {
        const { orderedIds } = req.body || {};
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array required' });
        await cmsStore.reorderPages(req.siteId, orderedIds);
        res.json({ success: true });
    } catch (err) { throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message); }
}

/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function putPageMeta(req, res) {
    try {
        const updated = await cmsStore.updatePageMeta(req.siteId, req.params.id, req.body || {});
        // A slug/title change is mirrored into the PageDoc and raises its revision;
        // the editor needs the new one for its next save of this page.
        const doc = await cmsStore.getPage(req.siteId, req.params.id, { fresh: true });
        res.json({ success: true, page: updated, pageRev: doc?.rev });
    } catch (err) { throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message); }
}

/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function putPageHomepage(req, res) {
    try {
        await cmsStore.setHomepage(req.siteId, req.params.id);
        res.json({ success: true });
    } catch (err) { throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message); }
}

/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function deletePageHandler(req, res) {
    try {
        // Optional ?redirectTo=/path: the deleted address should lead there (301).
        const redirectTo = typeof req.query?.redirectTo === 'string' ? req.query.redirectTo.trim() : '';
        const site = redirectTo ? await cmsStore.getProject(req.siteId, { fresh: true }) : null;
        const entry = site?.pages.find((/** @type {{ id: string; }} */ p) => p.id === req.params.id);
        const wasHomepage = site?.homepageId === req.params.id;
        const outcome = await cmsStore.removePage(req.siteId, req.params.id);
        if (!outcome) return res.status(404).json({ error: 'Page not found' });
        const redirect = entry && !wasHomepage ? await cmsStore.redirectDeletedPage(req.siteId, entry.slug, redirectTo) : null;
        res.json({ success: true, ...outcome, ...(redirect ? { redirect: redirect.entry || null, redirectError: redirect.error || null } : {}) });
    } catch (err) { throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message); }
}

// ── Page templates (global, org-wide) ────────────────────────────────
// The "apply" path doesn't need its own endpoint — callers pass
// templateId on POST /pages and the store walks the template's blocks
// into the new page with fresh block ids.
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function listTemplates(req, res) {
    const templates = await cmsStore.getTemplates();
    // Strip block payloads from the list response — they can be large
    // and the list view only needs name/description/blockCount/date.
    // The blocks land in the new page via templateId on POST /pages,
    // so the client never needs the blocks array on the list.
    const summary = templates.map(t => ({
        id:          t.id,
        name:        t.name,
        description: t.description || '',
        createdAt:   t.createdAt,
        blockCount:  Array.isArray(t.blocks) ? t.blocks.length : 0,
        // Shipped with the product: listed, applicable, not deletable.
        ...(/** @type {{ builtin?: boolean }} */ (t).builtin ?{ builtin: true } : {}),
    }));
    res.json({ templates: summary });
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function postTemplate(req, res) {
    try {
        const { name, description, blocks } = req.body || {};
        const entry = await cmsStore.saveTemplate({ name, description, blocks });
        res.json({
            success: true,
            template: {
                id:          entry.id,
                name:        entry.name,
                description: entry.description || '',
                createdAt:   entry.createdAt,
                blockCount:  Array.isArray(entry.blocks) ? entry.blocks.length : 0,
            },
        });
    } catch (err) { throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message); }
}

/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function deleteTemplateHandler(req, res) {
    try {
        await cmsStore.deleteTemplate(req.params.id);
        res.json({ success: true });
    } catch (err) { throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message); }
}

/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function getPageById(req, res) {
    // Admin/editor read — bypass the per-replica config cache so it never
    // serves a stale page right after a save (see getAdminPayload).
    const page = await cmsStore.getPage(req.siteId, req.params.id, { fresh: true });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
}

/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function putPage(req, res) {
    try {
        const incoming = req.body?.page;
        if (!incoming) return res.status(400).json({ error: 'page object required' });
        await requirePageInSite(req.siteId, req.params.id);
        // The editor says which revision it based the page on; a save on top of
        // somebody else's newer one is a 409, never a silent overwrite.
        const expectedRev = clientRev(incoming.rev, 'page', { route: 'PUT /pages/:id', siteId: req.siteId });
        // Force the URL id onto the body so callers can't quietly write to a
        // different page than the one they targeted.
        const { page: saved, dropped, localeOverrides } = await cmsStore.setPage(req.siteId, { ...incoming, id: req.params.id }, { expectedRev });
        // `dropped` lets the client warn when unknown-type blocks were stripped
        // on save (otherwise a silent data loss).
        // `localeOverrides`: translations re-aligned to this save's item order (locale -> override).
        res.json({ success: true, page: saved, dropped, localeOverrides });
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message);
    }
}

/**
 * @param {import('express').Request<{ id: string, locale: string }>} req
 * @param {import('express').Response} res
 */
async function putPageLocale(req, res) {
    try {
        const { override } = req.body || {};
        if (!override) return res.status(400).json({ error: 'override object required' });
        const locale = req.params.locale.toLowerCase();
        if (!cmsStore.isValidLocale(locale)) return res.status(400).json({ error: 'Invalid locale' });
        await requirePageInSite(req.siteId, req.params.id);
        const saved = await cmsStore.setPageLocaleOverride(req.siteId, req.params.id, locale, override);
        // The store keeps only legal media addresses; tell the translator when some were dropped.
        res.json({ success: true, mediaWarning: mediaWarningFor(override, saved) });
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'bad_request', /** @type {Error} */ (err).message);
    }
}

/**
 * @param {import('express').Request<{ id: string, locale: string }>} req
 * @param {import('express').Response} res
 */
async function deletePageLocale(req, res) {
    await cmsStore.deletePageLocaleOverride(req.siteId, req.params.id, req.params.locale.toLowerCase());
    res.json({ success: true });
}

module.exports = {
    postPageAiTranslate,
    postPage,
    putPagesOrder,
    putPageMeta,
    putPageHomepage,
    deletePageHandler,
    listTemplates,
    postTemplate,
    deleteTemplateHandler,
    getPageById,
    putPage,
    putPageLocale,
    deletePageLocale,
};
