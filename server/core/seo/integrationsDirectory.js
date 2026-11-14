// @typecheck strict
/**
 * The public integrations directory: a searchable list of what Bee Flow can
 * connect to, and one server-rendered page per integration ("Bee Flow +
 * Nextcloud Calendar", integrationPage.js), both fed from the product's own
 * capability catalogue (core/entitlements/capabilityRegistry) so the website
 * can never promise an integration the product does not ship.
 *
 * Both exist in English and, where the content is written (integrationContent/),
 * in Dutch under /nl/ with hreflang pairs and its own canonical, the way the
 * rest of the public site serves a translation (core/seo/publicPath.js).
 *
 * Pages are self-contained HTML documents (integrationsShell.js): no app shell,
 * no script, so they work under the strict CSP and need no client routing.
 * Search and the category filter are a plain GET form (?q=&category=) answered
 * by the server. Only the STATIC catalogue is used — an org's custom
 * integrations and installed MCP servers are tenant data and never reach a
 * public page. Every string is escaped on the way out.
 */

'use strict';

const { esc } = require('./html');
const content = require('./integrationContent/model.mts');
const shell = require('./integrationsShell');
const { renderDetailPage } = require('./integrationPage');

const { DIRECTORY_SLUG, DETAIL_BASE, detailPath, directoryPath } = shell;
const VENDOR_CATEGORIES = new Set(['Google Workspace', 'Microsoft 365', 'Nextcloud']);
const GENERIC_NAMES = new Set(['Calendar', 'Contacts', 'Drive', 'Docs', 'Sheets', 'Slides', 'Keep']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @typedef {import('./integrationsShell').GalleryItem} GalleryItem
 * @typedef {import('./integrationsShell').SiteCtx} SiteCtx
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

/** @param {string} template @param {Record<string, string | number>} values */
function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(values, k) ? String(values[k]) : m));
}

/**
 * The directory page: search + category filter (GET form) and the matches
 * grouped per category, in the visitor's language. A filtered view is noindex
 * so only the full list ranks.
 * @param {SiteCtx & { items: GalleryItem[], q?: string, category?: string }} ctx
 */
function renderDirectoryPage({ items, q = '', category = '', ...site }) {
    const def = site.defaultLocale || 'en';
    const lang = shell.servedLanguage(null, site.locale || def);
    const ui = content.localeContent(lang).ui;
    const shownItems = items.map(i => shell.localise(i, lang));
    const cats = listCategories(shownItems);
    const known = cats.some(c => c.slug === category) ? category : '';
    const query = String(q).slice(0, 80);
    const shown = filterItems(shownItems, { q: query, category: known });
    const filtered = Boolean(query || known);
    const action = directoryPath(lang, def);
    const options = [`<option value="">${esc(ui.allCategories)}</option>`,
        ...cats.map(c => `<option value="${esc(c.slug)}"${c.slug === known ? ' selected' : ''}>${esc(c.name)} (${c.count})</option>`)].join('');
    const groups = cats
        .map(c => ({ c, rows: shown.filter(i => i.categorySlug === c.slug) }))
        .filter(g => g.rows.length)
        .map(g => `<h2 class="cat">${esc(g.c.name)}</h2><ul class="grid">${g.rows.map(i => shell.card(i, lang, def)).join('')}</ul>`)
        .join('');
    const body = [
        `<h1>${esc(ui.directoryHeading)}</h1>`,
        `<p class="lead">${esc(ui.directoryLead)}</p>`,
        `<form class="filter" role="search" method="get" action="${esc(action)}">`,
        `<label class="sr" for="q">${esc(ui.searchLabel)}</label>`,
        `<input id="q" type="search" name="q" value="${esc(query)}" placeholder="${esc(ui.searchLabel)}" maxlength="80">`,
        `<label class="sr" for="category">${esc(ui.categoryLabel)}</label>`,
        `<select id="category" name="category">${options}</select>`,
        `<button type="submit">${esc(ui.searchButton)}</button>`,
        `</form>`,
        `<p class="lead" role="status">${esc(fill(ui.countLine, { shown: shown.length, total: items.length }))}${filtered ? ` <a href="${esc(action)}">${esc(ui.clearFilters)}</a>` : ''}</p>`,
        groups || `<p>${esc(ui.noMatch)}</p>`,
    ].join('\n');
    const locales = content.pageLocales(null, site.locales || [def], def);
    return shell.page({
        site, lang, title: ui.directoryTitle,
        description: fill(ui.directoryDescription, { count: items.length }),
        path: action, body, noindex: filtered,
        alternates: shell.alternateLinks(site.origin, locales, def, l => directoryPath(l, def)),
        jsonLd: [{
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: ui.directoryTitle,
            inLanguage: lang,
            url: `${site.origin}${action}`,
            hasPart: shownItems.map(i => ({ '@type': 'WebPage', name: `${site.siteName} + ${i.title}`, url: `${site.origin}${detailPath(i.id, lang, def)}` })),
        }],
    });
}

/**
 * Sitemap entries (buildSitemap shape) for the directory and every detail page,
 * each in the site locales it has text in.
 * @param {GalleryItem[]} items
 * @param {{ defaultLocale: string, locales?: string[], lastmod?: string }} opts
 */
function integrationSitemapEntries(items, { defaultLocale, locales = [defaultLocale], lastmod }) {
    return [
        { slug: DIRECTORY_SLUG, seo: {}, updatedAt: lastmod, locales: content.pageLocales(null, locales, defaultLocale) },
        ...items.map(i => ({ slug: `${DETAIL_BASE}/${i.id}`, seo: {}, updatedAt: lastmod, locales: content.pageLocales(i.id, locales, defaultLocale) })),
    ];
}

module.exports = {
    DIRECTORY_SLUG, listGalleryItems, listCategories, filterItems, renderDirectoryPage, renderDetailPage,
    integrationSitemapEntries, detailPath, directoryPath,
};
