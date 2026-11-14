// @typecheck strict
/**
 * The document every public integrations page is rendered into
 * (integrationsDirectory.js for the directory, integrationPage.js for one
 * integration): head with canonical, hreflang and og tags, the inline style,
 * the site header, and the paths and cards both page kinds share.
 *
 * Self-contained HTML, no script but JSON-LD, so the pages work under the
 * strict CSP. Every string is escaped on the way out.
 */

'use strict';

const { esc, clamp, clampTitle, jsonForScript } = require('./html');
const { buildPublicPath } = require('./publicPath');
const content = require('./integrationContent/model.mts');

const DIRECTORY_SLUG = 'integrations/directory';
const DETAIL_BASE = 'integrations';
const TITLE_MAX = 58;

/**
 * @typedef {{ id: string, name: string, title: string, description: string, category: string, categorySlug: string }} GalleryItem
 * @typedef {import('./integrationContent/model.mts').Ui} Ui
 * @typedef {Record<string, boolean | string[] | undefined>} Nav
 *   per site page (`integrations`, `deployment`, `plans`, `blog`): absent = not on the site,
 *   true = on the site, a list = the locales it is published in
 * @typedef {{ origin: string, siteName: string, locale?: string, defaultLocale?: string, locales?: string[], nav?: Nav }} SiteCtx
 */

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

/** The language a page is written in: the one asked for when it has text in it, else English. @param {string | null} id @param {string} locale */
function servedLanguage(id, locale) {
    return content.hasPageIn(id, locale) ? locale : 'en';
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
 *   noindex?: boolean, jsonLd?: Array<Record<string, unknown>>, alternates?: string[] }} p `path`: canonical path; `lang`: the language served
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

/** @param {GalleryItem} i @param {string} [locale] @param {string} [defaultLocale] */
function card(i, locale = 'en', defaultLocale = 'en') {
    return `<li><p class="tag">${esc(i.category)}</p><h3><a href="${esc(detailPath(i.id, locale, defaultLocale))}">${esc(i.title)}</a></h3><p>${esc(i.description)}</p></li>`;
}

module.exports = {
    DIRECTORY_SLUG, DETAIL_BASE, detailPath, directoryPath, sitePath, localise, servedLanguage, alternateLinks, page, card,
};
