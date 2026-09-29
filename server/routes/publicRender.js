/**
 * Server-rendered marketing pages.
 *
 * WHY THIS EXISTS: the marketing site was a pure client-side SPA. A crawler
 * received `<div id="root"></div>` plus the app's default title, and social
 * scrapers — LinkedIn, Slack, X — do not run JavaScript at all, so every link
 * ever shared rendered as "Bee Flow - AI / Chat with AI agents powered by Bee
 * Flow" regardless of which page it pointed at.
 *
 * This is not dynamic rendering and not cloaking: every visitor gets the same
 * response. React mounts over `#root` and replaces the server markup with the
 * designed version, exactly as it does today.
 *
 * FAILURE POSTURE: every error path returns `next()`, which lets nginx fall
 * back to serving the static shell. A CMS outage, an unreachable agent-hub or
 * a malformed page degrades the site to its old client-rendered behaviour
 * rather than 500-ing. That matters because nginx now routes page loads
 * through here — this route must never be able to take the site down.
 *
 * ── Why the query has no schema ──────────────────────────────────────
 * Deliberately left OPEN. These are pages a browser NAVIGATES to — a first
 * visit, a crawler, a link somebody shared — and the query belongs to whoever
 * built the link: utm_* from a campaign, gclid/fbclid from an ad platform,
 * whatever a newsletter tool appends. A 400 would turn a paid click into an
 * error page, which the failure posture above rules out: every error path
 * here is next(). The route reads one parameter itself, `locale`, and a value
 * it does not know is simply not consolidated. robots.txt, sitemap.xml and
 * llms.txt read none, and the page route is a regex with no named params.
 *
 * What the open query DID get wrong is how the two 301s carried it: they
 * rebuilt it from req.query, where Express has already folded a repeated key
 * into an array, and URLSearchParams writes that array back as ONE
 * comma-joined value — `/pricing?locale=nl&tag=a&tag=b` landed on
 * `/nl/pricing?tag=a%2Cb`. Both are rebuilt from the query string as sent now.
 * And the untranslated-page redirect kept `locale`, which the consolidation
 * then acted on again: `/nl/pricing?locale=nl` took three 301s to land on
 * `/pricing`, via the page it had just left. Both redirects drop it now.
 */

const express = require('express');
const cmsStore = require('../stores/cmsStore');
const configStore = require('../stores/configStore');
const languageStore = require('../stores/languageStore');
const { parsePublicPath, buildPublicPath, LOCALE_PREFIXES } = require('../core/seo/publicPath');
const { buildHead } = require('../core/seo/head');
const { renderBlocks, PREHYDRATE_CSS } = require('../core/seo/renderBlocks');
const { getShell } = require('../core/seo/shell');
const { injectIntoShell } = require('../core/seo/inject');
const { buildSitemap, buildRobots, buildLlmsTxt } = require('../core/seo/sitemap');
const { localesForPage } = require('../core/seo/locales');
const { LEGACY_SLUGS } = require('../core/seo/legacySlugs');
const { jsonForScript } = require('../core/seo/html');
const { synthesizeLegacyContent } = require('../core/cms/legacyContent');
const log = require('../telemetry/log');

const router = express.Router();

/**
 * The configured public origin of the MARKETING SITE, or '' when unset.
 *
 * `PUBLIC_SITE_URL` is deliberately its own variable rather than a reuse of
 * `PUBLIC_BASE_URL`. The latter means "the externally-reachable base URL of
 * this server" (automation/publicUrl.js) and doubles as the switch that decides
 * whether MS Graph subscriptions get provisioned at all — triggerBus.js skips
 * them when it is unset. Setting that on the cluster purely to satisfy the
 * indexability gate below would silently turn on webhook provisioning for every
 * existing automation, which is not a change an SEO fix should be making.
 *
 * The fallback keeps installs that already set only PUBLIC_BASE_URL working:
 * on a single-host self-host deployment the two origins are the same value.
 */
function configuredOrigin() {
    const configured = process.env.PUBLIC_SITE_URL || process.env.PUBLIC_BASE_URL || '';
    return configured.replace(/\/+$/, '');
}

/** The public origin. Wrong here means wrong canonicals on every page. */
function resolveOrigin(req) {
    const configured = configuredOrigin();
    if (configured) return configured;
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
}

/**
 * Only index the real site. A preview host or a bare IP that answers on the
 * same image would otherwise compete with beeflow.nl in the index.
 */
