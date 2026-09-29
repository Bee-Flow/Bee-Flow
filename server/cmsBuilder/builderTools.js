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

const crypto = require('crypto');
const cmsStore = require('../stores/cmsStore');
const {
    BLOCK_DEFAULTS, BLOCK_TYPE_IDS,
    DESIGN_COMPONENT_ENUMS, DESIGN_LAYOUT_ENUMS, DESIGN_THEMES, DESIGN_MOTIONS,
    DISPLAY_SIZES, HEADING_WEIGHTS, BODY_SIZES, COLOR_KEYS, DARK_COLOR_KEYS, DESIGN_FONTS,
} = require('../i18n/defaults/cmsDefaults');
const { THEME_PRESETS, THEME_PRESET_IDS } = require('../i18n/defaults/themePresets');
const { TOOL_SCHEMAS, LINK_HINT, DESIGN_HINT } = require('./schemas');

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

const MAX_BLOCKS_PER_CALL = 10;

// Header-nav caps (cms_update_header_nav). The tool owns ALL nav validation:
// cmsStore.setProject stores header.nav verbatim with zero checks.
const NAV_LIMITS = { topLevel: 20, children: 10, columns: 4, columnItems: 10 };
const NAV_LINK_KINDS = ['page', 'external', 'anchor', 'app'];
// Column data only ever renders under the 'columns' layout — see
// sanitizeNavDropdown. Kept as a named constant for the doc comment below.

// Design caps (cms_update_design). Same deal as the nav: the tool owns ALL
// design validation because cmsStore.sanitizeDesign COERCES rather than
// rejects (a bad hex is stored verbatim, an unknown enum silently falls back
// to the identity value) — echoing the request back would report success for
// an edit that evaporated.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FONT_ROLES = ['heading', 'body', 'mono'];
const TYPOGRAPHY_ENUMS = {
    displaySize: DISPLAY_SIZES,
    headingWeight: HEADING_WEIGHTS,
    bodySize: BODY_SIZES,
};
// darkColors.primary/accent take '' = "reuse the light value" (see
// DESIGN_DEFAULTS.darkColors) — every other colour must be a real hex.
const BLANKABLE_DARK_COLORS = ['primary', 'accent'];

const STYLE_MAX_WIDTHS = ['narrow', 'medium', 'wide', 'full'];
const STYLE_ALIGNS = ['left', 'center', 'right'];
const COLOR_TOKENS = ['primary', 'secondary', 'accent', 'background', 'surface', 'textPrimary', 'textSecondary'];
const SPACING_KEYS = ['paddingTop', 'paddingBottom'];
const STYLE_KEYS = ['colorOverrides', 'spacing', 'backgroundImage', 'backgroundOverlay', 'maxWidth', 'align', 'cssClass'];

// ── Small helpers ────────────────────────────────────────────────────

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * Pure deep-merge with ARRAYS REPLACED WHOLESALE (never merged by index) —
 * the CMS builder's content-patch semantics, documented in the tool schemas.
 */
function deepMerge(base, override) {
    if (override === undefined) return clone(base);
    if (override === null) return null;
    if (Array.isArray(override)) return clone(override);
    if (typeof override !== 'object') return override;
    if (!isPlainObject(base)) return clone(override);
    const out = clone(base);
    for (const [k, v] of Object.entries(override)) {
        out[k] = deepMerge(base[k], v);
    }
    return out;
}

// Same id shape the store mints (newId in stores/cmsStore.js): prefix_16hex.
function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function newBlockId() {
    return newId('blk');
}

function pageIdsHint(draftWrap) {
    const entries = (draftWrap.site?.pages || []).map((p) => `${p.id} (${p.slug})`);
    return `Known page ids: ${entries.join(', ') || '(none — create a page first)'}.`;
}

function blockIdsHint(page) {
    const entries = (page.blocks || []).map((b) => `${b.id} (${b.type})`);
    return `Known block ids on this page: ${entries.join(', ') || '(none)'}.`;
}

function typesHint() {
    return `Valid block types: ${BLOCK_TYPE_IDS.join(', ')}.`;
}

function findIndexEntry(draftWrap, pageId) {
    return (draftWrap.site?.pages || []).find((p) => p.id === pageId) || null;
}

