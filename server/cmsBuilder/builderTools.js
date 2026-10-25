// @typecheck
/**
 * CMS builder tools — the function-calling surface the conversational CMS
 * page-building agent uses to mutate a site draft.
 *
 * Philosophy mirrors appStudio/builderTools.js:
 *   - every mutating tool validates + normalizes its args, persists through
 *     stores/cmsStore (the same primitives the admin panel uses), and
 *     decorates its result with repair hints (`_hints`) so the model learns
 *     the right shape,
 *   - rejected calls return { error, _fixHint } — they NEVER throw,
 *   - there is no separate "finalize": every successful mutation is already
 *     persisted, so a refresh recovers the site via the normal CMS routes.
 *
 * The draft wrapper shared with the route (routes/ai/cmsBuilder.js):
 *   {
 *     siteId, userId, orgId, builderSessionId,
 *     site,            // SiteDoc — refreshed after every site-index mutation
 *     pages,           // Map(pageId → PageDoc) — refreshed after page mutations
 *     defaultLocale, locales,
 *     createdPageIds,  // pages created THIS turn (rides the done event)
 *     touchedPageIds,  // Set of every page mutated this turn
 *   }
 */

'use strict';

const cmsStore = require('../stores/cmsStore');
const { validateStylePatch, STYLE_KEYS } = require('./blockStyle');
const { TOOL_SCHEMAS } = require('./schemas');
const { isPlainObject, clone, deepMerge, pageIdsHint, findIndexEntry, getPageDoc, refreshSite, persistPage } = require('./builderToolsShared');
const { NAV_LIMITS, sanitizeHeaderNav, applyUpdateHeaderNav } = require('./builderToolsNav');
const { summariseDesign, sanitizeDesignPatch, applyUpdateDesign } = require('./builderToolsDesign');
const { MAX_BLOCKS_PER_CALL, resolveInsertIndex, applyAddBlocks, applyUpdateBlock, applyRemoveBlock, applyReorderBlocks } = require('./builderToolsBlocks');

// ── Mutation bookkeeping (the route emits draft events from these) ──

const MUTATING_TOOLS = new Set([
    'cms_create_page', 'cms_update_page_meta', 'cms_update_page_seo',
    'cms_add_blocks', 'cms_update_block', 'cms_remove_block', 'cms_reorder_blocks',
    'cms_set_homepage', 'cms_reorder_pages', 'cms_update_header_nav', 'cms_update_design',
]);

// Tools whose success changes the SITE DOC (page index / homepage / slugs /
// header chrome / design) → the route emits a draft { kind:'site' } event and
// the client full-replaces its SiteDoc.
const SITE_DRAFT_TOOLS = new Set([
    'cms_create_page', 'cms_update_page_meta', 'cms_set_homepage', 'cms_reorder_pages',
    'cms_update_header_nav', 'cms_update_design',
]);

// Tools whose success changes ONE PAGE's document → the route emits a draft
// { kind:'page', pageId } event (pageId from result.pageId).
const PAGE_DRAFT_TOOLS = new Set([
    'cms_create_page', 'cms_update_page_meta', 'cms_update_page_seo',
    'cms_add_blocks', 'cms_update_block', 'cms_remove_block', 'cms_reorder_blocks',
]);

// Column data only ever renders under the 'columns' layout — see
// sanitizeNavDropdown. Kept as a named constant for the doc comment below.

// ── Small helpers ────────────────────────────────────────────────────

// ── READ tools ───────────────────────────────────────────────────────

async function applyListSite(draftWrap) {
    const site = draftWrap.site;
    const pages = [];
    for (const entry of site.pages || []) {
        const doc = await getPageDoc(draftWrap, entry.id);
        const blocks = doc && Array.isArray(doc.blocks) ? doc.blocks : [];
        pages.push({
            id: entry.id,
            slug: entry.slug,
            title: entry.title,
            isHomepage: !!entry.isHomepage,
            hideHeader: !!entry.hideHeader,
            hideFooter: !!entry.hideFooter,
            blockCount: blocks.length,
            blockTypes: blocks.map((b) => b.type),
        });
    }
    return {
        site: {
            name: site.name,
            defaultLocale: draftWrap.defaultLocale || 'en',
            locales: Array.isArray(draftWrap.locales) ? draftWrap.locales : [],
            designSummary: summariseDesign(site.design),
        },
        pages,
    };
}

async function applyGetPage(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    const entry = pageId ? findIndexEntry(draftWrap, pageId) : null;
    if (!entry) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) {
        return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };
    }
    return { page: clone(doc), meta: clone(entry) };
}

// ── MUTATING tools ───────────────────────────────────────────────────