function isIndexableHost(origin) {
    const configured = configuredOrigin();
    if (!configured) return false;               // unknown host ⇒ do not invite crawlers
    return origin === configured || origin === configured.replace('://', '://www.');
}

/**
 * The locales this SITE publishes, default first.
 *
 * Intersected with LOCALE_PREFIXES rather than taken from the product's
 * interface-translation list: that list includes every language the GUI has
 * strings for, and using it made each page advertise hreflang alternates —
 * /de/, /fr/ — that the router does not serve and no translator has written.
 */
async function siteLocales() {
    const defaultLocale = await cmsStore.getDefaultLocale();
    let extra = [];
    try {
        const available = await languageStore.getAvailableLocales();
        extra = (available || [])
            .map(l => String(l.code).toLowerCase())
            .filter(code => code !== defaultLocale && LOCALE_PREFIXES.has(code));
    } catch (_) { /* a single-locale site is a fine fallback */ }
    return { defaultLocale, locales: [defaultLocale, ...extra] };
}

async function getLiveSiteId() {
    return (await configStore.getConfig('cms_live_site_id')) || null;
}

/**
 * The query exactly as it arrived, repeated keys and all — not req.query,
 * whose arrays URLSearchParams would join with commas (see the header).
 */
function rawQuery(req) {
    const url = String(req.originalUrl || req.url || '');
    const at = url.indexOf('?');
    return new URLSearchParams(at === -1 ? '' : url.slice(at + 1));
}


// ── robots.txt ───────────────────────────────────────────────────────
router.get('/robots.txt', async (req, res, next) => {
    try {
        const origin = resolveOrigin(req);
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600');
        return res.send(buildRobots({ origin, allow: isIndexableHost(origin) }));
    } catch (err) {
        log.warn('[SEO] robots.txt failed:', err.message);
        return next();
    }
});

// ── sitemap.xml ──────────────────────────────────────────────────────
router.get('/sitemap.xml', async (req, res, _next) => {
    /* A sitemap must never fall through to the SPA.
     *
     * Every `return next()` here used to end at the client-side shell, which
     * answers 200 with `text/html` — so a probe for the sitemap got a page of
     * HTML claiming to be one. That is precisely the state Search Console has
     * been reporting as "1 error, 0 discovered pages", and it is worse than a
     * plain failure because it looks like a success to everything upstream.
     *
     * So: an empty urlset when there is genuinely nothing to advertise, and a
     * 503 when the CMS could not be read. Both are honest XML. */
    const origin = resolveOrigin(req);
    const emptySitemap = () => {
        res.type('application/xml').set('Cache-Control', 'public, max-age=600');
        return res.send(buildSitemap([], { origin }));
    };

    try {
        const siteId = await getLiveSiteId();
        if (!siteId) return emptySitemap();

        const { defaultLocale, locales } = await siteLocales();

        // The PUBLISHED snapshot, not the draft: the sitemap must advertise
        // what is actually being served. It is also the only source that
        // carries each page's full `seo` (the page index entry does not), and
        // `seo.noIndex` decides whether a page belongs in here at all.
        const snapshot = await cmsStore.getPublishedSnapshot(siteId);
        if (!snapshot) return emptySitemap();

        // Per-page when the snapshot carries it (see cmsStore.publishSite);
        // the site-wide publish date is the fallback for older snapshots.
        const lastmod = snapshot.publishedAt || null;
        const pages = (snapshot.site?.pages || [])
            .map(entry => {
                const full = snapshot.pages?.[entry.id] || {};
                return {
                    ...entry,
                    seo: full.seo || {},
                    updatedAt: snapshot.pageMeta?.[entry.id]?.lastModifiedAt || lastmod,
                    locales: localesForPage(snapshot, entry.id, defaultLocale, locales),
                };
            });

        res.type('application/xml').set('Cache-Control', 'public, max-age=600');
        return res.send(buildSitemap(pages, { origin, defaultLocale, locales }));
    } catch (err) {
        log.warn('[SEO] sitemap failed:', err.message);
        res.type('application/xml').set('Cache-Control', 'no-store');
        return res.status(503).send(buildSitemap([], { origin }));
    }
});