/** Load a PageDoc through the per-turn cache. Returns null when unknown. */
async function getPageDoc(draftWrap, pageId) {
    if (draftWrap.pages.has(pageId)) return draftWrap.pages.get(pageId);
    const doc = await cmsStore.getPage(draftWrap.siteId, pageId);
    if (doc) draftWrap.pages.set(pageId, doc);
    return doc;
}

/** Refresh the SiteDoc after a site-index mutation. */
async function refreshSite(draftWrap) {
    draftWrap.site = await cmsStore.getProject(draftWrap.siteId);
}

/** Persist a PageDoc through the store's sanitizer and refresh the cache. */
async function persistPage(draftWrap, pageDoc) {
    const { page, dropped } = await cmsStore.setPage(draftWrap.siteId, pageDoc);
    draftWrap.pages.set(page.id, page);
    draftWrap.touchedPageIds.add(page.id);
    return { page, dropped };
}

/**
 * One-line human summary of a DesignDoc — feeds cms_list_site's
 * `designSummary` and cms_update_design's `summary`. Covers every themable
 * dimension (the old 4-field version made design edits invisible to the
 * model, which could then not tell what its own patch had done).
 */
function summariseDesign(design) {
    const d = isPlainObject(design) ? design : {};
    const colors = isPlainObject(d.colors) ? d.colors : {};
    const fonts = isPlainObject(d.fonts) ? d.fonts : {};
    const ty = isPlainObject(d.typography) ? d.typography : {};
    const cp = isPlainObject(d.components) ? d.components : {};
    const ly = isPlainObject(d.layout) ? d.layout : {};
    return [
        `preset ${d.preset || 'custom'}`,
        `theme ${d.theme || 'light'}`,
        `primary ${colors.primary || '?'}`,
        `accent ${colors.accent || '?'}`,
        `background ${colors.background || '?'}`,
        `fonts ${fonts.heading || '?'}/${fonts.body || '?'}/${fonts.mono || '?'}`,
        `radius ${d.radius ?? '?'}`,
        `type ${ty.displaySize || '?'}/${ty.headingWeight ?? '?'}/${ty.bodySize ?? '?'}`,
        `motion ${d.motion || '?'}`,
        `grain ${d.grain ? 'on' : 'off'}`,
        `gradient ${d.gradient ? 'on' : 'off'}`,
        `buttons ${cp.buttonShape || '?'}/${cp.buttonSize || '?'}/${cp.buttonTextColor || '?'}`,
        `nav ${cp.navStyle || '?'}/${cp.navHeight || '?'}`,
        `logo ${cp.logoSize || '?'}`,
        `cards ${cp.cardStyle || '?'}/${cp.cardPadding || '?'}`,
        `shadow ${cp.shadow || '?'}`,
        `container ${ly.containerWidth || '?'}`,
        `rhythm ${ly.sectionRhythm || '?'}`,
    ].join(' · ');
}

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
    const next = { ...clone(doc), seo: { ...(isPlainObject(doc.seo) ? doc.seo : {}), ...patch } };
    const { page } = await persistPage(draftWrap, next);
    return { pageId, seo: clone(page.seo) };
}

/** Resolve an insert position → index into `blocks`, or { error }. */
function resolveInsertIndex(blocks, position, page) {
    if (position === undefined || position === null || position === 'end') return { index: blocks.length };
    if (isPlainObject(position)) {
        if (typeof position.afterBlockId === 'string') {
            const at = blocks.findIndex((b) => b.id === position.afterBlockId);
            if (at < 0) {
                return {
                    error: `position.afterBlockId ${JSON.stringify(position.afterBlockId)} is not a block on this page.`,
                    _fixHint: blockIdsHint(page),
                };
            }
            return { index: at + 1 };
        }
        if (Number.isInteger(position.index)) {
            return { index: Math.max(0, Math.min(blocks.length, position.index)) };
        }
    }
    return { error: 'position must be "end", { afterBlockId } or { index }.' };
}

