// @typecheck
// PageDoc storage: one page record in, one page record out, plus the block
// normalizer that decides which blocks survive a save and reports what it
// had to drop.

const configStore = require('../configStore');
const { getAll } = require('../../db');
const { BLOCK_DEFAULTS, BLOCK_TYPE_IDS } = require('../../i18n/defaults/cmsDefaults');
const {
    PAGE_VERSION, KEY_LOCALE_INFIX,
    newId, isPlainObject, clone, normalizeSlug, assertSiteId, pageKey,
} = require('./shared');

// ── Pages ────────────────────────────────────────────────────────────

function emptyPage({ id, slug, title }) {
    return {
        version: PAGE_VERSION,
        id,
        slug,
        title: title || '',
        seo: { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false },
        blocks: [],
    };
}

function makeBlock(type, contentOverride) {
    if (!BLOCK_TYPE_IDS.includes(type)) throw new Error(`Unknown block type: ${type}`);
    return {
        id: newId('blk'),
        type,
        enabled: true,
        content: contentOverride !== undefined
            ? contentOverride
            : clone(BLOCK_DEFAULTS[type]),
        style: {},
    };
}

async function getPage(siteId, pageId, { fresh = false } = {}) {
    assertSiteId(siteId);
    const read = fresh ? configStore.getConfigFresh : configStore.getConfig;
    const v = await read(pageKey(siteId, pageId));
    return isPlainObject(v) ? v : null;
}

async function setPage(siteId, page) {
    assertSiteId(siteId);
    if (!isPlainObject(page) || !page.id) throw new Error('page.id required');
    const { blocks, dropped } = sanitizeBlocks(Array.isArray(page.blocks) ? page.blocks : []);
    const sanitized = {
        version: PAGE_VERSION,
        id: String(page.id),
        slug: normalizeSlug(page.slug || ''),
        title: typeof page.title === 'string' ? page.title : '',
        seo: isPlainObject(page.seo) ? {
            metaTitle:       typeof page.seo.metaTitle === 'string' ? page.seo.metaTitle : '',
            metaDescription: typeof page.seo.metaDescription === 'string' ? page.seo.metaDescription : '',
            ogImage:         typeof page.seo.ogImage === 'string' ? page.seo.ogImage : '',
            noIndex:         !!page.seo.noIndex,
        } : { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false },
        blocks,
    };
    await configStore.setConfig(pageKey(siteId, sanitized.id), sanitized);
    // Return the dropped blocks alongside the saved page so callers can warn
    // the user (the render + persist layers otherwise discard unknown-type
    // blocks silently — the "import → empty page, no error" failure mode).
    return { page: sanitized, dropped };
}

// Forgiving aliases for casing/spelling variants of our block type strings —
// mirrors agent-hub/src/components/admin/ProductWebsite/blockSchema.js so client
// import and server persist agree on which blocks survive.
const BLOCK_TYPE_ALIASES = {
    'social-proof': 'socialProof', socialproof: 'socialProof',
    'tech-stats': 'techStats', techstats: 'techStats', stats: 'techStats',
    mediatext: 'media-text', media_text: 'media-text',
    ctabanner: 'cta-banner', cta_banner: 'cta-banner',
    livecomponent: 'live-component', live_component: 'live-component',
    customersupport: 'customer-support', customer_support: 'customer-support',
    'call-to-action': 'cta', calltoaction: 'cta',
    testimonial: 'testimonials', faqs: 'faq',
    trustband: 'trust-band', trust_band: 'trust-band',
};
const BLOCK_STRUCTURAL_KEYS = new Set(['id', 'type', 'enabled', 'content', 'style', 'meta', 'version']);

// Normalize one raw block toward { id, type, enabled, content, style }.
// Returns { block, dropped }; dropped is { index, type, reason } when the block
// can't be rendered/persisted (not-an-object / missing-type / unknown-type).
function normalizeBlockRecord(block, index) {
    if (!isPlainObject(block)) return { block: null, dropped: { index, type: null, reason: 'not-an-object' } };
    const rawType = block.type;
    if (typeof rawType !== 'string' || !rawType.trim()) {
        return { block: null, dropped: { index, type: null, reason: 'missing-type' } };
    }
    let type = rawType.trim();
    if (!BLOCK_TYPE_IDS.includes(type)) {
        const aliased = BLOCK_TYPE_ALIASES[type] || BLOCK_TYPE_ALIASES[type.toLowerCase()];
        if (aliased && BLOCK_TYPE_IDS.includes(aliased)) type = aliased;
        else return { block: null, dropped: { index, type: rawType, reason: 'unknown-type' } };
    }
    const id = (typeof block.id === 'string' && block.id.trim()) ? String(block.id) : newId('blk');
    let content;
    if (isPlainObject(block.content)) {
        content = block.content;
    } else {
        // "Fields at top level" near-miss — wrap non-structural keys into
        // content so the block renders instead of coming up blank.
        const topLevel = {};
        for (const k of Object.keys(block)) if (!BLOCK_STRUCTURAL_KEYS.has(k)) topLevel[k] = block[k];
        content = Object.keys(topLevel).length ? topLevel : {};
    }
    return {
        block: {
            id,
            type,
            enabled: block.enabled !== false,
            content,
            style: isPlainObject(block.style) ? block.style : {},
        },
        dropped: null,
    };
}

// Batch variant — returns the survivors plus a list of what was dropped/why.
function sanitizeBlocks(blocks) {
    if (!Array.isArray(blocks)) return { blocks: [], dropped: [] };
    const out = [];
    const dropped = [];
    blocks.forEach((b, index) => {
        const res = normalizeBlockRecord(b, index);
        if (res.block) out.push(res.block);
        if (res.dropped) dropped.push(res.dropped);
    });
    return { blocks: out, dropped };
}

// Back-compat single-block wrapper (block-or-null).
function sanitizeBlock(block) {
    return normalizeBlockRecord(block, -1).block;
}

async function deletePage(siteId, pageId) {
    assertSiteId(siteId);
    await configStore.deleteConfig(pageKey(siteId, pageId));
    const rows = await getAll(
        `SELECT key FROM config WHERE key LIKE $1`,
        [`${pageKey(siteId, pageId)}${KEY_LOCALE_INFIX}%`]
    );
    for (const r of rows) await configStore.deleteConfig(r.key);
}

module.exports = {
    emptyPage, makeBlock, getPage, setPage,
    normalizeBlockRecord, sanitizeBlocks, sanitizeBlock, deletePage,
};
