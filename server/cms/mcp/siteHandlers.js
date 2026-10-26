// @typecheck strict
'use strict';
/**
 * The site-level CMS-over-MCP tools (./dispatch.js maps tool names to them):
 * sites and templates, page deletion, site settings (header, footer, cookie
 * banner, announcement, analytics id) and the per-locale overrides.
 */

/**
 * @typedef {import('./handlerKit').ToolArgs} ToolArgs
 * @typedef {import('./handlerKit').McpCtx} McpCtx
 * @typedef {import('./handlerKit').HandlerKit} HandlerKit
 * @typedef {Record<string, any>} PageEntry  one page of a site as the store lists it
 */

const { err, isPlainObject } = require('./handlerKit');
const { LOCALE_PREFIXES } = require('../../core/seo/publicPath');
const { mediaWarningFor } = require('../../stores/cms/localeMedia');

const SETTING_SECTIONS = ['header', 'footer', 'cookieBanner', 'announcement'];
const SETTINGS_PATCH_MAX_CHARS = 100_000;
const OVERRIDE_MAX_CHARS = 200_000;

/**
 * The renderer reads a block translation from `blocks[id].content` only
 * (stores/cms/effective.js), so anything else would save fine and then
 * silently show the default language. Reject it up front instead.
 * @param {unknown} blocks
 */
function blockOverrideShapeError(blocks) {
    if (blocks === undefined) return null;
    if (!isPlainObject(blocks)) return 'override.blocks must be an object keyed by block id.';
    for (const [blockId, ov] of Object.entries(blocks)) {
        const label = blockId.slice(0, 60);
        if (!isPlainObject(ov) || !isPlainObject(ov.content)) return `override.blocks["${label}"] has no content object.`;
        const extra = Object.keys(ov).filter((k) => k !== 'content' && k !== '_orphans');
        if (extra.length) return `override.blocks["${label}"] has keys outside content (${extra.slice(0, 5).join(', ')}).`;
    }
    return null;
}

/**
 * Sites, templates, page deletion and the site settings.
 * @param {HandlerKit} kit
 */
