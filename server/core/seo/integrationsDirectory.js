// @typecheck strict
/**
 * The public integrations directory: a searchable list of what Bee Flow can
 * connect to, and one server-rendered page per integration ("Bee Flow +
 * Nextcloud Calendar"), both fed from the product's own capability catalogue
 * (core/entitlements/capabilityRegistry) so the website can never promise an
 * integration the product does not ship.
 *
 * A page with written content (integrationContent/, English and Dutch) says
 * what the integration is, what an assistant can do with it, which events can
 * start an automation, how it is connected and what its limits are. The tool
 * and event lists on it come from the shipped catalogues at render time
 * (integrationContent/model.mts), never from the prose. Dutch is served under
 * /nl/ with hreflang pairs and its own canonical, the way the rest of the
 * public site serves a translation (core/seo/publicPath.js).
 *
 * Pages are self-contained HTML documents: no app shell, no script, so they
 * work under the strict CSP and need no client routing. Search and the
 * category filter are a plain GET form (?q=&category=) answered by the server.
 * Only the STATIC catalogue is used — an org's custom integrations and
 * installed MCP servers are tenant data and never reach a public page.
 * Every string is escaped on the way out.
 */

'use strict';

const { esc, clamp, clampTitle, jsonForScript } = require('./html');
const { buildPublicPath } = require('./publicPath');
const content = require('./integrationContent/model.mts');

