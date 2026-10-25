// @typecheck
// Customer stories: the cards of the "Customer stories" grid.
//
// A story is an ordinary CMS page that carries a `story-header` block, so it
// has everything a page has (own slug, SEO, translations, sitemap entry,
// publish snapshot) without a second content type to store, export and
// translate. This module only READS: it scans the last PUBLISHED snapshot for
// such pages and turns each header into a card. Nothing here ever looks at a
// draft, so an unpublished story can not reach a visitor through the grid.
//
// Card = an explicit allow-list of header fields (never the block object
// itself), so a field added to the block next year is not published by this
// endpoint until someone decides it should be.

const { isPlainObject, mergeLocaleContent } = require('./shared');
const { getPublishedSnapshot } = require('./publishing');
const { getDefaultLocale } = require('./localeOverrides');
const { hasTranslation } = require('../../core/seo/locales');
const { STORY_METRICS_MAX, STORY_GRID_MAX } = require('../../i18n/defaults/cmsDefaults');
const log = require('../../telemetry/log');

const STORY_BLOCK = 'story-header';
const GRID_BLOCK = 'customer-stories';
/** Pages inspected per request: a site is a few dozen pages, never thousands. */
const MAX_SCANNED_PAGES = 500;
/** Locale prefixes the public site serves (mirrors LOCALE_PREFIXES in core/seo/publicPath.js). */
const URL_LOCALES = new Set(['nl']);

/** @typedef {{ stat: string, label: string }} StoryMetric */
/** @typedef {{ src: string, srcDark: string, alt: string }} StoryLogo */
/**
 * @typedef {object} StoryCard
 * @property {string} id         page id
 * @property {string} slug
 * @property {string} href       path of the story page, with the locale prefix when it is translated
 * @property {string} customer
 * @property {string} sector
 * @property {string} sectorId   URL form of the sector, the key of the filter
 * @property {string} title
 * @property {string} lead
 * @property {StoryLogo} logo
 * @property {string} quote
 * @property {string} quoteBy
 * @property {StoryMetric[]} metrics
 */

/** @param {unknown} v @param {number} max */
function str(v, max) {
    return typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max) : '';
}

/**
 * The URL form of a sector: lowercase ASCII letters, digits and single dashes.
 * @param {string} raw
 */
