// @typecheck
/**
 * CMS site-level handlers: the SiteDoc itself, its locale overrides, AI
 * translation of the site chrome, publish, the per-site Live toggle and the
 * two org-wide flags (enabled, default locale).
 *
 * Extracted verbatim from routes/cms.js, which still owns the router and wires
 * these handlers to both /admin/* and /sites/:siteId/* (see the route table in
 * its header). Each handler reads req.siteId, set by attachSiteId or
 * attachSiteIdFromParam before it runs.
 */

const cmsStore = require('../stores/cmsStore');
const cmsTranslate = require('../core/cms/cmsTranslate');
const languageStore = require('../stores/languageStore');
const { HttpError } = require('../core/http/errors');
const { getLiveSiteId, setLiveSiteId, ensurePublishedSnapshot } = require('./cmsShared');
const { provisionAnalyticsForSite } = require('./cmsAnalytics');

// ── Shared handler bodies ────────────────────────────────────────
//
// Each handler reads req.siteId (set by attachSiteId or attachSiteIdFromParam)
// and req.params.{id,locale} (where applicable). The same function is wired
// to both /admin/* and /sites/:siteId/* routes in routes/cms.js.

async function getSitePayload(req, res) {
    const [payload, locales, liveSiteId] = await Promise.all([
        cmsStore.getAdminPayload(req.siteId),
        languageStore.getAvailableLocales(),
        getLiveSiteId(),
    ]);
    // `enabled` is derived (true iff some site is live). Kept for any
    // legacy panel code still reading it; new code should branch on
    // liveSiteId === activeSiteId to know if *this* site is live.
    res.json({
        ...payload,
        locales,
        enabled: liveSiteId !== null,
        liveSiteId,
    });
}

async function getGraph(req, res) {
    const graph = await cmsStore.getSiteGraph(req.siteId);
    res.json(graph);
}

