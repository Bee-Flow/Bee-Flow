/**
 * The <head> a crawler actually receives.
 *
 * `agent-hub/src/marketing/useCmsHead.js` already sets title/description/og on
 * the client, and keeps doing so for in-app navigation. The problem it cannot
 * solve is that social scrapers — LinkedIn, Slack, X, Facebook — do not run
 * JavaScript. Every Bee Flow link shared anywhere rendered as the static
 * fallback in agent-hub/index.html: "Bee Flow - AI / Chat with AI agents
 * powered by Bee Flow". This module is what fixes that, because it runs before
 * the response leaves the server.
 *
 * Also emitted here and nowhere else in the codebase: canonical, og:url,
 * og:type, og:site_name, og:locale, every twitter:* tag, hreflang alternates,
 * and JSON-LD.
 */

const { esc, meta, clamp, jsonForScript } = require('./html');
const { buildJsonLd } = require('./jsonld');
const { buildPublicPath } = require('./publicPath');
const { buildFontsHead } = require('./fonts');

// Search engines truncate around these; the numbers are a budget, not a rule.
// Kept identical to the counters in the editor (SeoSection.jsx) so authors
// never see a title survive the editor and still get clamped here.
const TITLE_MAX = 60;
const DESC_MAX = 155;

// Pages that describe the product itself get SoftwareApplication.
const PRODUCT_SLUGS = new Set(['', 'platform', 'sovereignty']);

function absolute(origin, urlOrPath) {
    if (!urlOrPath) return '';
    const s = String(urlOrPath);
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('cms/')) return `${origin}/api/cms/asset/${s.split('/').map(encodeURIComponent).join('/')}`;
    return `${origin}${s.startsWith('/') ? '' : '/'}${s}`;
}

/**
 * @param {object} ctx
 * @param {string} ctx.origin      e.g. https://beeflow.nl (no trailing slash)
 * @param {string} ctx.slug        '' for the homepage
 * @param {string} ctx.locale      the locale being served
 * @param {string} ctx.defaultLocale
 * @param {string[]} ctx.locales   every locale the site publishes
 * @param {object} ctx.page        the resolved CMS page
 * @param {object} ctx.design      site design (favicon, logo)
 * @param {string} ctx.siteName
 * @returns {string} tags to splice into <head>
 */
function buildHead(ctx) {
    const { origin, slug, locale, defaultLocale, locales = [], page = {}, design = {}, siteName = 'Bee Flow' } = ctx;
    const seo = page.seo || {};

    const title = clamp(seo.metaTitle || page.title || siteName, TITLE_MAX);
    const description = clamp(seo.metaDescription || '', DESC_MAX);
    const path = buildPublicPath(locale, slug, defaultLocale);
    const url = `${origin}${path === '/' ? '/' : path}`;
    const image = absolute(origin, seo.ogImage || design.logo || '');
    const favicon = absolute(origin, design.favicon || '/app-icon.svg');

    const out = [];
    out.push(`<title>${esc(title)}</title>`);
    out.push(meta('description', description));

    // Canonical. Nothing in the codebase emitted one, which left `www` and the
    // apex serving the entire site as two independent origins (the ingress
    // deliberately mirrors them, 08-ingress.tpl.yaml), plus /pricing,
    // /pricing/, /Pricing and /?slug=pricing all resolving. One tag settles
    // all of it without touching the ingress.
    out.push(`<link rel="canonical" href="${esc(url)}">`);

    // noindex was authored in the CMS and applied only by client JS, i.e. it
    // was invisible to the crawlers it exists to stop.
    if (seo.noIndex) out.push(meta('robots', 'noindex, nofollow'));
    else out.push(meta('robots', 'index, follow, max-image-preview:large'));

    out.push(meta('og:type', slug ? 'website' : 'website', { property: true }));
    out.push(meta('og:site_name', siteName, { property: true }));
    out.push(meta('og:title', title, { property: true }));
    out.push(meta('og:description', description, { property: true }));
    out.push(meta('og:url', url, { property: true }));
    out.push(meta('og:locale', locale, { property: true }));
    for (const alt of locales.filter(l => l !== locale)) {
        out.push(meta('og:locale:alternate', alt, { property: true }));
    }
    if (image) out.push(meta('og:image', image, { property: true }));

    out.push(meta('twitter:card', image ? 'summary_large_image' : 'summary'));
    out.push(meta('twitter:title', title));
    out.push(meta('twitter:description', description));
    if (image) out.push(meta('twitter:image', image));

    // hreflang. Without these, /pricing and /nl/pricing compete instead of
    // being recognised as the same page in two languages.
    if (locales.length > 1) {
        for (const alt of locales) {
            const href = `${origin}${buildPublicPath(alt, slug, defaultLocale)}`;
            out.push(`<link rel="alternate" hreflang="${esc(alt)}" href="${esc(href)}">`);
        }
        const def = `${origin}${buildPublicPath(defaultLocale, slug, defaultLocale)}`;
        out.push(`<link rel="alternate" hreflang="x-default" href="${esc(def)}">`);
    }

    if (favicon) out.push(`<link rel="icon" href="${esc(favicon)}">`);

    // Font preloads + first-paint font variables. Emitted here because the
    // server is the only party that knows the design BEFORE first paint —
    // the client applies fonts in a post-mount effect, which is a re-melt of
    // every heading, not a first paint. See core/seo/fonts.js.
    const fontsHead = buildFontsHead(design.fonts);
    if (fontsHead) out.push(fontsHead);

    const jsonLd = buildJsonLd({
        origin, siteName, url, title, description, locale, slug,
        localePrefix: locale && locale !== defaultLocale ? `/${locale}` : '',
        logoUrl: absolute(origin, design.logo || ''),
        sameAs: ['https://github.com/Bee-Flow/Bee-Flow'],
        blocks: page.blocks || [],
        isProductPage: PRODUCT_SLUGS.has(slug),
    });
    out.push(`<script type="application/ld+json">${jsonForScript(jsonLd)}</script>`);

    return out.filter(Boolean).join('\n    ');
}

module.exports = { buildHead, TITLE_MAX, DESC_MAX };
