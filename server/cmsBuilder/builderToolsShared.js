// @typecheck
const crypto = require('crypto');
const cmsStore = require('../stores/cmsStore');
const { BLOCK_TYPE_IDS } = require('../i18n/defaults/cmsDefaults');

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
    draftWrap.site = await cmsStore.getProject(draftWrap.siteId, { fresh: true });
}

/**
 * Apply `change` to the CURRENT stored PageDoc (not the per-turn cache copy)
 * and persist it through the store's sanitizer and revision check, so two
 * tool calls running in parallel on one page each keep the other's edit.
 * `change(doc)` gets a private copy, returns the page to save, may run again
 * on a newer version, and throws to abort.
 */
async function persistPage(draftWrap, pageId, change) {
    const { page, dropped } = await cmsStore.mutatePage(draftWrap.siteId, pageId, change);
    draftWrap.pages.set(page.id, page);
    draftWrap.touchedPageIds.add(page.id);
    return { page, dropped };
}

module.exports = { isPlainObject, clone, deepMerge, newId, newBlockId, pageIdsHint, blockIdsHint, typesHint, findIndexEntry, getPageDoc, refreshSite, persistPage };