const DIRECTORY_SLUG = 'integrations/directory';
const DETAIL_BASE = 'integrations';
const VENDOR_CATEGORIES = new Set(['Google Workspace', 'Microsoft 365', 'Nextcloud']);
const GENERIC_NAMES = new Set(['Calendar', 'Contacts', 'Drive', 'Docs', 'Sheets', 'Slides', 'Keep']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TITLE_MAX = 58;

/**
 * @typedef {{ id: string, name: string, title: string, description: string, category: string, categorySlug: string }} GalleryItem
 * @typedef {import('./integrationContent/model.mts').Ui} Ui
 * @typedef {import('./integrationContent/model.mts').Catalog} Catalog
 * @typedef {import('./integrationContent/model.mts').PageModel} PageModel
 * @typedef {Record<string, boolean | string[] | undefined>} Nav
 *   per site page (`integrations`, `deployment`, `plans`, `blog`): absent = not on the site,
 *   true = on the site, a list = the locales it is published in
 * @typedef {{ origin: string, siteName: string, locale?: string, defaultLocale?: string, locales?: string[], nav?: Nav }} SiteCtx
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

/** @param {string} id @param {string} [locale] @param {string} [defaultLocale] */
function detailPath(id, locale = 'en', defaultLocale = 'en') {
    return buildPublicPath(locale, `${DETAIL_BASE}/${id}`, defaultLocale);
}

/** @param {string} locale @param {string} defaultLocale */
function directoryPath(locale, defaultLocale) {
    return buildPublicPath(locale, DIRECTORY_SLUG, defaultLocale);
}

/**
 * The address of a site page in this language: the translated one when the page
 * is published in it, else the default one; null when the site has no such page.
 * @param {Nav} nav @param {string} slug @param {string} locale @param {string} defaultLocale
 */
function sitePath(nav, slug, locale, defaultLocale) {
    const has = nav[slug];
    if (!has) return null;
    const translated = Array.isArray(has) && has.includes(locale);
    return buildPublicPath(translated ? locale : defaultLocale, slug, defaultLocale);
}

/**
 * The item as one language shows it: its written name and card line, the category's name.
 * @param {GalleryItem} item @param {string} locale
 * @returns {GalleryItem}
 */
function localise(item, locale) {
    const words = content.localeContent(locale);
    const prose = content.proseFor(item.id, locale);
    const category = Object.hasOwn(words.categories, item.category) ? words.categories[item.category] : item.category;
    return { ...item, title: prose?.name || item.title, description: prose?.summary || item.description, category };
}

/** @param {string} template @param {Record<string, string | number>} values */
function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(values, k) ? String(values[k]) : m));
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
h2.sec { margin: 36px 0 10px; font-size: 1.25rem; }
.lead { color: var(--muted); max-width: 62ch; margin: 0 0 28px; }
.prose { max-width: 68ch; }
.crumbs { font-size: .85rem; color: var(--muted); margin: 0 0 16px; }
form.filter { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 24px; }
form.filter input, form.filter select, form.filter button { font: inherit; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
form.filter input[type=search] { flex: 1 1 240px; }
form.filter button { cursor: pointer; border-color: var(--accent); }
.grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.grid li { border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
.grid h3 { margin: 0 0 4px; font-size: 1.05rem; }
.grid p { margin: 0; color: var(--muted); font-size: .92rem; }
ul.lines { padding-left: 1.2em; max-width: 72ch; }
ul.lines li { margin: 0 0 12px; }
.tools { margin: 4px 0 0; font-size: .85rem; color: var(--muted); overflow-wrap: anywhere; }
code { font: .85em ui-monospace, SFMono-Regular, Menlo, monospace; }
.fx { font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; border: 1px solid var(--line); border-radius: 6px; padding: 0 6px; margin-left: 6px; color: var(--muted); white-space: nowrap; }
.tag { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin: 0 0 6px; }
h2.cat { margin: 32px 0 12px; font-size: 1.2rem; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.btn { display: inline-block; margin-top: 20px; padding: 10px 18px; border: 1px solid var(--accent); border-radius: 8px; text-decoration: none; }
.links { display: flex; gap: 12px; flex-wrap: wrap; }
`.trim();

/**
 * hreflang links for a page published in `locales` (nothing for a single language).
 * @param {string} origin @param {string[]} locales @param {string} defaultLocale @param {(locale: string) => string} pathIn
 */
function alternateLinks(origin, locales, defaultLocale, pathIn) {
    if (locales.length < 2) return [];
    return [
        ...locales.map(l => `<link rel="alternate" hreflang="${esc(l)}" href="${esc(`${origin}${pathIn(l)}`)}">`),
        `<link rel="alternate" hreflang="x-default" href="${esc(`${origin}${pathIn(defaultLocale)}`)}">`,
    ];
}

/** @param {SiteCtx} site @param {Ui} ui @param {string} locale */
function siteHeader(site, ui, locale) {
    const nav = site.nav || {};
    const def = site.defaultLocale || 'en';
    const integrations = sitePath(nav, 'integrations', locale, def);
    const blog = nav.blog ? buildPublicPath(locale, 'blog', def) : null;
    return `<header class="site"><div class="wrap"><a href="${esc(buildPublicPath(locale, '', def))}">${esc(site.siteName)}</a><nav aria-label="Site">`
        + (integrations ? `<a href="${esc(integrations)}">${esc(ui.navIntegrations)}</a>` : '')
        + `<a href="${esc(directoryPath(locale, def))}">${esc(ui.navDirectory)}</a>`
        + (blog ? `<a href="${esc(blog)}">${esc(ui.navBlog)}</a>` : '')
        + '</nav></div></header>';
}

/**
 * @param {{ site: SiteCtx, lang: string, title: string, description: string, path: string, body: string,
 *   noindex?: boolean, jsonLd?: any[], alternates?: string[] }} p `path`: canonical path; `lang`: the language served
 */
function page({ site, lang, title, description, path, body, noindex = false, jsonLd = [], alternates = [] }) {
    const { origin, siteName } = site;
    const url = `${origin}${path}`;
    const desc = clamp(description, 155);
    const t = esc(clampTitle(`${title} | ${siteName}`, TITLE_MAX, siteName));
    const ui = content.localeContent(lang).ui;
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
        ...alternates,
        `<meta property="og:title" content="${t}">`,
        `<meta property="og:description" content="${esc(desc)}">`,
        `<meta property="og:url" content="${esc(url)}">`,
        '<meta property="og:type" content="website">',
        `<meta property="og:site_name" content="${esc(siteName)}">`,
        `<meta property="og:locale" content="${esc(lang)}">`,
        `<style>${CSS}</style>`,
        ...jsonLd.map(j => `<script type="application/ld+json">${jsonForScript(j)}</script>`),
        '</head>',
        '<body>',
        siteHeader(site, ui, lang),
        `<main><div class="wrap">${body}</div></main>`,
        '</body>',
        '</html>',
        '',
    ].filter(Boolean).join('\n');
}

/** @param {GalleryItem} i @param {string} locale @param {string} defaultLocale */
function card(i, locale = 'en', defaultLocale = 'en') {
    return `<li><p class="tag">${esc(i.category)}</p><h3><a href="${esc(detailPath(i.id, locale, defaultLocale))}">${esc(i.title)}</a></h3><p>${esc(i.description)}</p></li>`;
}

/** The language a page is written in: the one asked for when it has text in it, else English. @param {string | null} id @param {string} locale */
function servedLanguage(id, locale) {
    return content.hasPageIn(id, locale) ? locale : 'en';
}

/**
 * The directory page: search + category filter (GET form) and the matches
 * grouped per category. A filtered view is noindex so only the full list ranks.
 * @param {SiteCtx & { items: GalleryItem[], q?: string, category?: string }} ctx
 */
function renderDirectoryPage({ items, q = '', category = '', ...site }) {
    const def = site.defaultLocale || 'en';
    const lang = servedLanguage(null, site.locale || def);
    const ui = content.localeContent(lang).ui;
    const shownItems = items.map(i => localise(i, lang));
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
        .map(g => `<h2 class="cat">${esc(g.c.name)}</h2><ul class="grid">${g.rows.map(i => card(i, lang, def)).join('')}</ul>`)
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
    return page({
        site, lang, title: ui.directoryTitle,
        description: fill(ui.directoryDescription, { count: items.length }),
        path: action, body, noindex: filtered,
        alternates: alternateLinks(site.origin, locales, def, l => directoryPath(l, def)),
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

/** @param {PageModel} model @param {Ui} ui */
function renderCapabilities(model, ui) {
    const lines = model.lines.map(l => `<li>${esc(l.text)}${l.effect ? `<span class="fx">${esc(ui.effect[l.effect])}</span>` : ''}`
        + `<p class="tools">${esc(ui.toolsLabel)}: ${l.tools.map(t => `<code>${esc(t)}</code>`).join(', ')}</p></li>`);
    return [
        `<h2 class="sec">${esc(ui.canDo)}</h2>`,
        lines.length ? `<ul class="lines">${lines.join('')}</ul>` : '',
        model.otherTools.length ? `<p class="tools">${esc(ui.otherTools)}: ${model.otherTools.map(t => `<code>${esc(t)}</code>`).join(', ')}</p>` : '',
    ];
}

/** @param {PageModel} model @param {Ui} ui */
function renderEvents(model, ui) {
    const events = model.events || [];
    if (!events.length) return [`<h2 class="sec">${esc(ui.events)}</h2>`, `<p>${esc(ui.eventsNone)}</p>`];
    const anyConnector = events.some(e => e.viaConnector);
    return [
        `<h2 class="sec">${esc(ui.events)}</h2>`,
        `<ul class="lines">${events.map(e => `<li>${esc(e.label)}${e.viaConnector ? ' *' : ''}</li>`).join('')}</ul>`,
        anyConnector ? `<p class="tools">${esc(ui.eventsConnector)}</p>` : '',
        model.eventsNeedPublicUrl ? `<p class="tools">${esc(ui.eventsPublicUrl)}</p>` : '',
    ];
}

/** @param {PageModel} model @param {Ui} ui */
function renderAbout(model, ui) {
    const p = model.prose;
    return [
        model.access ? `<h2 class="sec">${esc(ui.access)}</h2><p class="prose">${esc(ui.accessText[model.access])}</p>` : '',
        `<h2 class="sec">${esc(ui.connect)}</h2>`,
        ...p.connect.map(s => `<p class="prose">${esc(s)}</p>`),
        `<p class="prose">${esc(ui.gate)}</p>`,
        `<h2 class="sec">${esc(ui.limits)}</h2>`,
        `<ul class="lines">${p.limits.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`,
        p.examples?.length ? `<h2 class="sec">${esc(ui.examples)}</h2><ul class="lines">${p.examples.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : '',
    ];
}

/**
 * The related integrations: the ones the content names first, then the item's category siblings.
 * @param {GalleryItem} item @param {GalleryItem[]} all @param {string[]} named
 */
function relatedItems(item, all, named) {
    const byId = new Map(all.map(i => [i.id, i]));
    const first = named.map(id => byId.get(id)).filter(/** @returns {i is GalleryItem} */ i => Boolean(i));
    const siblings = all.filter(r => r.categorySlug === item.categorySlug);
    const seen = new Set([item.id]);
    return [...first, ...siblings].filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true))).slice(0, 6);
}