async function applyAddBlocks(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const list = Array.isArray(args?.blocks) ? args.blocks : null;
    if (!list || !list.length) {
        return { error: 'blocks must be a non-empty array of { type, content? }.', _fixHint: typesHint() };
    }
    if (list.length > MAX_BLOCKS_PER_CALL) {
        return { error: `blocks: max ${MAX_BLOCKS_PER_CALL} per call — split the work into two calls.` };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };

    const pos = resolveInsertIndex(doc.blocks || [], args.position, doc);
    if (pos.error) return pos;

    const minted = [];
    const dropped = [];
    const warnings = [];
    list.forEach((entry, i) => {
        if (!isPlainObject(entry) || typeof entry.type !== 'string' || !entry.type.trim()) {
            dropped.push({ index: i, type: entry && entry.type ? entry.type : null, reason: 'missing-type' });
            return;
        }
        // Canonicalize the type through the store's own alias logic (a probe
        // through sanitizeBlocks) so client/server agree on what survives.
        const probe = cmsStore.sanitizeBlocks([{ type: entry.type, content: {} }]);
        if (!probe.blocks.length) {
            dropped.push({ index: i, type: entry.type, reason: 'unknown-type' });
            return;
        }
        const type = probe.blocks[0].type;
        if (type !== entry.type) warnings.push(`blocks[${i}]: type "${entry.type}" was normalized to "${type}".`);
        const content = deepMerge(BLOCK_DEFAULTS[type] || {}, isPlainObject(entry.content) ? entry.content : {});
        minted.push({ id: newBlockId(), type, enabled: true, content, style: {} });
    });

    if (!minted.length) {
        return {
            error: `No blocks added — all ${list.length} entr${list.length === 1 ? 'y' : 'ies'} had unknown or missing types (${dropped.map((d) => JSON.stringify(d.type)).join(', ')}).`,
            _fixHint: typesHint(),
            dropped,
        };
    }

    const blocks = [...(doc.blocks || [])];
    blocks.splice(pos.index, 0, ...minted);
    const { page } = await persistPage(draftWrap, { ...clone(doc), blocks });
    const survivors = new Set(page.blocks.map((b) => b.id));
    const result = {
        pageId,
        blockIds: minted.map((b) => b.id).filter((id) => survivors.has(id)),
        dropped,
        warnings,
    };
    if (dropped.length) {
        result._fixHint = `${dropped.length} block(s) dropped (${dropped.map((d) => JSON.stringify(d.type)).join(', ')}). ${typesHint()}`;
    }
    return result;
}

/**
 * Shallow-validate a stylePatch against the block style wrapper shape.
 * Returns { style, hints } (validated patch + repair notes) or { error, _fixHint }.
 */
function validateStylePatch(patch) {
    if (!isPlainObject(patch)) return { error: 'stylePatch must be an object.' };
    const out = {};
    const hints = [];
    for (const [key, value] of Object.entries(patch)) {
        if (!STYLE_KEYS.includes(key)) {
            hints.push(`stylePatch.${key}: unknown style key, dropped. Valid keys: ${STYLE_KEYS.join(', ')}.`);
            continue;
        }
        if (key === 'maxWidth') {
            if (!STYLE_MAX_WIDTHS.includes(value)) {
                return { error: `stylePatch.maxWidth ${JSON.stringify(value)} is invalid.`, _fixHint: `Valid maxWidth values: ${STYLE_MAX_WIDTHS.join(', ')}.` };
            }
            out.maxWidth = value;
        } else if (key === 'align') {
            if (!STYLE_ALIGNS.includes(value)) {
                return { error: `stylePatch.align ${JSON.stringify(value)} is invalid.`, _fixHint: `Valid align values: ${STYLE_ALIGNS.join(', ')}.` };
            }
            out.align = value;
        } else if (key === 'colorOverrides') {
            if (!isPlainObject(value)) {
                return { error: 'stylePatch.colorOverrides must be an object of color tokens.', _fixHint: `Valid tokens: ${COLOR_TOKENS.join(', ')}.` };
            }
            const colors = {};
            for (const [tok, col] of Object.entries(value)) {
                if (!COLOR_TOKENS.includes(tok)) { hints.push(`colorOverrides.${tok}: unknown token, dropped. Valid tokens: ${COLOR_TOKENS.join(', ')}.`); continue; }
                if (typeof col !== 'string') { hints.push(`colorOverrides.${tok}: must be a color string, dropped.`); continue; }
                colors[tok] = col;
            }
            out.colorOverrides = colors;
        } else if (key === 'spacing') {
            if (!isPlainObject(value)) {
                return { error: 'stylePatch.spacing must be an object.', _fixHint: `Valid spacing keys: ${SPACING_KEYS.join(', ')} (numbers).` };
            }
            const spacing = {};
            for (const [sk, sv] of Object.entries(value)) {
                if (!SPACING_KEYS.includes(sk)) { hints.push(`spacing.${sk}: unknown key, dropped. Valid keys: ${SPACING_KEYS.join(', ')}.`); continue; }
                if (typeof sv !== 'number' || !Number.isFinite(sv)) { hints.push(`spacing.${sk}: must be a number, dropped.`); continue; }
                spacing[sk] = sv;
            }
            out.spacing = spacing;
        } else if (key === 'backgroundImage' || key === 'cssClass') {
            if (typeof value !== 'string') { hints.push(`stylePatch.${key}: must be a string, dropped.`); continue; }
            out[key] = value;
        } else if (key === 'backgroundOverlay') {
            if (typeof value !== 'number' && typeof value !== 'string') { hints.push('stylePatch.backgroundOverlay: must be a number or color string, dropped.'); continue; }
            out.backgroundOverlay = value;
        }
    }
    return { style: out, hints };
}