async function applyCreatePage(draftWrap, args) {
    const title = typeof args?.title === 'string' ? args.title.trim() : '';
    if (!title) return { error: 'title is required (a non-empty string).' };
    let created;
    try {
        created = await cmsStore.createPage(draftWrap.siteId, {
            title,
            slug: typeof args?.slug === 'string' ? args.slug : undefined,
            templateId: typeof args?.templateId === 'string' ? args.templateId : undefined,
        });
    } catch (e) {
        // createPage throws on reserved slugs and unknown templates — surface
        // it as a teachable error, never a crash.
        const reserved = /reserved/i.test(e.message);
        return {
            error: e.message,
            _fixHint: reserved
                ? 'Pick a different slug — reserved slugs collide with app routes (e.g. app, api, admin, login, pricing, privacy, terms).'
                : 'Check the arguments and try again (templateId must be an existing tpl_… id).',
        };
    }
    await refreshSite(draftWrap);
    const doc = await cmsStore.getPage(draftWrap.siteId, created.id);
    if (doc) draftWrap.pages.set(created.id, doc);
    draftWrap.createdPageIds.push(created.id);
    draftWrap.touchedPageIds.add(created.id);
    return { pageId: created.id, slug: created.slug, title: doc?.title ?? title };
}

async function applyUpdatePageMeta(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const patch = {};
    if (typeof args.title === 'string') patch.title = args.title;
    if (typeof args.slug === 'string') patch.slug = args.slug;
    if (typeof args.hideHeader === 'boolean') patch.hideHeader = args.hideHeader;
    if (typeof args.hideFooter === 'boolean') patch.hideFooter = args.hideFooter;
    if (!Object.keys(patch).length) {
        return { error: 'Nothing to change — pass at least one of: title, slug, hideHeader, hideFooter.' };
    }
    let entry;
    try {
        entry = await cmsStore.updatePageMeta(draftWrap.siteId, pageId, patch);
    } catch (e) {
        const reserved = /reserved/i.test(e.message);
        return {
            error: e.message,
            _fixHint: reserved
                ? 'Pick a different slug — reserved slugs collide with app routes (e.g. app, api, admin, login, pricing, privacy, terms).'
                : pageIdsHint(draftWrap),
        };
    }
    await refreshSite(draftWrap);
    const doc = await cmsStore.getPage(draftWrap.siteId, pageId);
    if (doc) draftWrap.pages.set(pageId, doc);
    draftWrap.touchedPageIds.add(pageId);
    return {
        pageId,
        page: {
            id: entry.id, slug: entry.slug, title: entry.title,
            isHomepage: !!entry.isHomepage, hideHeader: !!entry.hideHeader, hideFooter: !!entry.hideFooter,
        },
    };
}

const OG_IMAGE_RE = /^(https?:\/\/|cms\/)/;

async function applyUpdatePageSeo(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const patch = {};
    if (typeof args.metaTitle === 'string') patch.metaTitle = args.metaTitle;
    if (typeof args.metaDescription === 'string') patch.metaDescription = args.metaDescription;
    if (typeof args.noIndex === 'boolean') patch.noIndex = args.noIndex;
    if (typeof args.ogImage === 'string') {
        const og = args.ogImage.trim();
        if (og && !OG_IMAGE_RE.test(og)) {
            return {
                error: `ogImage ${JSON.stringify(og)} is not an existing cms/… asset key or an absolute URL.`,
                _fixHint: 'Use an asset the user already uploaded (a key starting with "cms/") or a full https:// URL. Never invent asset keys; leave ogImage unset if there is no real image.',
            };
        }
        patch.ogImage = og;
    }
    if (!Object.keys(patch).length) {
        return { error: 'Nothing to change — pass at least one of: metaTitle, metaDescription, ogImage, noIndex.' };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };
    const { page } = await persistPage(draftWrap, pageId, (d) => ({
        ...d, seo: { ...(isPlainObject(d.seo) ? d.seo : {}), ...patch },
    }));
    return { pageId, seo: clone(page.seo) };
}

async function applySetHomepage(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    try {
        await cmsStore.setHomepage(draftWrap.siteId, pageId);
    } catch (e) {
        return { error: e.message, _fixHint: pageIdsHint(draftWrap) };
    }
    await refreshSite(draftWrap);
    return { homepageId: pageId };
}

async function applyReorderPages(draftWrap, args) {
    const ordered = Array.isArray(args?.orderedIds) ? args.orderedIds : null;
    if (!ordered || !ordered.length) {
        return { error: 'orderedIds must be a non-empty array of page ids.', _fixHint: pageIdsHint(draftWrap) };
    }
    const current = (draftWrap.site?.pages || []).map((p) => p.id);
    const currentSet = new Set(current);
    const orderedSet = new Set(ordered);
    const missing = current.filter((id) => !orderedSet.has(id));
    const extra = ordered.filter((id) => !currentSet.has(id));
    if (missing.length || extra.length || ordered.length !== current.length) {
        const bits = [];
        if (missing.length) bits.push(`missing: ${missing.join(', ')}`);
        if (extra.length) bits.push(`unknown/extra: ${extra.join(', ')}`);
        if (!missing.length && !extra.length) bits.push('duplicate ids in orderedIds');
        return {
            error: `orderedIds must be exactly the site's current page ids in a new order (${bits.join('; ')}).`,
            _fixHint: pageIdsHint(draftWrap),
        };
    }
    try {
        await cmsStore.reorderPages(draftWrap.siteId, ordered);
    } catch (e) {
        return { error: e.message, _fixHint: pageIdsHint(draftWrap) };
    }
    await refreshSite(draftWrap);
    return { order: ordered };
}

