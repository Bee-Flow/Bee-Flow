// @typecheck
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
const { legalRedirectTarget } = require('../core/seo/legalPaths');
const { buildHead } = require('../core/seo/head');
const { renderBlocksWithHints, PREHYDRATE_CSS } = require('../core/seo/renderBlocks');
const { getShell } = require('../core/seo/shell');
const { injectIntoShell } = require('../core/seo/inject');
const { buildSitemap, buildRobots } = require('../core/seo/sitemap');
const { localesForPage } = require('../core/seo/locales');
const { LEGACY_SLUGS, GONE_SLUGS } = require('../core/seo/legacySlugs');
const { resolveSiteRedirect } = require('../core/seo/siteRedirect');
const { versionOf } = require('../core/seo/ogCard');
const { jsonForScript } = require('../core/seo/html');
const { sendNotFound } = require('../core/seo/notFound');
const { synthesizeLegacyContent } = require('../core/cms/legacyContent');
const { buildBlogHead, renderBlogBody, buildFeed } = require('../core/seo/blog');
const { buildAtomFeed } = require('../core/seo/blogAtom');
const { listGalleryItems, integrationSitemapEntries } = require('../core/seo/integrationsDirectory');
const { blogSitemap } = require('./publicRenderBlogSitemap');
const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');

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

/**
 * The public origin. Wrong here means wrong canonicals on every page.
 * @param {import('express').Request} req
 */
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
 * @param {string} origin
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
    /** @type {string[]} */
    let extra = [];
    try {
        const available = await languageStore.getAvailableLocales();
        extra = (available || [])
            .map(l => String(l.code).toLowerCase())
            .filter(code => code !== defaultLocale && LOCALE_PREFIXES.has(code));
    } catch (err) { fallback('routes/publicRender:siteLocales', err); /* a single-locale site is a fine fallback */ }
    return { defaultLocale, locales: [defaultLocale, ...extra] };
}

async function getLiveSiteId() {
    return (await configStore.getConfig('cms_live_site_id')) || null;
}

/**
 * The query exactly as it arrived, repeated keys and all — not req.query,
 * whose arrays URLSearchParams would join with commas (see the header).
 * @param {import('express').Request} req
 */
function rawQuery(req) {
    const url = String(req.originalUrl || req.url || '');
    const at = url.indexOf('?');
    return new URLSearchParams(at === -1 ? '' : url.slice(at + 1));
}


// ── robots.txt ───────────────────────────────────────────────────────
router.get('/robots.txt', async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
    try {
        const origin = resolveOrigin(req);
        res.type('text/plain').set('Cache-Control', 'public, max-age=3600');
        return res.send(buildRobots({ origin, allow: isIndexableHost(origin) }));
    } catch (err) {
        log.warn('[SEO] robots.txt failed:', /** @type {Error} */ (err).message);
        return next();
    }
});

// ── sitemap.xml ──────────────────────────────────────────────────────
router.get('/sitemap.xml', async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ _next) => {
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

        // Per-page when the snapshot carries it (cmsStore.publishSite), else the site-wide publish date.
        const lastmod = snapshot.publishedAt || null;
        const pages = (snapshot.site?.pages || [])
            .map(/** @param {import('../stores/cms/shared').PageIndexEntry} entry */ entry => {
                const full = snapshot.pages?.[entry.id] || {};
                return {
                    ...entry,
                    seo: full.seo || {},
                    updatedAt: snapshot.pageMeta?.[entry.id]?.lastModifiedAt || lastmod,
                    locales: localesForPage(snapshot, entry.id, defaultLocale, locales),
                };
            });

        // Blog: the index and every visible post, in the languages it is translated into.
        const blogEntries = await blogSitemap(siteId, { snapshot, defaultLocale, locales, lastmod });

        res.type('application/xml').set('Cache-Control', 'public, max-age=600');
        return res.send(buildSitemap([...pages, ...blogEntries, ...integrationSitemapEntries(listGalleryItems(), { defaultLocale, lastmod })], { origin, defaultLocale, locales }));
    } catch (err) {
        log.warn('[SEO] sitemap failed:', /** @type {Error} */ (err).message);
        res.type('application/xml').set('Cache-Control', 'no-store');
        return res.status(503).send(buildSitemap([], { origin }));
    }
});