function createSiteHandlers({ deps, cmsStore, live, resolveSite, loadDraft, validationOf }) {
    async function listSites() {
        const [sites, liveSiteId] = await Promise.all([cmsStore.listProjects(), live.getLiveSiteId()]);
        return { result: { liveSiteId, sites: sites.map((/** @type {Record<string, any>} */ s) => ({ ...s, live: s.id === liveSiteId })) } };
    }

    /** @param {ToolArgs} args */
    async function duplicateSite(args) {
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const created = await cmsStore.duplicateProject(site.siteId);
        return { result: { ...created, copiedFrom: site.siteId, note: 'A new draft version. It is not live; pass its id as siteId to work on it.' } };
    }

    async function listTemplates() {
        const templates = await cmsStore.getTemplates();
        return {
            result: {
                templates: templates.map((/** @type {Record<string, any>} */ t) => ({
                    id: t.id, name: t.name, description: t.description || '', createdAt: t.createdAt,
                    blockCount: Array.isArray(t.blocks) ? t.blocks.length : 0,
                    ...(t.builtin ? { builtin: true } : {}),
                })),
            },
        };
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function deletePage(args, ctx) {
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const pageId = String(args.pageId || '');
        const entry = site.project.pages.find((/** @type {PageEntry} */ p) => p.id === pageId);
        if (!entry) return err(`Page "${pageId.slice(0, 60)}" is not in this site.`, { _fixHint: `Known page ids: ${site.project.pages.map((/** @type {PageEntry} */ p) => `${p.id} (${p.slug})`).join(', ') || 'none'}.` });
        const redirectTo = typeof args.redirectTo === 'string' ? args.redirectTo.trim() : '';
        const wasHomepage = site.project.homepageId === pageId;
        const outcome = await cmsStore.removePage(site.siteId, pageId);
        if (!outcome) return err(`Page "${pageId.slice(0, 60)}" is not in this site.`);
        // The deleted address may lead somewhere (301); the homepage's address is "/", which has no redirect.
        const made = redirectTo && !wasHomepage ? await cmsStore.redirectDeletedPage(site.siteId, entry.slug, redirectTo) : null;
        const validation = validationOf(await loadDraft(site.siteId, ctx));
        return {
            result: {
                siteId: site.siteId,
                deleted: { id: pageId, slug: entry.slug },
                ...(outcome.newHomepage ? { newHomepage: outcome.newHomepage } : {}),
                ...(outcome.neutralisedLinks ? { neutralisedLinks: outcome.neutralisedLinks } : {}),
                ...(made && made.entry ? { redirect: made.entry } : {}),
                ...(made && made.error ? { redirectError: `The page is deleted, but no redirect was made: ${made.error}` } : {}),
                ...(validation ? { validation } : {}),
            },
        };
    }

    /** @param {ToolArgs} args */
    async function getSiteSettings(args) {
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const wanted = Array.isArray(args.sections) && args.sections.length
            ? args.sections.filter((/** @type {string} */ s) => [...SETTING_SECTIONS, 'analytics'].includes(s))
            : [...SETTING_SECTIONS, 'analytics'];
        /** @type {Record<string, any>} */
        const out = { siteId: site.siteId, name: site.project.name, defaultLocale: await cmsStore.getDefaultLocale() };
        for (const key of wanted) out[key] = site.project[key] ?? null;
        return { result: out };
    }

    /**
     * @param {ToolArgs} args
     * @param {McpCtx} ctx
     */
    async function updateSiteSettings(args, ctx) {
        const known = new Set(['siteId', 'name', 'analytics', ...SETTING_SECTIONS]);
        const unknown = Object.keys(args).filter((k) => !known.has(k));
        if (unknown.length) {
            return err(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, {
                _fixHint: `Send any of: name, ${SETTING_SECTIONS.join(', ')}, analytics. The header menu is cms_update_header_nav; page SEO is cms_update_page_seo; colours and fonts are cms_update_design.`,
            });
        }
        const sent = ['name', 'analytics', ...SETTING_SECTIONS].filter((k) => args[k] !== undefined);
        if (!sent.length) return err('Nothing to change.', { _fixHint: `Pass at least one of: name, ${SETTING_SECTIONS.join(', ')}, analytics.` });

        const found = await resolveSite(args);
        if (found.error || !found.siteId) return err(found.error ?? 'No site was resolved.');
        // What to change, validated first and applied below to the SiteDoc as stored then.
        /** @type {Record<string, any>} */
        const sectionPatches = {};
        /** @type {string | undefined} */
        let newName;
        /** @type {Record<string, any> | undefined} */
        let newAnalytics;

        if (args.name !== undefined) {
            if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200) {
                return err('name must be text of 1-200 characters.');
            }
            newName = args.name.trim();
        }
        for (const section of SETTING_SECTIONS) {
            if (args[section] === undefined) continue;
            const patch = args[section];
            if (!isPlainObject(patch)) return err(`${section} must be an object (a patch to merge).`);
            if (JSON.stringify(patch).length > SETTINGS_PATCH_MAX_CHARS) return err(`The ${section} patch is too large.`);
            if (section === 'header' && 'nav' in patch) {
                return err('The header menu is not set here.', { _fixHint: 'Use cms_update_header_nav for header.nav; it validates the menu structure.' });
            }
            const valid = Object.keys(deps.defaults.SITE_DEFAULTS[section] || {});
            const bad = Object.keys(patch).filter((k) => !valid.includes(k));
            if (bad.length) return err(`${section} has no setting called ${bad.join(', ')}.`, { _fixHint: `Valid ${section} keys: ${valid.join(', ')}.` });
            if ('enabled' in patch && typeof patch.enabled !== 'boolean') return err(`${section}.enabled must be true or false.`);
            sectionPatches[section] = patch;
        }
        if (args.analytics !== undefined) {
            if (!isPlainObject(args.analytics)) return err('analytics must be an object like {gaMeasurementId:"G-XXXXXXXXXX"}.');
            const asked = String(args.analytics.gaMeasurementId ?? '').trim();
            const cleaned = deps.cmsParts.sanitizeAnalytics({ gaMeasurementId: asked });
            if (asked && !cleaned.gaMeasurementId) return err(`"${asked.slice(0, 40)}" is not a Google Analytics 4 id.`, { _fixHint: 'It looks like G-ABC123XYZ (the letter G, a dash, 4-20 letters or digits). Send "" to clear it.' });
            newAnalytics = cleaned;
        }

        const applyPatches = (/** @type {Record<string, any>} */ site) => {
            if (newName !== undefined) site.name = newName;
            for (const [section, patch] of Object.entries(sectionPatches)) {
                site[section] = deps.cmsParts.deepMerge(site[section] || deps.defaults.SITE_DEFAULTS[section], patch);
            }
            if (newAnalytics !== undefined) site.analytics = newAnalytics;
        };
        // Validate the result of the patch on today's copy before anything is written...
        const next = JSON.parse(JSON.stringify(found.project));
        applyPatches(next);
        const chromeProblem = cmsStore.validateSiteChrome(next);
        if (chromeProblem) {
            return err(chromeProblem, { _fixHint: 'Nothing was saved. Lists (columns, links, socials, ctas) must be lists of objects, text fields must be text, and link kinds are page, external, anchor or app. Read the current values with cms_get_site_settings.' });
        }
        // ...then apply it to the SiteDoc as stored under the store's lock: a settings call
        // running in parallel with another edit keeps both, and the page list is untouched.
        const { site: saved } = await cmsStore.mutateProject(found.siteId, applyPatches, { bumpRev: true });
        const draftWrap = await loadDraft(found.siteId, ctx);
        const validation = validationOf(draftWrap);
        /** @type {Record<string, any>} */
        const changed = { siteId: found.siteId, updated: sent };
        if (sent.includes('name')) changed.name = saved.name;
        for (const section of [...SETTING_SECTIONS, 'analytics']) if (sent.includes(section)) changed[section] = saved[section];
        return { result: { ...changed, ...(validation ? { validation } : {}) } };
    }

    return { listSites, duplicateSite, listTemplates, deletePage, getSiteSettings, updateSiteSettings };
}

