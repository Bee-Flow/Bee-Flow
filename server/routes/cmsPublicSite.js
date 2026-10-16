// @typecheck
/**
 * The PUBLIC read of the live CMS site: GET /api/cms/site (page, blog index or
 * post, legacy or v2 shape) with the analytics envelope (Umami + Google
 * Analytics + the per-page opt-out).
 *
 * Extracted verbatim from routes/cms.js, which still mounts it as
 * router.get('/site', getPublicSite) in the same place.
 */

const { synthesizeLegacyContent } = require('../core/cms/legacyContent');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const cmsStore = require('../stores/cmsStore');
const { getLiveSiteId } = require('./cmsShared');
const cmsAnalytics = require('./cmsAnalytics');
const {
    getAnalyticsSettings, getAnalyticsSiteMap, getRecorderMap,
} = cmsAnalytics;

// One background publish per site at a time (a visitor burst must not start
// many), and after a failure none for HEAL_BACKOFF_MS (a broken storage must not
// be hammered by every visitor retry).
const HEAL_BACKOFF_MS = 60000;
const healing = new Map(); // siteId → 0 while running, else the time it may run again
function healSnapshotInBackground(siteId, now = Date.now()) {
    const state = healing.get(siteId);
    if (state === 0 || (state && now < state)) return;
    healing.set(siteId, 0);
    Promise.resolve()
        .then(() => cmsStore.publishSite(siteId))
        .then(() => healing.delete(siteId))
        .catch((e) => {
            log.warn(`[CMS] background publish for live site ${siteId} failed: ${e.message}`);
            healing.set(siteId, Date.now() + HEAL_BACKOFF_MS);
        });
}

/**
 * GET /api/cms/site
 *   v=2 → { enabled, defaultLocale, locale, found, page, header, footer, pages }
 *   no v → legacy shape: { enabled, defaultLocale, locale, content }
 *
 * `?slug=…` selects a page. When omitted the homepage is returned.
 * `?locale=…` picks a locale; falls back to default.
 *
 * Reads from whichever project is currently marked Live (cms_live_site_id).
 * When nothing is live the response is `{ enabled: false }` and the front-end
 * redirects "/" to /app.
 */