// ── llms.txt ─────────────────────────────────────────────────────────
// Same source as the sitemap, addressed to language models rather than
// crawlers. Falls through when nothing is published or the host is not the
// indexable one — an empty Markdown file would still claim to be a real one,
// and a preview host has no business advertising itself to assistants.
router.get('/llms.txt', async (req, res, next) => {
    try {
        const origin = resolveOrigin(req);
        const siteId = await getLiveSiteId();
        if (!siteId || !isIndexableHost(origin)) return next();

        const snapshot = await cmsStore.getPublishedSnapshot(siteId);
        if (!snapshot) return next();

        const pages = (snapshot.site?.pages || []).map(entry => ({
            ...entry,
            seo: (snapshot.pages?.[entry.id] || {}).seo || {},
        }));
        const home = pages.find(p => p.isHomepage);

        res.type('text/plain').set('Cache-Control', 'public, max-age=3600');
        return res.send(buildLlmsTxt(pages, {
            origin,
            siteName: snapshot.site?.name || 'Bee Flow',
            summary: String(home?.seo?.metaDescription || '').trim(),
        }));
    } catch (err) {
        log.warn('[SEO] llms.txt failed:', err.message);
        return next();
    }
});

// ── marketing pages ──────────────────────────────────────────────────
router.get(/^\/(?!api\/|assets\/|__demo__\/|__cms_preview__).*/, async (req, res, next) => {
    try {
        const origin = resolveOrigin(req);
        const siteId = await getLiveSiteId();
        if (!siteId) return next();

        const { defaultLocale, locales } = await siteLocales();
        const parsed = parsePublicPath(req.path, locales);
        if (!parsed) return next();

        // Consolidate the old ?locale= form onto its path URL. It produced
        // three crawlable addresses per page (bare, ?locale=en, ?locale=nl)
        // with no canonical, so they competed instead of pointing at one page.
        //
        // Everything EXCEPT `locale` is carried over. Dropping the rest threw
        // away campaign attribution on arrival: a visitor landing on
        // /pricing?locale=nl&utm_source=… was redirected to a bare /nl/pricing,
        // so the session was recorded as direct traffic and the click that paid
        // for it went unattributed. `locale` itself is the one param that must
        // not survive — it is what we are consolidating away.
        const rest = rawQuery(req);
        const queryLocale = String(rest.get('locale') || '').toLowerCase().split('-')[0];
        if (queryLocale && locales.includes(queryLocale)) {
            const target = buildPublicPath(queryLocale, parsed.slug, defaultLocale);
            rest.delete('locale');
            const qs = rest.toString();
            if (target !== req.path) return res.redirect(301, qs ? `${target}?${qs}` : target);
        }

        // Slugs that used to exist and now resolve somewhere else. Without this
        // they would fall through to the SPA and render a 404 shell, throwing
        // away whatever ranking and inbound links they had earned. Keep the
        // locale prefix so /nl/<old> lands on /nl/<new>.
        const legacy = LEGACY_SLUGS[parsed.slug];
        if (legacy) {
            return res.redirect(301, buildPublicPath(parsed.locale, legacy, defaultLocale));
        }

        const locale = parsed.locale || defaultLocale;
        const eff = await cmsStore.getEffectivePublished(siteId, parsed.slug || null, locale);

        /* No page here, but the PATH is marketing-shaped: a single unreserved
           segment the CMS simply has nothing for. This used to `next()`, which
           ends at the SPA shell with a 200 — a soft 404. Google keeps a URL
           that answers 200 in the index indefinitely, which is why the retired
           V1 pages above are still listed months after they stopped existing.
           A status code is the only way to say "stop listing this".

           410 rather than 404, for a mechanical reason: nginx's @render block
           maps `error_page 404 … = @shell`, so a 404 from here is swallowed and
           reappears as a 200 shell — the very thing being fixed. That mapping
           is load-bearing (it is how genuine app routes reach the SPA when this
           route declines them), so the fix must not disturb it. 410 is not in
           that list, passes through untouched, and Google documents it as
           equivalent to 404 for removal, only acted on slightly sooner. Which
           is honest here: these are pages that are gone, not pages that never
           were.

           Reserved and multi-segment paths never get here — parsePublicPath
           returned null for those above, and they still fall through to the
           SPA exactly as before. */
        if (!eff || !eff.found || !eff.page) {
            const shell410 = await getShell();
            if (!shell410) return next();
            res.status(410).type('html').set('Cache-Control', 'no-store');
            return res.send(injectIntoShell(shell410, {
                head: [
                    '<title>Page not found — Bee Flow</title>',
                    '<meta name="robots" content="noindex, follow">',
                ].join('\n    '),
                body: '',
                lang: locale,
            }));
        }

        const shell = await getShell();
        if (!shell) return next();

        const siteName = (eff.header && eff.header.logoText) || 'Bee Flow';
        // hreflang for THIS page only. See localesForPage: the site-wide list
        // says which languages exist, not which ones this page was written in.
        const snapshot = await cmsStore.getPublishedSnapshot(siteId);
        const pageLocales = eff.page.id
            ? localesForPage(snapshot, eff.page.id, defaultLocale, locales)
            : [defaultLocale];

        /* A locale-prefixed URL for a page with no translation in that locale
           serves the default language under a second address: duplicate
           content with its own canonical, and a `lang` attribute that lies
           (WCAG 3.1.1). Redirect to the default-locale URL until a
           translation exists — localesForPage is the same source hreflang
           and the sitemap use, so the three cannot disagree. The redirect
           disappears by itself the moment a translator publishes the page. */
        if (locale !== defaultLocale && !pageLocales.includes(locale)) {
            // `locale` goes here too. Carried along, `/nl/pricing?locale=nl`
            // bounced /pricing?locale=nl → /nl/pricing → /pricing: three
            // 301s, the middle one sending the visitor back to the page that
            // had just sent them away.
            const kept = rawQuery(req);
            kept.delete('locale');
            const qs = kept.toString();
            const target = buildPublicPath(defaultLocale, parsed.slug, defaultLocale);
            return res.redirect(301, qs ? `${target}?${qs}` : target);
        }

        const head = buildHead({
            origin, slug: parsed.slug, locale, defaultLocale, locales: pageLocales,
            page: eff.page, design: eff.design || {}, siteName,
        });
        const body = renderBlocks(eff.page.blocks, { fallbackTitle: eff.page.title });

        /* The same payload GET /api/cms/site would return, inlined.
         *
         * WHY: React could not use any of the markup above. `RootPathGate`
         * mounts with `cms === null`, and its null branch painted a
         * full-viewport #06090F rectangle over the server-rendered page while
         * it fetched the content it had just been sent — so the real sequence
         * was: server HTML, held invisible for 450ms by the pre-hydration CSS,
         * then a black screen, then a network round trip, then finally the
         * page. Lighthouse caught it exactly: the first filmstrip frame is
         * solid black, FCP 1.9s, CLS 0.437.
         *
         * With the state inlined the first React render already has content,
         * so nothing is destroyed and nothing is waited on. Analytics config
         * is deliberately NOT included — it needs the Umami site map and the
         * recorder flags, it is irrelevant before first paint, and leaving it
         * out keeps this in step with /api/cms/site instead of duplicating it.
         * The client fetches that separately, after paint.
         *
         * `jsonForScript` escapes `<` so a CMS string can never close the
         * script tag; the same helper guards the JSON-LD block above. */
        const bootstrap = jsonForScript({
            enabled: true,
            found: true,
            // Same rule as routes/cms.js: '' for the homepage, else the slug.
            canonicalSlug: eff.page.isHomepage ? '' : (eff.page.slug || ''),
            defaultLocale,
            locale,
            content: synthesizeLegacyContent(eff),
            design: eff.design || {},
        });

        // Inlined, not a stylesheet link: it has to apply on the first paint,
        // and a second render-blocking request to style markup that lives for
        // one moment would cost more than it saves.
        const headWithCss = body
            ? `${head}
    <style>${PREHYDRATE_CSS}</style>
    <script type="application/json" id="__BEEFLOW_CMS__">${bootstrap}</script>`
            : head;

        /* This response is anonymous and identical for every visitor on a given
           path: the locale comes from the URL, `getEffectivePublished` only ever
           returns published content, and the preview route is excluded by the
           matcher above. Anything per-visitor (consent, announcement dismissal,
           auth state) is decided client-side after hydration.

           It was `no-store`, which forbids every cache in the chain — browser
           back/forward, the ingress, any CDN in front — so each navigation paid
           a full origin round trip for bytes that had not changed. Publishing in
           the CMS is the only thing that invalidates it, and that is rare.

           s-maxage lets a shared cache serve it outright; stale-while-revalidate
           lets that cache keep answering instantly while it refreshes in the
           background, so a publish costs one slow request, not a stampede. The
           browser's own max-age stays short because the visible cost of stale
           marketing copy is low but not zero. Raise s-maxage once there is a CDN
           with explicit purge-on-publish; until then 5 minutes is the bound on
           how long a just-published edit can take to appear. */
        res.type('html').set('Cache-Control',
            'public, max-age=60, s-maxage=300, stale-while-revalidate=86400');
        return res.send(injectIntoShell(shell, { head: headWithCss, body, lang: locale }));
    } catch (err) {
        log.warn('[SEO] render failed for', req.path, '-', err.message);
        return next();
    }
});

module.exports = router;