/** @param {SiteCtx} site @param {Ui} ui @param {string} lang */
function siteLinks(site, ui, lang) {
    const nav = site.nav || {};
    const def = site.defaultLocale || 'en';
    const links = [
        [sitePath(nav, 'integrations', lang, def), ui.overview],
        [directoryPath(lang, def), ui.browseAll],
        [sitePath(nav, 'deployment', lang, def), ui.deployment],
        [sitePath(nav, 'plans', lang, def), ui.plans],
    ].filter(([href]) => href);
    return `<p class="links">${links.map(([href, text]) => `<a class="btn" href="${esc(String(href))}">${esc(String(text))}</a>`).join('')}</p>`;
}

/**
 * The body of a page with written content.
 * @param {{ site: SiteCtx, item: GalleryItem, model: PageModel, related: GalleryItem[], lang: string, heading: string }} p
 */
function contentBody({ site, item, model, related, lang, heading }) {
    const ui = content.localeContent(lang).ui;
    const def = site.defaultLocale || 'en';
    const shown = localise(item, lang);
    const rel = relatedItems(item, related, model.related).map(r => localise(r, lang));
    return [
        crumbs(site, shown, lang),
        `<h1>${esc(heading)}</h1>`,
        `<p class="lead">${esc(model.prose.summary)}</p>`,
        ...model.prose.intro.map(s => `<p class="prose">${esc(s)}</p>`),
        ...renderCapabilities(model, ui),
        ...renderEvents(model, ui),
        ...renderAbout(model, ui),
        rel.length ? `<h2 class="sec">${esc(ui.related)}</h2><ul class="grid">${rel.map(r => card(r, lang, def)).join('')}</ul>` : '',
        siteLinks(site, ui, lang),
    ].filter(Boolean).join('\n');
}