// ── blog feeds (RSS 2.0 at feed.xml, Atom 1.0 at atom.xml) ──────────────────────────────────────────────
// /blog/feed.xml and /<locale>/blog/feed.xml. Like the sitemap, never falls
// through to the SPA: a feed reader that got HTML would report a broken feed.
router.get(/^\/(?:([a-z]{2,3})\/)?blog\/(feed|atom)\.xml$/, async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const origin = resolveOrigin(req);
    try {
        const siteId = await getLiveSiteId();
        const { defaultLocale, locales } = await siteLocales();
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- the locale segment is matched by [a-z]{2,3} and must be one of the site locales; it is never echoed
        const asked = req.params[0] ? String(req.params[0]).toLowerCase() : null;
        if (!siteId || (asked && (asked === defaultLocale || !locales.includes(asked)))) {
            return res.status(404).type('text/plain').set('Cache-Control', 'public, max-age=300').send('Not found');
        }
        const locale = asked || defaultLocale;
        const latest = await cmsStore.getLatestPublishedPosts(siteId, { locale, limit: 30, withBody: true });
        const blogSettings = cmsStore.sanitizeBlogSettings(latest.site?.blog);
        /** @param {Record<string, string> | undefined} m */
        const pick = (m) => (m && (m[locale] || m[defaultLocale])) || '';
        const { blogLabels } = require('../stores/cms/blogEffective');
        const labels = await blogLabels(locale);
        const siteName = latest.site?.header?.logoText || latest.site?.name || 'Bee Flow';
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- req.params[1] is only compared with 'atom', never written
        const atom = req.params[1] === 'atom';
        res.type(atom ? 'application/atom+xml; charset=utf-8' : 'application/rss+xml; charset=utf-8')
            .set('Cache-Control', 'public, max-age=300, s-maxage=600');
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write, ajinabraham.njsscan.xss.xss_node.express_xss -- buildFeed and buildAtomFeed escape every string into XML; the response type is application/rss+xml or application/atom+xml
        return res.send((atom ? buildAtomFeed : buildFeed)(latest.posts, {
            origin, siteName, locale, defaultLocale,
            title: pick(blogSettings.title) || labels.title || 'Blog',
            description: pick(blogSettings.description),
            lastBuildDate: latest.publishedAt,
        }));
    } catch (err) {
        log.warn('[SEO] blog feed failed:', /** @type {Error} */ (err).message);
        return res.status(503).type('text/plain').set('Cache-Control', 'no-store').send('Feed unavailable');
    }
});

/**
 * A blog URL: the index (/blog, ?tag=, ?page=) or a post (/blog/<slug>), with
 * the same failure posture as pages — every error path is next().
 * Returns false when the URL should be handled as an ordinary page instead
 * (a legacy page slugged "blog").
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ origin: string, siteId: string, parsed: NonNullable<ReturnType<typeof import('../core/seo/publicPath').parsePublicPath>>, defaultLocale: string, locales: string[] }} opts
 * @returns {Promise<boolean>}
 */
async function renderBlog(req, res, { origin, siteId, parsed, defaultLocale, locales }) {
    const locale = parsed.locale || defaultLocale;
    const q = rawQuery(req);
    const eff = await cmsStore.getEffectiveBlog(siteId, {
        state: 'published',
        view: parsed.blog.view,
        postSlug: parsed.blog.postSlug,
        tag: q.get('tag') || '',
        page: Number.parseInt(q.get('page') || '1', 10) || 1,
        locale,
        siteLocales: locales,
    });
    if (!eff) return false;
    if (parsed.blog.view === 'index' && (eff.pages || []).some(/** @param {import('../stores/cms/shared').PageIndexEntry} p */ p => p.slug === 'blog')) return false;

    if (!eff.found || (!eff.blog?.post && parsed.blog.view === 'post')) {
        const notFoundShell = await getShell();
        if (!notFoundShell) return false;
        sendNotFound(res, notFoundShell, locale, false);
        return true;
    }

    const pageLocales = eff.blog.locales || [defaultLocale];
    if (locale !== defaultLocale && !pageLocales.includes(locale)) {
        const kept = rawQuery(req);
        kept.delete('locale');
        const qs = kept.toString();
        const target = buildPublicPath(defaultLocale, parsed.slug, defaultLocale);
        res.redirect(301, qs ? `${target}?${qs}` : target);
        return true;
    }

    const shell = await getShell();
    if (!shell) return false;
    const siteName = (eff.header && eff.header.logoText) || 'Bee Flow';
    const head = buildBlogHead({ origin, eff, locale, defaultLocale, locales: pageLocales, siteName });
    const body = renderBlogBody(eff);
    const bootstrap = jsonForScript({
        enabled: true,
        found: true,
        canonicalSlug: eff.page.slug,
        defaultLocale,
        locale,
        content: synthesizeLegacyContent(eff),
        design: eff.design || {},
    });
    const headWithCss = `${head}
    <style>${PREHYDRATE_CSS}</style>
    <script type="application/json" id="__BEEFLOW_CMS__">${bootstrap}</script>`;
    // Same anonymous, identical-for-everyone response as a page (see below).
    res.type('html').set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400');
    res.send(injectIntoShell(shell, { head: headWithCss, body, lang: locale }));
    return true;
}