function sectorSlug(raw) {
    return String(raw || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

/**
 * Only an own-site CMS asset or an https URL may be a logo source; anything
 * else (javascript:, data:, protocol-relative, traversal) is dropped.
 * @param {unknown} v
 */
function mediaRef(v) {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    if (!s || s.length > 2048 || s.includes('..') || /[\s<>"'`\\]/.test(s)) return '';
    if (s.startsWith('cms/') || s.startsWith('/api/cms/asset/cms/')) return s;
    return /^https:\/\/[a-z0-9.-]+(?::\d+)?\//i.test(s) ? s : '';
}

/**
 * @param {unknown} blocks
 * @returns {Record<string, any> | null} the first enabled story-header block
 */
function findStoryHeader(blocks) {
    if (!Array.isArray(blocks)) return null;
    return blocks.find((b) => isPlainObject(b) && b.type === STORY_BLOCK && b.enabled !== false) || null;
}

/**
 * The card of one story page, from the (already locale-merged) header block.
 * Returns null for a header with neither customer nor title: nothing to show.
 * @param {{ id: string, slug: string, title?: string }} page
 * @param {Record<string, any>} header   the story-header block
 * @param {string} href
 * @param {string} [sectorId]  the filter key; given from the DEFAULT-language header so it never changes per language
 * @returns {StoryCard | null}
 */
function storyCard(page, header, href, sectorId) {
    const c = isPlainObject(header.content) ? header.content : {};
    const customer = str(c.customer, 120);
    const title = str(c.title, 300) || str(page.title, 300);
    if (!customer && !title) return null;
    const sector = str(c.sector, 80);
    const logo = isPlainObject(c.logo) ? c.logo : {};
    const metrics = (Array.isArray(c.metrics) ? c.metrics : [])
        .filter(isPlainObject)
        .map((m) => ({ stat: str(m.stat, 40), label: str(m.label, 120) }))
        .filter((m) => m.stat || m.label)
        .slice(0, STORY_METRICS_MAX);
    return {
        id: page.id,
        slug: page.slug,
        href,
        customer,
        sector,
        sectorId: sectorId ?? sectorSlug(sector),
        title,
        lead: str(c.lead, 600),
        logo: { src: mediaRef(logo.src), srcDark: mediaRef(logo.srcDark), alt: str(logo.alt, 200) || customer },
        quote: str(c.quote, 600),
        quoteBy: str(c.quoteBy, 160),
        metrics,
    };
}

/**
 * Locale-merge one page's blocks the way effective.js does (an override
 * patches block content by block id, text only).
 * @param {Record<string, any>[]} blocks
 * @param {Record<string, any> | null | undefined} override
 */
function localizeBlocks(blocks, override) {
    const patches = isPlainObject(override) && isPlainObject(override.blocks) ? override.blocks : null;
    if (!patches) return blocks;
    return blocks.map((b) => {
        const ov = patches[b.id];
        return isPlainObject(ov) ? { ...b, content: mergeLocaleContent(b.content, ov.content || {}) } : b;
    });
}

/**
 * The stories of the live site as last published, in the site's page order.
 *
 * @param {string} siteId
 * @param {{ locale?: string, limit?: number, sector?: string }} [opts]
 * @returns {Promise<{ stories: StoryCard[], locale: string, defaultLocale: string }>}
 */
async function getPublishedStories(siteId, { locale, limit = STORY_GRID_MAX, sector = '' } = {}) {
    const defaultLocale = await getDefaultLocale();
    const loc = String(locale || defaultLocale).toLowerCase().split('-')[0];
    const empty = { stories: [], locale: loc, defaultLocale };
    const snap = await getPublishedSnapshot(siteId);
    if (!snap || !isPlainObject(snap.site) || !Array.isArray(snap.site.pages)) return empty;

    const docs = isPlainObject(snap.pages) ? snap.pages : {};
    const overrides = isPlainObject(snap.pageLocaleOverrides) ? snap.pageLocaleOverrides : {};
    const wantedSector = sectorSlug(sector);
    const cap = Math.min(STORY_GRID_MAX, Math.max(1, Math.floor(Number(limit)) || STORY_GRID_MAX));
    const translated = loc !== defaultLocale;

    /** @type {StoryCard[]} */
    const stories = [];
    for (const entry of snap.site.pages.slice(0, MAX_SCANNED_PAGES)) {
        if (stories.length >= cap) break;
        const doc = docs[entry?.id];
        if (!entry || !isPlainObject(doc) || entry.isHomepage || entry.isNotFound || !findStoryHeader(doc.blocks)) continue;
        // A noindex page is kept out of search on purpose: no card (and no link) for it either.
        if (isPlainObject(doc.seo) && doc.seo.noIndex === true) continue;
        const override = translated ? overrides[entry.id]?.[loc] : null;
        const header = findStoryHeader(localizeBlocks(doc.blocks, override));
        // The filter key comes from the default-language sector: the visible
        // label translates, the key (and ?sector=) must not change per language.
        const sourceHeader = findStoryHeader(doc.blocks);
        const sectorId = sectorSlug(sourceHeader?.content?.sector);
        // Same rule as publicRender / the sitemap: an empty override shell is no
        // translation, and /nl/<slug> of an untranslated page redirects away.
        const prefix = hasTranslation(override) && URL_LOCALES.has(loc) ? `/${loc}` : '';
        const card = header && storyCard({ id: entry.id, slug: entry.slug, title: doc.title }, header, `${prefix}/${entry.slug}`, sectorId);
        if (!card || (wantedSector && card.sectorId !== wantedSector)) continue;
        stories.push(card);
    }
    return { stories, locale: loc, defaultLocale };
}

/**
 * Fill every enabled `customer-stories` block of a served page with its cards
 * (`content.items`), for the server-rendered HTML. Mutates the blocks it is
 * given (the caller owns a per-request copy). Never throws: a failure leaves
 * the block as stored, and the browser then fetches the cards itself.
 *
 * @param {string} siteId
 * @param {{ blocks?: Record<string, any>[] } | null | undefined} page
 * @param {string} locale
 */
async function fillCustomerStories(siteId, page, locale) {
    const grids = (page?.blocks || []).filter((b) => b && b.type === GRID_BLOCK && b.enabled !== false);
    if (!grids.length) return;
    try {
        for (const block of grids) {
            const c = isPlainObject(block.content) ? block.content : {};
            const { stories } = await getPublishedStories(siteId, {
                locale, limit: Number(c.limit) || undefined, sector: typeof c.sectorId === 'string' ? c.sectorId : '',
            });
            // The walker in core/seo/renderBlocks.js turns a pure { label, href }
            // object into a real <a>: that is how the card's link reaches crawlers.
            block.content = { ...c, items: stories.map((s) => ({ ...s, cta: { label: s.title || s.customer, href: s.href } })) };
        }
    } catch (err) {
        log.warn('[CMS] customer stories could not be inlined:', err instanceof Error ? /** @type {Error} */ (err).message : String(err));
    }
}

module.exports = {
    STORY_BLOCK, GRID_BLOCK, sectorSlug, findStoryHeader, storyCard, getPublishedStories, fillCustomerStories,
};
