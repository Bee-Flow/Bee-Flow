// @typecheck strict
/**
 * One public integration page (/integrations/<id>, /nl/integrations/<id>).
 *
 * With written content (integrationContent/) the page says what the
 * integration is, what an assistant can do with it (each line with the shipped
 * tool names and whether it reads, changes or sends), which events can start an
 * automation, how it is connected, read or write, its limits and examples, and
 * links to related integrations and the site's overview, deployment and plans
 * pages. Every list comes from the shipped catalogues the caller hands in
 * (integrationContent/model.mts), never from the prose. Without written content
 * the page keeps the catalogue line. Every string is escaped on the way out.
 */

'use strict';

const { esc } = require('./html');
const content = require('./integrationContent/model.mts');
const shell = require('./integrationsShell');

/**
 * @typedef {import('./integrationsShell').GalleryItem} GalleryItem
 * @typedef {import('./integrationsShell').SiteCtx} SiteCtx
 * @typedef {import('./integrationContent/model.mts').Ui} Ui
 * @typedef {import('./integrationContent/model.mts').Catalog} Catalog
 * @typedef {import('./integrationContent/model.mts').PageModel} PageModel
 */

/** @param {string[]} tools */
function toolList(tools) {
    return tools.map(t => `<code>${esc(t)}</code>`).join(', ');
}

/** @param {PageModel} model @param {Ui} ui */
function renderCapabilities(model, ui) {
    const lines = model.lines.map(l => `<li>${esc(l.text)}${l.effect ? `<span class="fx">${esc(ui.effect[l.effect])}</span>` : ''}`
        + `<p class="tools">${esc(ui.toolsLabel)}: ${toolList(l.tools)}</p></li>`);
    return [
        `<h2 class="sec">${esc(ui.canDo)}</h2>`,
        lines.length ? `<ul class="lines">${lines.join('')}</ul>` : '',
        model.otherTools.length ? `<p class="tools">${esc(ui.otherTools)}: ${toolList(model.otherTools)}</p>` : '',
    ];
}

/** @param {PageModel} model @param {Ui} ui */
function renderEvents(model, ui) {
    const events = model.events || [];
    if (!events.length) return [`<h2 class="sec">${esc(ui.events)}</h2>`, `<p>${esc(ui.eventsNone)}</p>`];
    return [
        `<h2 class="sec">${esc(ui.events)}</h2>`,
        `<ul class="lines">${events.map(e => `<li>${esc(e.label)}${e.viaConnector ? ' *' : ''}</li>`).join('')}</ul>`,
        events.some(e => e.viaConnector) ? `<p class="tools">${esc(ui.eventsConnector)}</p>` : '',
        model.eventsNeedPublicUrl ? `<p class="tools">${esc(ui.eventsPublicUrl)}</p>` : '',
    ];
}

/** @param {string[] | readonly string[]} items */
function bullets(items) {
    return `<ul class="lines">${items.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
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
        bullets(p.limits),
        p.examples?.length ? `<h2 class="sec">${esc(ui.examples)}</h2>${bullets(p.examples)}` : '',
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
    /** @type {Array<[string | null, string]>} */
    const links = [
        [shell.sitePath(nav, 'integrations', lang, def), ui.overview],
        [shell.directoryPath(lang, def), ui.browseAll],
        [shell.sitePath(nav, 'deployment', lang, def), ui.deployment],
        [shell.sitePath(nav, 'plans', lang, def), ui.plans],
    ];
    return `<p class="links">${links.filter(([href]) => href).map(([href, text]) => `<a class="btn" href="${esc(String(href))}">${esc(text)}</a>`).join('')}</p>`;
}

/** @param {SiteCtx} site @param {GalleryItem} shown the item as the page's language shows it @param {string} lang */
function crumbs(site, shown, lang) {
    const ui = content.localeContent(lang).ui;
    const def = site.defaultLocale || 'en';
    const integrations = shell.sitePath(site.nav || {}, 'integrations', lang, def);
    const dirHref = `${shell.directoryPath(lang, def)}?category=${encodeURIComponent(shown.categorySlug)}`;
    return `<p class="crumbs">${integrations ? `<a href="${esc(integrations)}">${esc(ui.navIntegrations)}</a> / ` : ''}<a href="${esc(dirHref)}">${esc(shown.category)}</a></p>`;
}

/**
 * The body of a page with written content.
 * @param {{ site: SiteCtx, item: GalleryItem, model: PageModel, related: GalleryItem[], lang: string, heading: string }} p
 */
function contentBody({ site, item, model, related, lang, heading }) {
    const ui = content.localeContent(lang).ui;
    const def = site.defaultLocale || 'en';
    const rel = relatedItems(item, related, model.related).map(r => shell.localise(r, lang));
    return [
        crumbs(site, shell.localise(item, lang), lang),
        `<h1>${esc(heading)}</h1>`,
        `<p class="lead">${esc(model.prose.summary)}</p>`,
        ...model.prose.intro.map(s => `<p class="prose">${esc(s)}</p>`),
        ...renderCapabilities(model, ui),
        ...renderEvents(model, ui),
        ...renderAbout(model, ui),
        rel.length ? `<h2 class="sec">${esc(ui.related)}</h2><ul class="grid">${rel.map(r => shell.card(r, lang, def)).join('')}</ul>` : '',
        siteLinks(site, ui, lang),
    ].filter(Boolean).join('\n');
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
        sibs.length ? `<h2 class="cat">More in ${esc(item.category)}</h2><ul class="grid">${sibs.map(i => shell.card(i)).join('')}</ul>` : '',
        `<a class="btn" href="/${shell.DIRECTORY_SLUG}">Browse all integrations</a>`,
    ].join('\n');
}

/**
 * One integration's page, in `locale` when it has text in that language.
 * @param {SiteCtx & { item: GalleryItem, related?: GalleryItem[], catalog?: Catalog }} ctx
 *   `catalog`: the shipped toolsets, trigger sources and effect map (routes/publicIntegrationsRender.integrationCatalog)
 */
function renderDetailPage({ item, related = [], catalog, ...site }) {
    const def = site.defaultLocale || 'en';
    const lang = shell.servedLanguage(item.id, site.locale || def);
    const model = catalog ? content.buildPageModel(item.id, lang, catalog) : null;
    const prose = content.proseFor(item.id, lang);
    const name = prose?.name || item.title;
    const heading = `${site.siteName} + ${name}`;
    const path = shell.detailPath(item.id, lang, def);
    const locales = content.pageLocales(item.id, site.locales || [def], def);
    return shell.page({
        site, lang, path,
        body: model ? contentBody({ site, item, model, related, lang, heading }) : catalogueBody(site, item, related, heading),
        title: prose ? prose.title : heading,
        description: prose ? prose.description : `${item.description}. Connect ${item.title} to ${site.siteName}, self-hosted and gated per user, organisation and group.`,
        alternates: prose ? shell.alternateLinks(site.origin, locales, def, l => shell.detailPath(item.id, l, def)) : [],
        jsonLd: [{
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: heading,
            inLanguage: lang,
            url: `${site.origin}${path}`,
            breadcrumb: {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: content.localeContent(lang).ui.breadcrumbDirectory, item: `${site.origin}${shell.directoryPath(lang, def)}` },
                    { '@type': 'ListItem', position: 2, name, item: `${site.origin}${path}` },
                ],
            },
        }],
    });
}

module.exports = { renderDetailPage };