router.use(require('./publicLlmsRender').createLlmsRouter({ resolveOrigin, getLiveSiteId, isIndexableHost }));

// ── marketing pages ──────────────────────────────────────────────────
router.use(require('./publicSearchIndexRender').createSearchIndexRouter({ getLiveSiteId, siteLocales }));
router.use(require('./publicIntegrationsRender').createIntegrationsRouter({ resolveOrigin, getLiveSiteId }));

router.get(/^\/(?!api\/|assets\/|__demo__\/|__cms_preview__).*/, async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
    try {
        const origin = resolveOrigin(req);
        const siteId = await getLiveSiteId();
        if (!siteId) return next();

        const { defaultLocale, locales } = await siteLocales();

        // Editor-managed redirects (renamed or merged pages), answered before this address is taken for a page, a 410 or the SPA.
        // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect -- the target was validated when saved (stores/cms/redirectRules.js): a site path, or an https URL on the site's allow-list
        const managed = resolveSiteRedirect(await cmsStore.getPublishedSnapshot(siteId), req.path, locales, rawQuery(req));
        if (managed) {
            res.set('Cache-Control', 'public, max-age=60, s-maxage=300');
            return res.redirect(managed.status, managed.location);
        }

        // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect, ajinabraham.njsscan.xss.xss_node.express_xss -- parsePublicPath only yields [a-z0-9-] slugs; every redirect target below is buildPublicPath(...), a same-site path starting with one "/", and pages are rendered through the escaping head/body builders
        const legalTarget = legalRedirectTarget(req.path, locales, defaultLocale);
        if (legalTarget) {
            const qs = rawQuery(req).toString();
            return res.redirect(301, qs ? `${legalTarget}?${qs}` : legalTarget);
        }
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss, ajinabraham.njsscan.redirect.open_redirect.express_open_redirect -- parsePublicPath only yields [a-z0-9-] slugs, every redirect below goes to buildPublicPath(...) (a same-site path), and pages render through the escaping head and body builders
        let parsed = parsePublicPath(req.path, locales);
        if (!parsed) return next();

        if (parsed.blog) {
            if (await renderBlog(req, res, { origin, siteId, parsed, defaultLocale, locales })) return undefined;
            // Not handled: only /blog itself may fall back to a legacy page of that slug.
            if (parsed.blog.view !== 'index') return next();
            parsed = { locale: parsed.locale, slug: 'blog' };
        }

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
        const legacy = /** @type {Record<string, string>} */ (LEGACY_SLUGS)[parsed.slug];
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

           404, except for a slug on GONE_SLUGS (deleted on purpose), which is
           410: Google drops a 410 quickly, so it must not be the answer for
           typos or a page that is only unpublished for a while.

           nginx's @render block maps `error_page 404 … = @shell`, which would
           turn this 404 back into a 200 shell. sendNotFound therefore sets
           `X-Beeflow-Render: not-found`, and @shell (agent-hub/nginx.conf.template)
           keeps the 404 for responses that carry it, while a plain 404 (a genuine
           app route this renderer declines) still reaches the SPA as before.

           Reserved and multi-segment paths never get here — parsePublicPath
           returned null for those above, and they still fall through to the
           SPA exactly as before. */
        if (!eff || !eff.found || !eff.page) {
            const notFoundShell = await getShell();
            if (!notFoundShell) return next();
            return sendNotFound(res, notFoundShell, locale, GONE_SLUGS.has(parsed.slug));
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

        await require('../stores/cms/stories').fillCustomerStories(siteId, eff.page, locale);
        const { html: body, headLinks } = renderBlocksWithHints(eff.page.blocks, { fallbackTitle: eff.page.title, chrome: { header: eff.header, footer: eff.footer } });
        const head = buildHead({
            origin, slug: parsed.slug, locale, defaultLocale, locales: pageLocales,
            page: eff.page, design: eff.design || {}, siteName, shareImageVersion: versionOf(snapshot && snapshot.publishedAt),
            extraLinks: headLinks,
        });

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
        log.warn('[SEO] render failed for', req.path, '-', /** @type {Error} */ (err).message);
        return next();
    }
});

module.exports = router;
