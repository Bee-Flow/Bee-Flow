/**
 * sitemap.xml, generated from the live CMS site.
 *
 * There was no sitemap and no generator. Worse, `GET /sitemap.xml` returned
 * the SPA shell with HTTP 200 (nginx `try_files … /index.html`), so anything
 * probing for one got a page of HTML claiming to be a sitemap.
 *
 * Every page appears once per locale, and each entry declares its
 * `xhtml:link` alternates — which is what tells a search engine that
 * /pricing and /nl/pricing are one page in two languages rather than two
 * competing pages.
 */

const { esc } = require('./html');
const { buildPublicPath } = require('./publicPath');

// Homepage first, then the pages a buyer moves through, then the rest.
// Sitemap priority is a weak signal at best, but ordering costs nothing.
const PRIORITY = {
    '': '1.0',
    platform: '0.9',
    sovereignty: '0.9',
    pricing: '0.9',
    // Sits with pricing rather than below it: "is the free version any good"
    // is the question a self-hosting evaluator asks before the price one.
    editions: '0.9',
    // The comparison set. `compare` is the hub every one of them links back to,
    // and the Microsoft page absorbed the three Power Platform pages that used
    // to be listed here.
    compare: '0.8',
    'microsoft-alternative': '0.8',
    'n8n-alternative': '0.8',
    'zapier-alternative': '0.8',
    'make-alternative': '0.7',
    'chatgpt-alternative': '0.8',
    'gemini-alternative': '0.7',
    'claude-alternative': '0.7',
    'langdock-alternative': '0.7',
    'dust-alternative': '0.7',
    'open-webui-alternative': '0.7',
    security: '0.8',
    'self-hosting': '0.8',
    compliance: '0.8',
    'app-studio': '0.8',
    'identity-access': '0.8',
    integrations: '0.7',
};

// Unmapped slugs used to emit no <priority> at all, which is the sitemap-spec
// default (0.5) — but silently, so a new page never showed up in this file's
// diff. Emitting the default explicitly makes the omission visible instead.
const DEFAULT_PRIORITY = '0.5';

function urlEntry({ origin, slug, locale, defaultLocale, locales, lastmod }) {
    const loc = `${origin}${buildPublicPath(locale, slug, defaultLocale)}`;
    const lines = [`  <url>`, `    <loc>${esc(loc)}</loc>`];

    if (locales.length > 1) {
        for (const alt of locales) {
            const href = `${origin}${buildPublicPath(alt, slug, defaultLocale)}`;
            lines.push(`    <xhtml:link rel="alternate" hreflang="${esc(alt)}" href="${esc(href)}"/>`);
        }
        const def = `${origin}${buildPublicPath(defaultLocale, slug, defaultLocale)}`;
        lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${esc(def)}"/>`);
    }

    if (lastmod) lines.push(`    <lastmod>${esc(lastmod)}</lastmod>`);
    const priority = PRIORITY[slug] || DEFAULT_PRIORITY;
    lines.push(`    <priority>${priority}</priority>`);
    lines.push(`  </url>`);
    return lines.join('\n');
}

/**
 * @param {object[]} pages   from the published site:
 *   `{ slug, seo, updatedAt, locales? }`. A page's own `locales` wins over the
 *   site-wide list: a page is only advertised in a language it has actually
 *   been translated into. Listing /nl/<slug> for an untranslated page hands the
 *   crawler an alternate that serves the default language, which invalidates
 *   the whole hreflang cluster rather than just that one URL.
 * @param {object} opts      `{ origin, defaultLocale, locales }`
 */
function buildSitemap(pages, { origin, defaultLocale = 'en', locales = ['en'] }) {
    const entries = [];

    for (const page of pages || []) {
        // A page marked "hide from search engines" must not be advertised in
        // the very file we hand to search engines.
        if (page?.seo?.noIndex) continue;
        if (page?.isNotFound) continue;

        const slug = page.isHomepage ? '' : String(page.slug || '');
        if (!page.isHomepage && !slug) continue;

        const pageLocales = Array.isArray(page.locales) && page.locales.length
            ? page.locales
            : locales;

        const lastmod = page.updatedAt ? String(page.updatedAt).slice(0, 10) : null;
        for (const locale of pageLocales) {
            entries.push(urlEntry({
                origin, slug, locale, defaultLocale, locales: pageLocales, lastmod,
            }));
        }
    }

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        ...entries,
        '</urlset>',
        '',
    ].join('\n');
}

/**
 * robots.txt. Served from here rather than as a static file so it can name
 * the sitemap at the real origin.
 */
function buildRobots({ origin, allow = true }) {
    if (!allow) {
        // Non-production hosts must not be indexed at all.
        return ['User-agent: *', 'Disallow: /', ''].join('\n');
    }
    return [
        'User-agent: *',
        'Allow: /',
        '',
        '# Product surfaces — not content, and behind auth anyway.',
        // Anchored, because `Disallow: /app` is a PREFIX rule: it would also
        // hide any marketing slug that merely starts with those letters
        // (/apps-overzicht, /applicaties) the day someone publishes one.
        'Disallow: /app$',
        'Disallow: /app/',
        'Disallow: /api/',
        '',
        '# Playable demos. They are real UI on fixtures, linked from the',
        '# marketing pages in an iframe; indexed they would be a set of',
        '# near-duplicates carrying the generic app title.',
        'Disallow: /__demo__/',
        'Disallow: /__cms_preview__',
        '',
        '# The CMS preview renders the page with the editor chrome and',
        '# deliberately suppresses its own head tags.',
        'Disallow: /*?preview=',
        '',
        `Sitemap: ${origin}/sitemap.xml`,
        '',
    ].join('\n');
}

/**
 * llms.txt — the same page inventory, addressed to language models.
 *
 * Not a duplicate of the sitemap. An assistant answering "is there a European
 * alternative to Copilot Studio" reads prose and links, not XML, and until now
 * /llms.txt fell through to the SPA and returned the app shell — Lighthouse's
 * agentic-browsing audit reported it as "missing a required H1" and "does not
 * appear to contain any links", which is what a crawler makes of an HTML page
 * pretending to be Markdown.
 *
 * Built from the published snapshot so it cannot drift from what is actually
 * served, and it carries each page's own meta description rather than invented
 * blurbs. Comparison pages are listed under their own heading because they are
 * the ones a model is most likely to be asked to cite.
 */
function buildLlmsTxt(pages, { origin, siteName = 'Bee Flow', summary = '' }) {
    const indexable = (pages || []).filter(p => !p?.seo?.noIndex && !p?.isNotFound);
    const line = (p) => {
        const slug = p.isHomepage ? '' : String(p.slug || '');
        const title = String(p.title || slug || 'Home').trim();
        const desc = String(p?.seo?.metaDescription || '').trim();
        return `- [${title}](${origin}/${slug})${desc ? `: ${desc}` : ''}`;
    };
    const isComparison = p => /-alternative$/.test(String(p.slug || '')) || p.slug === 'compare';

    const out = [`# ${siteName}`, ''];
    if (summary) out.push(summary, '');
    const main = indexable.filter(p => !isComparison(p));
    const comparisons = indexable.filter(isComparison);
    if (main.length) {
        out.push('## Pages', '');
        for (const p of main) out.push(line(p));
        out.push('');
    }
    if (comparisons.length) {
        out.push('## Comparisons', '');
        for (const p of comparisons) out.push(line(p));
        out.push('');
    }
    return out.join('\n');
}

module.exports = { buildSitemap, buildRobots, buildLlmsTxt };