/** @param {SiteCtx} site @param {GalleryItem} shown the item as the page's language shows it @param {string} lang */
function crumbs(site, shown, lang) {
    const ui = content.localeContent(lang).ui;
    const def = site.defaultLocale || 'en';
    const integrations = sitePath(site.nav || {}, 'integrations', lang, def);
    const dirHref = `${directoryPath(lang, def)}?category=${encodeURIComponent(shown.categorySlug)}`;
    return `<p class="crumbs">${integrations ? `<a href="${esc(integrations)}">${esc(ui.navIntegrations)}</a> / ` : ''}<a href="${esc(dirHref)}">${esc(shown.category)}</a></p>`;
}

/**
 * The body of a page without written content: the catalogue line, as before.
 * @param {SiteCtx} site @param {GalleryItem} item @param {GalleryItem[]} related @param {string} heading
 */
function catalogueBody(site, item, related, heading) {
    const sibs = related.filter(r => r.id !== item.id && r.categorySlug === item.categorySlug).slice(0, 6);
    return [
        crumbs(site, item, 'en'),
        `<h1>${esc(heading)}</h1>`,
        `<p class="lead">${esc(item.description)}.</p>`,
        `<p>${esc(item.title)} is part of the ${esc(item.category)} integrations. Agents and automations call its tools only for the people and groups an administrator has switched it on for.</p>`,
        sibs.length ? `<h2 class="cat">More in ${esc(item.category)}</h2><ul class="grid">${sibs.map(i => card(i)).join('')}</ul>` : '',
        `<a class="btn" href="/${DIRECTORY_SLUG}">Browse all integrations</a>`,
    ].join('\n');
}

/**
 * One integration's page, in `locale` when it has text in that language.
 * @param {SiteCtx & { item: GalleryItem, related?: GalleryItem[], catalog?: Catalog }} ctx
 *   `catalog`: the shipped toolsets, trigger sources and effect map (routes/publicIntegrationsRender.integrationCatalog)
 */
function renderDetailPage({ item, related = [], catalog, ...site }) {
    const def = site.defaultLocale || 'en';
    const lang = servedLanguage(item.id, site.locale || def);
    const model = catalog ? content.buildPageModel(item.id, lang, catalog) : null;
    const prose = content.proseFor(item.id, lang);
    const heading = `${site.siteName} + ${prose?.name || item.title}`;
    const path = detailPath(item.id, lang, def);
    const body = model
        ? contentBody({ site, item, model, related, lang, heading })
        : catalogueBody(site, item, related, heading);
    const locales = content.pageLocales(item.id, site.locales || [def], def);
    const ui = content.localeContent(lang).ui;
    return page({
        site, lang, path, body,
        title: prose ? prose.title : heading,
        description: prose ? prose.description : `${item.description}. Connect ${item.title} to ${site.siteName}, self-hosted and gated per user, organisation and group.`,
        alternates: prose ? alternateLinks(site.origin, locales, def, l => detailPath(item.id, l, def)) : [],
        jsonLd: [{
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: heading,
            inLanguage: lang,
            url: `${site.origin}${path}`,
            breadcrumb: {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: ui.breadcrumbDirectory, item: `${site.origin}${directoryPath(lang, def)}` },
                    { '@type': 'ListItem', position: 2, name: prose?.name || item.title, item: `${site.origin}${path}` },
                ],
            },
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