// No schema on this query, on purpose: it is the PUBLIC site's own content
// read (App.jsx fetches it on every visit), and a refusal would blank the
// public site instead of serving the default page. Each of the three values
// is read defensively below: an unknown `locale` or `slug` falls back.
async function getPublicSite(req, res) {
    // Public site serves whatever project is marked Live. If nothing is
    // live the public URL stays dark (RootPathGate redirects to /app).
    // Note: this is decoupled from the admin's active project — admins
    // can edit a different site without affecting what the public sees.
    const siteId = await getLiveSiteId();
    // Self-hosted installs have no public marketing site — the root domain
    // goes straight to /app. `appOnly` tells RootPathGate to redirect there
    // (it runs outside LicenseProvider so it can't read deployment mode on
    // its own). Emitted on every shape so the flag is present regardless of
    // whether a site is live. The license module is lazy-required (never at
    // module top-level) to preserve boot ordering — it pulls in heavy
    // userStore DB init that must load after this route, not during it.
    const { serverLicenseGovernsOrgs } = require('../license');
    const appOnly = serverLicenseGovernsOrgs();
    // Disable caching here — content updates from the admin should
    // appear immediately. Re-introduce a short TTL once edits push a
    // version bump or cache key.
    res.setHeader('Cache-Control', 'no-store');
    if (!siteId) {
        return res.json({ enabled: false, appOnly });
    }

    const defaultLocale = await cmsStore.getDefaultLocale();
    const requested = String(req.query.locale || defaultLocale).toLowerCase();
    const locale = cmsStore.isValidLocale(requested) ? requested : defaultLocale;
    const v2 = req.query.v === '2';
    const slug = (req.query.slug || '').toString();

    // Blog URLs (?blog=index|post&post=<slug>&tag=&page=): the published
    // blog payload with the site chrome, in the same legacy `content`
    // shape a page gets (content.blog carries the posts).
    const blogView = req.query.blog === 'index' || req.query.blog === 'post' ? req.query.blog : null;
    if (blogView) {
        const blogEff = await cmsStore.getEffectiveBlog(siteId, {
            state: 'published',
            view: blogView,
            postSlug: String(req.query.post || '').slice(0, 200),
            tag: String(req.query.tag || '').slice(0, 60),
            page: String(req.query.page || '1').slice(0, 6),
            locale,
        });
        if (!blogEff) return res.json({ enabled: true, appOnly, found: false, defaultLocale, locale });
        return res.json({
            enabled: true,
            appOnly,
            found: !!blogEff.found,
            canonicalSlug: blogEff.page?.slug || 'blog',
            defaultLocale,
            locale,
            content: synthesizeLegacyContent(blogEff),
            design: blogEff.design,
            analytics: null,
        });
    }

    // The public site serves the last-published snapshot only — never the
    // in-progress draft. Going Live publishes first (cmsShared), so a live
    // site without a snapshot is a legacy one (live before publish-on-Live).
    // A visitor request must never run a publish itself (it can be slow or hang
    // on storage and would hold the request open): heal it in the background,
    // once, and answer 503 until the snapshot exists.
    const eff = await cmsStore.getEffectivePublished(siteId, slug || null, locale);
    if (!eff) {
        healSnapshotInBackground(siteId);
        res.setHeader('Retry-After', '10');
        throw new HttpError(503, 'cms_not_published', 'The site is being prepared. Please try again shortly.');
    }

    // Canonical URL for the served page: '' for the homepage, otherwise
    // its slug. The client uses this to redirect e.g. `/home` → `/` so
    // every page has exactly one URL.
    const canonicalSlug = eff.page?.isHomepage
        ? ''
        : (eff.page?.slug || '');

    // Analytics tracker config. Umami keys (websiteId / scriptUrl /
    // consentMode) are emitted top-level — only when tracking is on,
    // configured, and THIS live site has a provisioned Umami website.
    // The client injects a tiny async <script> (cookieless by default)
    // so page load stays fast. Best-effort: never let an analytics
    // hiccup break the public render.
    /** @type {Record<string, any> | null} */
    let analytics = null;
    try {
        const aSettings = await getAnalyticsSettings();
        if (aSettings.enabled && aSettings.url) {
            const websiteId = (await getAnalyticsSiteMap())[siteId];
            if (websiteId) {
                const base = aSettings.url.replace(/\/+$/, '');
                analytics = {
                    websiteId,
                    scriptUrl: `${base}/script.js`,
                    consentMode: aSettings.consentMode,
                    // Mirrored onto the <script> tag. /site is no-store, so
                    // changing an option applies on the visitor's next page
                    // load — no republish needed.
                    trackerOptions: await cmsAnalytics.getTrackerOptions(),
                };
                // Session recording (heatmaps + replays) is a separate,
                // per-site opt-in. Emitting the url does NOT mean it loads:
                // the client gates the recorder on cookie-banner consent in
                // EVERY consent mode, because recording a visitor's mouse,
                // scroll and DOM is not cookieless-innocent the way a
                // pageview count is.
                if ((await getRecorderMap())[siteId]) {
                    analytics.recorderUrl = `${base}/recorder.js`;
                }
            }
        }
    } catch (e) { log.warn('[CMS] /site analytics config skipped:', e.message); }
    // Site-level Google Analytics + per-page opt-out ride in the same
    // envelope. `ga` is null unless the site carries a valid measurement
    // id (sanitized on save by cmsStore.sanitizeAnalytics; resolveEffective
    // threads it through the published snapshot as eff.analytics), and
    // `disabledForPage` reflects the served page's noAnalytics flag. The
    // envelope is non-null when Umami OR GA is configured — a GA-only org
    // gets `{ ga, disabledForPage }` without the Umami keys — and stays
    // null when neither is.
    const ga = eff.analytics?.gaMeasurementId
        ? { measurementId: eff.analytics.gaMeasurementId }
        : null;
    if (analytics || ga) {
        analytics = {
            ...(analytics || {}),
            ga,
            disabledForPage: !!eff.page?.noAnalytics,
        };
    }

    if (v2) {
        return res.json({
            enabled: true,
            appOnly,
            defaultLocale,
            locale,
            found: eff.found,
            canonicalSlug,
            page: eff.page,
            header: eff.header,
            footer: eff.footer,
            pages: eff.pages,
            design: eff.design,
            analytics,
        });
    }
    return res.json({
        enabled: true,
        appOnly,
        // `found` lets the front-end distinguish "slug exists but has no
        // blocks" (render anyway) from "slug doesn't match any page"
        // (fall through to the BeeFlow app router) when path-routing.
        found: eff.found,
        canonicalSlug,
        defaultLocale,
        locale,
        content: synthesizeLegacyContent(eff),
        design: eff.design,
        analytics,
    });
}

module.exports = { getPublicSite };