async function applyUpdateBlock(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };
    const blockId = typeof args?.blockId === 'string' ? args.blockId : null;
    const idx = (doc.blocks || []).findIndex((b) => b.id === blockId);
    if (idx < 0) {
        return { error: `Unknown blockId ${JSON.stringify(blockId)} on page ${pageId}.`, _fixHint: blockIdsHint(doc) };
    }
    const hasContent = isPlainObject(args.contentPatch) && Object.keys(args.contentPatch).length > 0;
    const hasStyle = isPlainObject(args.stylePatch) && Object.keys(args.stylePatch).length > 0;
    const hasEnabled = typeof args.enabled === 'boolean';
    if (!hasContent && !hasStyle && !hasEnabled) {
        return { error: 'Nothing to change — pass contentPatch, stylePatch and/or enabled.' };
    }

    const block = doc.blocks[idx];
    const next = clone(block);
    let styleHints = [];
    if (hasContent) next.content = deepMerge(block.content, args.contentPatch);
    if (hasStyle) {
        const validated = validateStylePatch(args.stylePatch);
        if (validated.error) return validated;
        styleHints = validated.hints;
        const mergedStyle = { ...(isPlainObject(block.style) ? clone(block.style) : {}) };
        for (const [k, v] of Object.entries(validated.style)) {
            if ((k === 'colorOverrides' || k === 'spacing') && isPlainObject(mergedStyle[k])) {
                mergedStyle[k] = { ...mergedStyle[k], ...v };
            } else {
                mergedStyle[k] = v;
            }
        }
        next.style = mergedStyle;
    }
    if (hasEnabled) next.enabled = args.enabled;

    const blocks = [...doc.blocks];
    blocks[idx] = next;
    const { page } = await persistPage(draftWrap, { ...clone(doc), blocks });
    const saved = page.blocks.find((b) => b.id === blockId);
    const result = { pageId, blockId, type: saved?.type, enabled: saved ? saved.enabled : next.enabled };
    if (styleHints.length) result._hints = styleHints;
    return result;
}

async function applyRemoveBlock(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };
    const blockId = typeof args?.blockId === 'string' ? args.blockId : null;
    if (!(doc.blocks || []).some((b) => b.id === blockId)) {
        return { error: `Unknown blockId ${JSON.stringify(blockId)} on page ${pageId}.`, _fixHint: blockIdsHint(doc) };
    }
    const blocks = doc.blocks.filter((b) => b.id !== blockId);
    await persistPage(draftWrap, { ...clone(doc), blocks });
    // Server twin of the admin panel's client-side pruning: drop every
    // locale's translation entry for the removed block.
    const prunedLocales = await cmsStore.pruneBlockLocaleOverrides(draftWrap.siteId, pageId, blockId);
    return { pageId, removed: blockId, prunedLocales };
}