/**
 * Read and write the per-locale overrides (site and page level).
 * @param {HandlerKit} kit
 */
function createLocaleHandlers({ deps, cmsStore, resolveSite }) {
    /** @param {ToolArgs} args */
    async function getLocaleOverrides(args) {
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const wantedLocale = args.locale ? String(args.locale).toLowerCase() : null;
        const { siteByLocale, pagesByLocale } = await deps.cmsParts.collectLocaleOverrides(site.siteId, { fresh: true });
        /** @type {Record<string, any>} */
        const out = { siteId: site.siteId, defaultLocale: await cmsStore.getDefaultLocale(), site: {}, pages: {} };
        for (const [loc, ov] of Object.entries(siteByLocale || {})) {
            if (!wantedLocale || loc === wantedLocale) out.site[loc] = ov;
        }
        for (const [pageId, perLocale] of Object.entries(pagesByLocale || {})) {
            if (args.pageId && pageId !== args.pageId) continue;
            for (const [loc, ov] of Object.entries(perLocale || {})) {
                if (wantedLocale && loc !== wantedLocale) continue;
                out.pages[pageId] = { ...(out.pages[pageId] || {}), [loc]: ov };
            }
        }
        return { result: out };
    }

    /** @param {ToolArgs} args */
    async function setLocaleOverride(args) {
        const locale = String(args.locale || '').toLowerCase();
        if (!cmsStore.isValidLocale(locale)) return err(`"${String(args.locale).slice(0, 20)}" is not a language code such as "en", "nl" or "pt-br".`);
        const site = await resolveSite(args);
        if (site.error || !site.siteId) return err(site.error ?? 'No site was resolved.');
        const pageId = typeof args.pageId === 'string' && args.pageId ? args.pageId : null;
        if (pageId && !site.project.pages.some((/** @type {PageEntry} */ p) => p.id === pageId)) {
            return err(`Page "${pageId}" is not in this site.`, { _fixHint: `Known page ids: ${site.project.pages.map((/** @type {PageEntry} */ p) => `${p.id} (${p.slug})`).join(', ') || 'none'}.` });
        }
        if (args.remove === true) {
            if (pageId) await cmsStore.deletePageLocaleOverride(site.siteId, pageId, locale);
            else await cmsStore.deleteSiteLocaleOverride(site.siteId, locale);
            return { result: { siteId: site.siteId, locale, pageId, removed: true } };
        }
        if (!isPlainObject(args.override)) return err('override must be an object.', { _fixHint: 'Site level: {header, footer, pageTitles}. Page level: {blocks:{<blockId>:{content:{…}}}, seo:{metaTitle,metaDescription}}. Read the current one with cms_get_locale_overrides.' });
        if (JSON.stringify(args.override).length > OVERRIDE_MAX_CHARS) return err('The override is too large.');
        if (pageId) {
            const shapeError = blockOverrideShapeError(args.override.blocks);
            if (shapeError) return err(shapeError, { _fixHint: 'Put each block\'s text under `content`: {blocks:{"blk_…":{content:{title:"…", items:[{body:"…"}]}}}}. Without it the renderer ignores the translation.' });
        }
        const saved = pageId
            ? await cmsStore.setPageLocaleOverride(site.siteId, pageId, locale, args.override)
            : await cmsStore.setSiteLocaleOverride(site.siteId, locale, args.override);
        /** @type {Record<string, unknown>} */
        const result = { siteId: site.siteId, locale, pageId, saved: true };
        const mediaWarning = mediaWarningFor(args.override, saved);
        if (mediaWarning) result.mediaWarning = mediaWarning;
        // The public router serves a fixed set of language prefixes; a translation outside
        // it is stored but no visitor can reach it, so say so instead of reporting plain success.
        if (locale === (await cmsStore.getDefaultLocale())) {
            result.warning = `"${locale}" is this site's default language: the content itself is the default, so this override is never shown.`;
        } else if (!LOCALE_PREFIXES.has(locale)) {
            result.warning = `"${locale}" is saved but not publicly routable: the public site serves only ${[...LOCALE_PREFIXES].map((l) => `"${l}"`).join(', ')} next to the default language, so visitors cannot reach this translation yet.`;
        }
        return { result };
    }

    return { getLocaleOverrides, setLocaleOverride };
}

module.exports = { createSiteHandlers, createLocaleHandlers, SETTING_SECTIONS };