// ── Header nav (cms_update_header_nav) ──────────────────────────────
//
// Storage shape (SiteDoc): header.nav[] = { id, label, link, children?,
// dropdown? }. children[] = flat sub-items { id, label, link }; dropdown =
// mega menu { layout:'columns'|'list', columns:[{ id, heading, items:[{ id,
// label, link, description?, icon?, openInNewTab? }] }] }. A mega item's
// icon is a Lucide name or an uploaded asset (NavIcon renders both); an emoji
// is legacy content that still renders. There is no header-specific store updater — the tool
// persists read-modify-write through cmsStore.setProject, which stores nav
// VERBATIM, so every check lives here.

// ── Design (cms_update_design) ──────────────────────────────────────
//
// Storage shape (SiteDoc): design = { colors, darkColors, fonts, logo,
// favicon, radius, theme, gradient, preset, typography, motion, grain,
// components, layout } — a fixed-key record with no ids, so the tool patches
// it instead of replacing it. cmsStore.sanitizeDesign() rebuilds the doc
// key-by-key but NEVER rejects: an unknown enum falls back to the identity
// value and a malformed colour is stored verbatim. So every check lives here
// (hard reject, before any I/O) and the returned summary is read back from
// the PERSISTED doc — see applyUpdateDesign.
//
// logo/favicon are deliberately not patchable: they are uploaded asset keys
// and the standing prompt rule is "NEVER invent asset keys".

// ── Dispatcher ───────────────────────────────────────────────────────

const TOOL_IMPLS = {
    cms_list_site: applyListSite,
    cms_get_page: applyGetPage,
    cms_create_page: applyCreatePage,
    cms_update_page_meta: applyUpdatePageMeta,
    cms_update_page_seo: applyUpdatePageSeo,
    cms_add_blocks: applyAddBlocks,
    cms_update_block: applyUpdateBlock,
    cms_remove_block: applyRemoveBlock,
    cms_reorder_blocks: applyReorderBlocks,
    cms_set_homepage: applySetHomepage,
    cms_reorder_pages: applyReorderPages,
    cms_update_header_nav: applyUpdateHeaderNav,
    cms_update_design: applyUpdateDesign,
};

/**
 * Apply one tool call to the draft. NEVER throws: hard rejects come back as
 * { error, _fixHint? } and unexpected store failures are caught into the
 * same shape so a bad call can't kill the builder turn.
 */
async function applyToolCall(draftWrap, name, args) {
    const impl = TOOL_IMPLS[name];
    if (!impl) {
        return { error: `Unknown tool ${JSON.stringify(name)}.`, _fixHint: `Valid tools: ${Object.keys(TOOL_IMPLS).join(', ')}.` };
    }
    try {
        return await impl(draftWrap, args || {});
    } catch (e) {
        return { error: `Tool ${name} failed: ${e.message}` };
    }
}

module.exports = {
    TOOL_SCHEMAS,
    MUTATING_TOOLS,
    SITE_DRAFT_TOOLS,
    PAGE_DRAFT_TOOLS,
    MAX_BLOCKS_PER_CALL,
    NAV_LIMITS,
    applyToolCall,
    // internals exposed for unit tests
    _test: { deepMerge, validateStylePatch, STYLE_KEYS, resolveInsertIndex, summariseDesign, sanitizeHeaderNav, sanitizeDesignPatch },
};

/**
 * @typedef {import('../stores/cms/shared').SiteDoc} SiteDoc
 * @typedef {import('../stores/cms/shared').PageDoc} PageDoc
 * @typedef {import('../stores/cms/shared').CmsBlock} CmsBlock
 * @typedef {import('../stores/cms/shared').CmsDoc} CmsDoc
 * @typedef {{ siteId: string, userId: string, orgId: string, builderSessionId: string, site: SiteDoc,
 *   pages: Map<string, PageDoc>, defaultLocale: string, locales: string[], createdPageIds: string[],
 *   touchedPageIds: Set<string> }} DraftWrap  the draft wrapper shared with the route
 * @typedef {Record<string, unknown>} ToolArgs  the model's arguments for one tool call (untrusted JSON)
 * @typedef {Record<string, any>} ToolResult  a tool's JSON answer: a result object, or { error, _fixHint? }
 * @typedef {(draftWrap: DraftWrap, args: ToolArgs) => Promise<ToolResult>} ToolImpl
 * @typedef {{ index: number, type: unknown, reason: string, message?: string, _fixHint?: string }} DroppedBlock
 * @typedef {{ id: string, label: string, link: Record<string, unknown>, description?: string, icon?: string,
 *   openInNewTab?: boolean, children?: NavItem[], dropdown?: NavDropdown }} NavItem
 * @typedef {{ id: string, heading: string, items: NavItem[] }} NavColumn
 * @typedef {{ layout: string, columns: NavColumn[] }} NavDropdown
 */