async function applyReorderBlocks(draftWrap, args) {
    const pageId = typeof args?.pageId === 'string' ? args.pageId : null;
    if (!pageId || !findIndexEntry(draftWrap, pageId)) {
        return { error: `Unknown pageId ${JSON.stringify(pageId)}.`, _fixHint: pageIdsHint(draftWrap) };
    }
    const doc = await getPageDoc(draftWrap, pageId);
    if (!doc) return { error: `Page document for ${pageId} is missing.`, _fixHint: pageIdsHint(draftWrap) };
    const ordered = Array.isArray(args?.orderedBlockIds) ? args.orderedBlockIds : null;
    if (!ordered) return { error: 'orderedBlockIds must be an array of block ids.', _fixHint: blockIdsHint(doc) };

    const current = (doc.blocks || []).map((b) => b.id);
    const currentSet = new Set(current);
    const orderedSet = new Set(ordered);
    const missing = current.filter((id) => !orderedSet.has(id));
    const extra = ordered.filter((id) => !currentSet.has(id));
    if (missing.length || extra.length || ordered.length !== current.length) {
        const bits = [];
        if (missing.length) bits.push(`missing: ${missing.join(', ')}`);
        if (extra.length) bits.push(`unknown/extra: ${extra.join(', ')}`);
        if (!missing.length && !extra.length) bits.push('duplicate ids in orderedBlockIds');
        return {
            error: `orderedBlockIds must be exactly the page's current block ids in a new order (${bits.join('; ')}).`,
            _fixHint: blockIdsHint(doc),
        };
    }
    const byId = new Map(doc.blocks.map((b) => [b.id, b]));
    const blocks = ordered.map((id) => byId.get(id));
    await persistPage(draftWrap, { ...clone(doc), blocks });
    return { pageId, order: ordered };
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
// icon is an EMOJI or short text by design (see the agent-hub HeaderEditor),
// NOT a Lucide name. There is no header-specific store updater — the tool
// persists read-modify-write through cmsStore.setProject, which stores nav
// VERBATIM, so every check lives here.

/**
 * Validate one nav link against the link union; page links must reference
 * an existing page. Returns { link } (cloned) or { error, _fixHint }.
 */
function sanitizeNavLink(draftWrap, link, path) {
    if (!isPlainObject(link)) {
        return { error: `${path}.link must be a link object.`, _fixHint: LINK_HINT };
    }
    if (!NAV_LINK_KINDS.includes(link.kind)) {
        return {
            error: `${path}.link.kind ${JSON.stringify(link.kind ?? null)} is invalid.`,
            _fixHint: `Valid kinds: ${NAV_LINK_KINDS.join(', ')}. ${LINK_HINT}`,
        };
    }
    if (link.kind === 'page' && !findIndexEntry(draftWrap, link.pageId)) {
        return {
            error: `${path}.link points at unknown pageId ${JSON.stringify(link.pageId ?? null)}.`,
            _fixHint: pageIdsHint(draftWrap),
        };
    }
    return { link: clone(link) };
}

/**
 * Validate + whitelist one nav entry (top-level item, child, or mega item —
 * `withExtras` adds the mega-item-only keys). Existing non-empty ids are
 * preserved (locale overrides / stable references survive); missing ids are
 * minted with the nav_ prefix. Unknown keys are dropped by construction.
 * Returns { item } or { error, _fixHint }.
 */
function sanitizeNavEntry(draftWrap, raw, path, { withExtras = false } = {}) {
    if (!isPlainObject(raw)) {
        return { error: `${path} must be an object with { label, link }.`, _fixHint: LINK_HINT };
    }
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label) {
        return { error: `${path}.label must be a non-empty string.`, _fixHint: 'Every menu item needs a visible label.' };
    }
    const linked = sanitizeNavLink(draftWrap, raw.link, path);
    if (linked.error) return linked;
    const item = {
        id: (typeof raw.id === 'string' && raw.id.trim()) ? raw.id.trim() : newId('nav'),
        label,
        link: linked.link,
    };
    if (withExtras) {
        if (typeof raw.description === 'string' && raw.description) item.description = raw.description;
        if (typeof raw.icon === 'string' && raw.icon) item.icon = raw.icon;
        if (typeof raw.openInNewTab === 'boolean') item.openInNewTab = raw.openInNewTab;
    }
    return { item };
}

