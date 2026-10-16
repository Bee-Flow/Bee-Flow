// @typecheck
/**
 * The public integrations directory: a searchable list of what Bee Flow can
 * connect to, and one server-rendered page per integration ("Bee Flow +
 * Nextcloud Calendar"), both fed from the product's own capability catalogue
 * (core/entitlements/capabilityRegistry) so the website can never promise an
 * integration the product does not ship.
 *
 * Pages are self-contained HTML documents: no app shell, no script, so they
 * work under the strict CSP and need no client routing. Search and the
 * category filter are a plain GET form (?q=&category=) answered by the server.
 * Only the STATIC catalogue is used — an org's custom integrations and
 * installed MCP servers are tenant data and never reach a public page.
 * Every string is escaped on the way out.
 */

'use strict';

const { esc, clamp, jsonForScript } = require('./html');

const DIRECTORY_SLUG = 'integrations/directory';
const DETAIL_BASE = 'integrations';
const VENDOR_CATEGORIES = new Set(['Google Workspace', 'Microsoft 365', 'Nextcloud']);
const GENERIC_NAMES = new Set(['Calendar', 'Contacts', 'Drive', 'Docs', 'Sheets', 'Slides', 'Keep']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @typedef {{ id: string, name: string, title: string, description: string, category: string, categorySlug: string }} GalleryItem
 */

/** Names that mean nothing without their vendor ("Calendar"); Nextcloud's apps always carry it. @param {{name: string, category: string}} r */
function needsVendor(r) {
    if (!VENDOR_CATEGORIES.has(r.category)) return false;
    return r.category === 'Nextcloud' || GENERIC_NAMES.has(r.name);
}

/** @param {string} s */
function slugify(s) {
    return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The shipped catalogue as gallery items, in catalogue order.
 * @param {{ INTEGRATION_CATALOG: Array<{id: string, name: string, description: string, category: string}>,
 *           NC_INTEGRATIONS: Array<{id: string, name: string, description: string}> }} [source]
 * @returns {GalleryItem[]}
 */
function listGalleryItems(source) {
    const src = source || {
        INTEGRATION_CATALOG: require('../entitlements/capabilityRegistry').INTEGRATION_CATALOG,
        NC_INTEGRATIONS: require('../../utils/ncIntegrationCatalog').NC_INTEGRATIONS,
    };
    const rows = [
        ...src.INTEGRATION_CATALOG,
        ...src.NC_INTEGRATIONS.map(i => ({ ...i, category: 'Nextcloud' })),
    ];
    return rows
        .filter(r => ID_RE.test(r.id))
        .map(r => ({
            id: r.id,
            name: r.name,
            // "Calendar" alone is ambiguous across vendors; the page title is not.
            title: needsVendor(r) ? `${r.category.split(' ')[0]} ${r.name}` : r.name,
            description: r.description,
            category: r.category,
            categorySlug: slugify(r.category),
        }));
}

/** @param {GalleryItem[]} items */
function listCategories(items) {
    /** @type {Map<string, {slug: string, name: string, count: number}>} */
    const map = new Map();
    for (const i of items) {
        const c = map.get(i.categorySlug) || { slug: i.categorySlug, name: i.category, count: 0 };
        c.count += 1;
        map.set(i.categorySlug, c);
    }
    return [...map.values()];
}

/**
 * Case-insensitive search over name, description and category, plus an exact
 * category filter. Every word of the query must match somewhere.
 * @param {GalleryItem[]} items
 * @param {{ q?: string, category?: string }} filter
 */
function filterItems(items, { q = '', category = '' } = {}) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    return items.filter((i) => {
        if (category && i.categorySlug !== category) return false;
        const hay = `${i.title} ${i.name} ${i.description} ${i.category}`.toLowerCase();
        return words.every(w => hay.includes(w));
    });
}

/** @param {string} id */
function detailPath(id) {
    return `/${DETAIL_BASE}/${id}`;
}

const CSS = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1f; --muted: #5b5b66; --line: #e3e3ea; --accent: #b7791f; }
@media (prefers-color-scheme: dark) { :root { --bg: #131316; --fg: #f2f2f5; --muted: #a2a2ae; --line: #2c2c33; --accent: #f0b84a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: inherit; }
.wrap { max-width: 960px; margin: 0 auto; padding: 0 20px; }
header.site { border-bottom: 1px solid var(--line); padding: 16px 0; }
header.site .wrap { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
header.site a { text-decoration: none; font-weight: 600; }
header.site nav { display: flex; gap: 16px; font-weight: 400; }
main { padding: 48px 0 64px; }
h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); line-height: 1.15; margin: 0 0 12px; }
.lead { color: var(--muted); max-width: 62ch; margin: 0 0 28px; }
.crumbs { font-size: .85rem; color: var(--muted); margin: 0 0 16px; }
form.filter { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 24px; }
form.filter input, form.filter select, form.filter button { font: inherit; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
form.filter input[type=search] { flex: 1 1 240px; }
form.filter button { cursor: pointer; border-color: var(--accent); }
.grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.grid li { border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.grid h3 { margin: 0 0 4px; font-size: 1.05rem; }
.grid p { margin: 0; color: var(--muted); font-size: .92rem; }
.tag { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin: 0 0 6px; }
h2.cat { margin: 32px 0 12px; font-size: 1.2rem; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.btn { display: inline-block; margin-top: 20px; padding: 10px 18px; border: 1px solid var(--accent); border-radius: 8px; text-decoration: none; }
`.trim();

/**
 * @param {object} p
 * @param {string} p.origin
 * @param {string} p.siteName
 * @param {string} p.title
 * @param {string} p.description
 * @param {string} p.path       canonical path
 * @param {string} p.body
 * @param {boolean} [p.noindex]
 * @param {object[]} [p.jsonLd]
 * @param {string} [p.lang]
 * @param {{ integrations?: boolean, blog?: boolean }} [p.nav] which site sections exist; only those are linked
 */
function page({ origin, siteName, title, description, path, body, noindex = false, jsonLd = [], lang = 'en', nav = {} }) {
    const url = `${origin}${path}`;
    const desc = clamp(description, 155);
    const t = esc(`${title} | ${siteName}`);
    return [
        '<!doctype html>',
        `<html lang="${esc(lang)}">`,
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${t}</title>`,
        `<meta name="description" content="${esc(desc)}">`,
        noindex ? '<meta name="robots" content="noindex, follow">' : '',
        `<link rel="canonical" href="${esc(url)}">`,
        `<meta property="og:title" content="${t}">`,
        `<meta property="og:description" content="${esc(desc)}">`,
        `<meta property="og:url" content="${esc(url)}">`,
        '<meta property="og:type" content="website">',
        `<meta property="og:site_name" content="${esc(siteName)}">`,
        `<style>${CSS}</style>`,
        ...jsonLd.map(j => `<script type="application/ld+json">${jsonForScript(j)}</script>`),
        '</head>',
        '<body>',
        `<header class="site"><div class="wrap"><a href="/">${esc(siteName)}</a><nav aria-label="Site">${nav.integrations ? `<a href="/${DETAIL_BASE}">Integrations</a>` : ''}<a href="/${DIRECTORY_SLUG}">Directory</a>${nav.blog ? '<a href="/blog">Blog</a>' : ''}</nav></div></header>`,
        `<main><div class="wrap">${body}</div></main>`,
        '</body>',
        '</html>',
        '',
    ].filter(Boolean).join('\n');
}

/** @param {GalleryItem} i */
function card(i) {
    return `<li><p class="tag">${esc(i.category)}</p><h3><a href="${esc(detailPath(i.id))}">${esc(i.title)}</a></h3><p>${esc(i.description)}</p></li>`;
}

/**
 * The directory page: search + category filter (GET form) and the matches
 * grouped per category. A filtered view is noindex so only the full list ranks.
 * @param {object} ctx { origin, siteName, items, q, category }
 */
function renderDirectoryPage({ origin, siteName, items, q = '', category = '', nav = {} }) {
    const cats = listCategories(items);
    const known = cats.some(c => c.slug === category) ? category : '';
    const query = String(q).slice(0, 80);
    const shown = filterItems(items, { q: query, category: known });
    const filtered = Boolean(query || known);
    const options = [`<option value="">All categories</option>`,
        ...cats.map(c => `<option value="${esc(c.slug)}"${c.slug === known ? ' selected' : ''}>${esc(c.name)} (${c.count})</option>`)].join('');
    const groups = cats
        .map(c => ({ c, rows: shown.filter(i => i.categorySlug === c.slug) }))
        .filter(g => g.rows.length)
        .map(g => `<h2 class="cat">${esc(g.c.name)}</h2><ul class="grid">${g.rows.map(card).join('')}</ul>`)
        .join('');
    const body = [
        `<h1>Integrations</h1>`,
        `<p class="lead">Every integration listed here is shipped in the product, with real tools behind it, and can be switched on per user, per organisation and per group.</p>`,
        `<form class="filter" role="search" method="get" action="/${DIRECTORY_SLUG}">`,
        `<label class="sr" for="q">Search integrations</label>`,
        `<input id="q" type="search" name="q" value="${esc(query)}" placeholder="Search integrations" maxlength="80">`,
        `<label class="sr" for="category">Category</label>`,
        `<select id="category" name="category">${options}</select>`,
        `<button type="submit">Search</button>`,
        `</form>`,
        `<p class="lead" role="status">${shown.length} of ${items.length} integrations${filtered ? ` <a href="/${DIRECTORY_SLUG}">Clear filters</a>` : ''}</p>`,
        groups || '<p>No integration matches. Try a shorter search.</p>',
    ].join('\n');
    const url = `${origin}/${DIRECTORY_SLUG}`;
    return page({
        origin, siteName, title: 'Integrations directory',
        description: `Browse the ${items.length} integrations Bee Flow ships: Google Workspace, Microsoft 365, Nextcloud and more.`,
        path: `/${DIRECTORY_SLUG}`, body, noindex: filtered, nav,
        jsonLd: [{
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: 'Integrations directory',
            url,
            hasPart: items.map(i => ({ '@type': 'WebPage', name: `${siteName} + ${i.title}`, url: `${origin}${detailPath(i.id)}` })),
        }],
    });
}

/**
 * One integration's page.
 * @param {object} ctx { origin, siteName, item, related }
 */
function renderDetailPage({ origin, siteName, item, related = [], nav = {} }) {
    const heading = `${siteName} + ${item.title}`;
    const sibs = related.filter(r => r.id !== item.id && r.categorySlug === item.categorySlug).slice(0, 6);
    const body = [
        `<p class="crumbs">${nav.integrations ? `<a href="/${DETAIL_BASE}">Integrations</a> / ` : ''}<a href="/${DIRECTORY_SLUG}?category=${esc(encodeURIComponent(item.categorySlug))}">${esc(item.category)}</a></p>`,
        `<h1>${esc(heading)}</h1>`,
        `<p class="lead">${esc(item.description)}.</p>`,
        `<p>${esc(item.title)} is part of the ${esc(item.category)} integrations. Agents and automations call its tools only for the people and groups an administrator has switched it on for.</p>`,
        sibs.length ? `<h2 class="cat">More in ${esc(item.category)}</h2><ul class="grid">${sibs.map(card).join('')}</ul>` : '',
        `<a class="btn" href="/${DIRECTORY_SLUG}">Browse all integrations</a>`,
    ].join('\n');
    return page({
        origin, siteName, title: heading,
        description: `${item.description}. Connect ${item.title} to ${siteName}, self-hosted and gated per user, organisation and group.`,
        path: detailPath(item.id), body, nav,
        jsonLd: [{
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: heading,
            url: `${origin}${detailPath(item.id)}`,
            breadcrumb: {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Integrations directory', item: `${origin}/${DIRECTORY_SLUG}` },
                    { '@type': 'ListItem', position: 2, name: item.title, item: `${origin}${detailPath(item.id)}` },
                ],
            },
        }],
    });
}

/** Sitemap entries (buildSitemap shape) for the directory and every detail page. */
function integrationSitemapEntries(items, { defaultLocale, lastmod }) {
    return [DIRECTORY_SLUG, ...items.map(i => `${DETAIL_BASE}/${i.id}`)]
        .map(slug => ({ slug, seo: {}, updatedAt: lastmod, locales: [defaultLocale] }));
}

module.exports = {
    DIRECTORY_SLUG, listGalleryItems, listCategories, filterItems, renderDirectoryPage, renderDetailPage,
    integrationSitemapEntries, detailPath,
};
