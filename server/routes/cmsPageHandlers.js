// @typecheck
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
    await cmsStore.setPageLocaleOverride(req.siteId, req.params.id, locale, result.override);
    res.json({
        success: true,
        override: result.override,
        translated: result.translated,
        total: result.total,
        errors: result.errors,
        message: result.errors > 0
            ? `Translated ${result.translated} fields with ${result.errors} batch error(s)`
            : `Translated ${result.translated} fields`,
    });
}
async function postPage(req, res) {
    try {
        const { slug, title, copyFromId, templateId } = req.body || {};
        const result = await cmsStore.createPage(req.siteId, { slug, title, copyFromId, templateId });
        res.json({ success: true, ...result });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPagesOrder(req, res) {
    try {
        const { orderedIds } = req.body || {};
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array required' });
        await cmsStore.reorderPages(req.siteId, orderedIds);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageMeta(req, res) {
    try {
        const updated = await cmsStore.updatePageMeta(req.siteId, req.params.id, req.body || {});
        res.json({ success: true, page: updated });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageHomepage(req, res) {
    try {
        await cmsStore.setHomepage(req.siteId, req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deletePageHandler(req, res) {
    try {
        const outcome = await cmsStore.removePage(req.siteId, req.params.id);
        if (!outcome) return res.status(404).json({ error: 'Page not found' });
        res.json({ success: true, ...outcome });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

// ── Page templates (global, org-wide) ────────────────────────────────
// The "apply" path doesn't need its own endpoint — callers pass
// templateId on POST /pages and the store walks the template's blocks
// into the new page with fresh block ids.
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
    }));
    res.json({ templates: summary });
}

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
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteTemplateHandler(req, res) {
    try {
        await cmsStore.deleteTemplate(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function getPageById(req, res) {
    // Admin/editor read — bypass the per-replica config cache so it never
    // serves a stale page right after a save (see getAdminPayload).
    const page = await cmsStore.getPage(req.siteId, req.params.id, { fresh: true });
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
}

async function putPage(req, res) {
    try {
        const incoming = req.body?.page;
        if (!incoming) return res.status(400).json({ error: 'page object required' });
        // Force the URL id onto the body so callers can't quietly write to a
        // different page than the one they targeted.
        const { page: saved, dropped } = await cmsStore.setPage(req.siteId, { ...incoming, id: req.params.id });
        // `dropped` lets the client warn when unknown-type blocks were stripped
        // on save (otherwise a silent data loss).
        res.json({ success: true, page: saved, dropped });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putPageLocale(req, res) {
    try {
        const { override } = req.body || {};
        if (!override) return res.status(400).json({ error: 'override object required' });
        await cmsStore.setPageLocaleOverride(req.siteId, req.params.id, req.params.locale.toLowerCase(), override);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

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