/** Validate + whitelist a mega-menu blob. Returns { dropdown } or { error }. */
function sanitizeNavDropdown(draftWrap, raw, path) {
    if (!isPlainObject(raw)) {
        return { error: `${path} must be an object { layout, columns }.` };
    }
    if (!Array.isArray(raw.columns)) {
        return { error: `${path}.columns must be an array of { heading, items } columns.` };
    }
    if (raw.columns.length > NAV_LIMITS.columns) {
        return { error: `${path}.columns: max ${NAV_LIMITS.columns} columns (got ${raw.columns.length}).` };
    }
    const columns = [];
    for (let i = 0; i < raw.columns.length; i++) {
        const colRaw = raw.columns[i];
        const colPath = `${path}.columns[${i}]`;
        if (!isPlainObject(colRaw)) return { error: `${colPath} must be an object { heading, items }.` };
        if (!Array.isArray(colRaw.items)) return { error: `${colPath}.items must be an array of menu items.` };
        if (colRaw.items.length > NAV_LIMITS.columnItems) {
            return { error: `${colPath}.items: max ${NAV_LIMITS.columnItems} items per column (got ${colRaw.items.length}).` };
        }
        const items = [];
        for (let j = 0; j < colRaw.items.length; j++) {
            const mi = sanitizeNavEntry(draftWrap, colRaw.items[j], `${colPath}.items[${j}]`, { withExtras: true });
            if (mi.error) return mi;
            items.push(mi.item);
        }
        columns.push({
            id: (typeof colRaw.id === 'string' && colRaw.id.trim()) ? colRaw.id.trim() : newId('nav'),
            heading: typeof colRaw.heading === 'string' ? colRaw.heading : '',
            items,
        });
    }
    // ALWAYS 'columns'. Every consumer (Header.jsx readDropdown, the public
    // synthesizeLegacyContent map and the admin preview) renders `columns`
    // only when layout === 'columns'; persisting 'list' here would store the
    // data and then silently render nothing. A flat dropdown is expressed
    // with `children`, not with list-layout columns.
    return { dropdown: { layout: 'columns', columns } };
}

/** Validate the whole replacement nav. Returns { nav } or { error, _fixHint }. */
function sanitizeHeaderNav(draftWrap, rawNav) {
    if (!Array.isArray(rawNav)) {
        return {
            error: 'nav must be an array of menu items — it REPLACES the whole header menu, so send every item you want to keep.',
            _fixHint: LINK_HINT,
        };
    }
    if (rawNav.length > NAV_LIMITS.topLevel) {
        return { error: `nav: max ${NAV_LIMITS.topLevel} top-level items (got ${rawNav.length}).` };
    }
    const nav = [];
    for (let i = 0; i < rawNav.length; i++) {
        const raw = rawNav[i];
        const path = `nav[${i}]`;
        const base = sanitizeNavEntry(draftWrap, raw, path);
        if (base.error) return base;
        const item = base.item;
        if (raw.children !== undefined) {
            if (!Array.isArray(raw.children)) {
                return { error: `${path}.children must be an array of { label, link } sub-items.` };
            }
            if (raw.children.length > NAV_LIMITS.children) {
                return { error: `${path}.children: max ${NAV_LIMITS.children} sub-items (got ${raw.children.length}).` };
            }
            const children = [];
            for (let j = 0; j < raw.children.length; j++) {
                const child = sanitizeNavEntry(draftWrap, raw.children[j], `${path}.children[${j}]`);
                if (child.error) return child;
                children.push(child.item);
            }
            item.children = children;
        }
        if (raw.dropdown !== undefined) {
            const dd = sanitizeNavDropdown(draftWrap, raw.dropdown, `${path}.dropdown`);
            if (dd.error) return dd;
            item.dropdown = dd.dropdown;
        }
        nav.push(item);
    }
    return { nav };
}

async function applyUpdateHeaderNav(draftWrap, args) {
    const sanitized = sanitizeHeaderNav(draftWrap, args?.nav);
    if (sanitized.error) return sanitized;
    // Re-read the SiteDoc IMMEDIATELY before the write. draftWrap.site is
    // loaded once at turn start and only refreshed after an earlier
    // site-index tool, so it can be minutes stale by the time the model
    // calls this — and setProject rewrites the WHOLE doc (name, pages
    // index, homepageId, chrome, design, analytics) with no CAS. Without
    // this refresh, a concurrent edit by another admin (sessions are
    // site-scoped and shared) would be silently reverted and any page they
    // created mid-turn would be dropped from the index. Every sibling tool
    // gets this for free by re-reading inside the store at call time.
    await refreshSite(draftWrap);
    if (!isPlainObject(draftWrap.site)) {
        return { error: 'No site loaded — reload the builder.' };
    }
    const site = clone(draftWrap.site);
    site.header = { ...(isPlainObject(site.header) ? site.header : {}), nav: sanitized.nav };
    try {
        await cmsStore.setProject(draftWrap.siteId, site);
    } catch (e) {
        return { error: e.message };
    }
    await refreshSite(draftWrap);
    const nav = Array.isArray(draftWrap.site?.header?.nav) ? draftWrap.site.header.nav : sanitized.nav;
    return { navCount: nav.length, labels: nav.map((i) => i.label) };
}

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