async function putSiteDoc(req, res) {
    const { site } = req.body || {};
    if (!site) return res.status(400).json({ error: 'site object required' });
    const chromeProblem = cmsStore.validateSiteChrome(site);
    if (chromeProblem) throw new HttpError(400, 'invalid_site_chrome', chromeProblem);
    try {
        const report = {};
        const saved = await cmsStore.setProject(req.siteId, site, report);
        // `localeOverrides`: header/footer translations re-aligned to this save's item order.
        res.json({ success: true, site: saved, localeOverrides: report.localeOverrides });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function putSiteLocale(req, res) {
    try {
        const { override } = req.body || {};
        if (!override) return res.status(400).json({ error: 'override object required' });
        await cmsStore.setSiteLocaleOverride(req.siteId, req.params.locale.toLowerCase(), override);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

async function deleteSiteLocale(req, res) {
    await cmsStore.deleteSiteLocaleOverride(req.siteId, req.params.locale.toLowerCase());
    res.json({ success: true });
}

// ── AI auto-translate ────────────────────────────────────────────────
// Pre-fills a page/site locale override by translating the default-locale
// text through the LLM. Existing manual translations are preserved. The
// resulting override is persisted and returned so the editor can fold it in.

// Resolve the human-readable language name for a locale code (for the prompt).
async function localeName(locale) {
    try {
        const locales = await languageStore.getAvailableLocales();
        return locales.find(l => l.code === locale)?.name || locale;
    } catch (_) { return locale; }
}

async function postSiteAiTranslate(req, res) {
    const locale = String(req.params.locale || '').toLowerCase();
    const defaultLocale = await cmsStore.getDefaultLocale();
    if (!locale) return res.status(400).json({ error: 'locale required' });
    if (locale === defaultLocale) {
        return res.status(400).json({ error: 'Cannot translate the default locale' });
    }
    const siteDoc = await cmsStore.getProject(req.siteId);
    if (!siteDoc) return res.status(404).json({ error: 'Site not found' });

    const existingOverride = await cmsStore.getSiteLocaleOverride(req.siteId, locale);
    const result = await cmsTranslate.aiTranslateSite({
        siteDoc,
        existingOverride,
        modelTier: (req.body || {}).modelTier,
        languageName: await localeName(locale),
        locale,
        // EU-mode / org custom tiers resolve against the requesting admin.
        userId: req.session?.user?.id || null,
        userOrgId: req.session?.user?.organizationId || null,
    });
    // Applied under the site lock against a fresh read (the model call took seconds).
    const override = await cmsStore.saveTranslatedSiteOverride(req.siteId, locale, result.override, siteDoc);
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
async function postSitePublish(req, res) {
    try {
        const result = await cmsStore.publishSite(req.siteId);
        // Best-effort: ensure this site has a Umami website so its public pages
        // have an id to report against. Fire-and-forget so publish stays fast.
        const project = await cmsStore.getProject(req.siteId).catch(() => null);
        provisionAnalyticsForSite(req.siteId, {
            name: project?.name || 'CMS site',
            domain: req.get('host'),
        }).catch(() => {});
        res.json({ success: true, ...result });
    } catch (err) { res.status(400).json({ error: err.message }); }
}

// ensurePublishedSnapshot lives in ./cmsShared.js (shared with the CMS MCP server).

async function putSiteLive(req, res) {
    try {
        const { live } = req.body || {};
        if (typeof live !== 'boolean') {
            return res.status(400).json({ error: 'live must be a boolean' });
        }
        if (live) {
            // Publish FIRST: a version without a snapshot must never become the
            // live one (it would blank the public site), and it must not leak
            // its draft either. A failed publish throws here and the current
            // live site stays as it is.
            await ensurePublishedSnapshot(req.siteId);
            // Setting this site live implicitly takes any other live site
            // offline — only one project can be live at a time.
            await setLiveSiteId(req.siteId);
            return res.json({ success: true, liveSiteId: req.siteId });
        }
        // Clearing only matters when *this* site is the currently-live
        // one; otherwise toggling it off is a no-op (avoids accidentally
        // dark-ing the public site from an inactive editor tab).
        const current = await getLiveSiteId();
        if (current === req.siteId) {
            await setLiveSiteId(null);
            return res.json({ success: true, liveSiteId: null });
        }
        res.json({ success: true, liveSiteId: current });
    } catch (err) {
        if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
        res.status(400).json({ error: err.message });
    }
}

// Org-wide handlers (only mounted on /admin/*).

async function putEnabled(req, res) {
    const { enabled, siteId } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (!enabled) {
        // Org-wide off: clear the live id so the public site goes dark.
        await setLiveSiteId(null);
        return res.json({ success: true, enabled: false, liveSiteId: null });
    }
    // Org-wide on: callers may name a specific siteId to make live, or
    // omit it to keep the currently-live one (or fall back to the
    // first project if none has ever been live before).
    if (siteId) {
        await ensurePublishedSnapshot(siteId);
        const next = await setLiveSiteId(siteId);
        return res.json({ success: true, enabled: true, liveSiteId: next });
    }
    let next = await getLiveSiteId();
    if (!next) {
        const projects = await cmsStore.listProjects();
        next = projects[0]?.id || null;
    }
    if (next) {
        // Publish before (re)setting the live id, like putSiteLive.
        await ensurePublishedSnapshot(next);
        await setLiveSiteId(next);
    }
    res.json({ success: true, enabled: next !== null, liveSiteId: next });
}

async function putDefaultLocale(req, res) {
    const { locale } = req.body || {};
    if (!locale || typeof locale !== 'string') return res.status(400).json({ error: 'locale required' });
    const code = locale.trim().toLowerCase();
    // A 400 rather than the store's 500: the store validates too (this
    // value ends up in <html lang> on the public site), but a caller that
    // sends nonsense deserves to be told which field is wrong.
    if (!cmsStore.isValidLocale(code)) return res.status(400).json({ error: 'locale must be a language tag such as "en" or "pt-br"' });
    await cmsStore.setDefaultLocale(code);
    res.json({ success: true, defaultLocale: code });
}

module.exports = {
    getSitePayload,
    getGraph,
    putSiteDoc,
    putSiteLocale,
    deleteSiteLocale,
    localeName,
    postSiteAiTranslate,
    postSitePublish,
    putSiteLive,
    putEnabled,
    putDefaultLocale,
};