/**
 * Build the design patch key-by-key from allow-lists — unknown keys are
 * impossible by construction, and everything sanitizeDesign would silently
 * swallow is rejected with DESIGN_HINT as the teaching signal.
 * Returns { patch } or { error, _fixHint }.
 */
function sanitizeDesignPatch(args) {
    const bad = (message) => ({ error: message, _fixHint: DESIGN_HINT });
    if (!isPlainObject(args)) return bad('cms_update_design takes an object of patch fields.');
    const patch = {};

    if (args.preset !== undefined) {
        if (!THEME_PRESET_IDS.includes(args.preset)) {
            return bad(`preset ${JSON.stringify(args.preset ?? null)} is not a built-in theme. Known presets: ${THEME_PRESET_IDS.join(', ')}.`);
        }
        patch.preset = args.preset;
    }

    /** Colour group: every value a literal #rrggbb (some keys also allow ''). */
    const colourGroup = (raw, allowedKeys, path, blankable) => {
        if (!isPlainObject(raw)) return bad(`${path} must be an object of colour keys.`);
        const out = {};
        for (const [key, value] of Object.entries(raw)) {
            if (!allowedKeys.includes(key)) {
                return bad(`${path}.${key} is not a colour of this site. Valid keys: ${allowedKeys.join(', ')}.`);
            }
            const blankOk = value === '' && blankable.includes(key);
            if (!blankOk && (typeof value !== 'string' || !HEX_RE.test(value))) {
                return bad(`${path}.${key} ${JSON.stringify(value ?? null)} is not a "#rrggbb" hex colour.`);
            }
            out[key] = value;
        }
        return { out };
    };

    if (args.colorsPatch !== undefined) {
        const r = colourGroup(args.colorsPatch, COLOR_KEYS, 'colorsPatch', []);
        if (r.error) return r;
        if (Object.keys(r.out).length) patch.colors = r.out;
    }
    if (args.darkColorsPatch !== undefined) {
        const r = colourGroup(args.darkColorsPatch, DARK_COLOR_KEYS, 'darkColorsPatch', BLANKABLE_DARK_COLORS);
        if (r.error) return r;
        if (Object.keys(r.out).length) patch.darkColors = r.out;
    }

    if (args.fontsPatch !== undefined) {
        if (!isPlainObject(args.fontsPatch)) return bad('fontsPatch must be an object { heading?, body?, mono? }.');
        const fonts = {};
        for (const [role, value] of Object.entries(args.fontsPatch)) {
            if (!FONT_ROLES.includes(role)) {
                return bad(`fontsPatch.${role} is not a font role. Valid roles: ${FONT_ROLES.join(', ')}.`);
            }
            if (typeof value !== 'string' || !DESIGN_FONTS.includes(value)) {
                return bad(`fontsPatch.${role} ${JSON.stringify(value ?? null)} is not an available font — the site can only load the ${DESIGN_FONTS.length} faces in the library.`);
            }
            fonts[role] = value;
        }
        if (Object.keys(fonts).length) patch.fonts = fonts;
    }

    /** Enum group (typography / components / layout) — closed key + value set. */
    const enumGroup = (raw, enums, path) => {
        if (!isPlainObject(raw)) return bad(`${path} must be an object.`);
        const out = {};
        for (const [key, value] of Object.entries(raw)) {
            const allowed = enums[key];
            if (!allowed) {
                return bad(`${path}.${key} is not a field of ${path}. Valid fields: ${Object.keys(enums).join(', ')}.`);
            }
            if (!allowed.includes(value)) {
                return bad(`${path}.${key} ${JSON.stringify(value ?? null)} is not a legal value. Valid: ${allowed.join(', ')}.`);
            }
            out[key] = value;
        }
        return { out };
    };

    for (const [arg, enums, field] of [
        ['typographyPatch', TYPOGRAPHY_ENUMS, 'typography'],
        ['componentsPatch', DESIGN_COMPONENT_ENUMS, 'components'],
        ['layoutPatch', DESIGN_LAYOUT_ENUMS, 'layout'],
    ]) {
        if (args[arg] === undefined) continue;
        const r = enumGroup(args[arg], enums, arg);
        if (r.error) return r;
        if (Object.keys(r.out).length) patch[field] = r.out;
    }

    if (args.radius !== undefined) {
        if (typeof args.radius !== 'number' || !Number.isFinite(args.radius) || args.radius < 0 || args.radius > 24) {
            return bad(`radius ${JSON.stringify(args.radius ?? null)} is out of range — use a whole number from 0 to 24.`);
        }
        patch.radius = Math.round(args.radius);
    }
    if (args.theme !== undefined) {
        if (!DESIGN_THEMES.includes(args.theme)) {
            return bad(`theme ${JSON.stringify(args.theme ?? null)} is invalid. Valid: ${DESIGN_THEMES.join(', ')}.`);
        }
        patch.theme = args.theme;
    }
    if (args.motion !== undefined) {
        if (!DESIGN_MOTIONS.includes(args.motion)) {
            return bad(`motion ${JSON.stringify(args.motion ?? null)} is invalid. Valid: ${DESIGN_MOTIONS.join(', ')}.`);
        }
        patch.motion = args.motion;
    }
    for (const flag of ['grain', 'gradient']) {
        if (args[flag] === undefined) continue;
        if (typeof args[flag] !== 'boolean') return bad(`${flag} must be true or false.`);
        patch[flag] = args[flag];
    }

    if (!Object.keys(patch).length) {
        return bad('Nothing to change — pass at least one of: preset, colorsPatch, darkColorsPatch, fontsPatch, typographyPatch, componentsPatch, layoutPatch, radius, theme, motion, grain, gradient.');
    }
    return { patch };
}

async function applyUpdateDesign(draftWrap, args) {
    const sanitized = sanitizeDesignPatch(args);
    if (sanitized.error) return sanitized;
    // Re-read the SiteDoc IMMEDIATELY before the write. draftWrap.site is
    // loaded once at turn start and only refreshed after an earlier
    // site-index tool, so it can be minutes stale by the time the model
    // calls this — and setProject rewrites the WHOLE doc (name, pages
    // index, homepageId, chrome, design, analytics) with no CAS. Without
    // this refresh, a concurrent edit by another admin (sessions are
    // site-scoped and shared) would be silently reverted and any page they
    // created mid-turn would be dropped from the index. Every sibling tool
    // gets this for free by re-reading inside the store at call time.
    await refreshSite(draftWrap);
    if (!isPlainObject(draftWrap.site)) {
        return { error: 'No site loaded — reload the builder.' };
    }
    const site = clone(draftWrap.site);
    let design = isPlainObject(site.design) ? clone(site.design) : {};
    const { preset, ...groups } = sanitized.patch;

    // A preset MATERIALIZES its concrete values first (the renderer never
    // looks a preset up), mirroring applyPreset() on the client: nested
    // groups are re-cloned wholesale so nothing leaks from the old theme,
    // and the uploaded logo/favicon are kept.
    if (preset) {
        const entry = THEME_PRESETS.find((p) => p.id === preset);
        design = { ...design, ...clone(entry.design), logo: design.logo || '', favicon: design.favicon || '', preset };
    }
    // Then the explicit patches layer on top, DEEP-MERGED per group so
    // { colorsPatch:{primary} } keeps the other six colours.
    for (const [key, value] of Object.entries(groups)) {
        design[key] = isPlainObject(value) && isPlainObject(design[key])
            ? { ...design[key], ...value }
            : value;
    }
    site.design = design;

    try {
        await cmsStore.setProject(draftWrap.siteId, site);
    } catch (e) {
        return { error: e.message };
    }
    await refreshSite(draftWrap);
    // CRITICAL: report what was PERSISTED, never the request. sanitizeDesign
    // coerces silently, so echoing the patch back would tell the model an
    // edit succeeded that the store had already dropped.
    const saved = isPlainObject(draftWrap.site?.design) ? draftWrap.site.design : design;
    return { design: clone(saved), summary: summariseDesign(saved) };
}

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
    _test: { deepMerge, validateStylePatch, resolveInsertIndex, summariseDesign, sanitizeHeaderNav, sanitizeDesignPatch },
};
