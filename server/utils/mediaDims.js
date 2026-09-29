// @typecheck
/**
 * Intrinsic image dimensions for CMS media, resolved at publish time.
 *
 * WHY THIS EXISTS: no marketing <img> carried width/height, because the CMS
 * media model never stored any — so the browser reserved zero space and every
 * image download pushed the content below it. PageSpeed flags it directly
 * ("image elements do not have explicit width and height"), and it is one of
 * the page's layout-shift sources.
 *
 * WHY PUBLISH TIME: the editor only ever handles a URL string, so threading
 * dimensions through every media field in the admin would touch dozens of
 * call sites and still leave existing content dimensionless. The server, at
 * publish, has both the finished content tree and the asset bytes. Publishing
 * is rare (seconds don't matter), the draft stays untouched (the enrichment
 * lands in the published snapshot only), and content published before this
 * existed picks up dimensions on its next publish with no migration.
 *
 * Media objects are found structurally — anything with `kind: 'image'` and a
 * same-origin asset `src` — because block content is free-form and media
 * slots appear at many depths (block.media, items[].media, gallery arrays).
 * External URLs are skipped: we will not fetch third-party bytes at publish
 * time, and such images are rare enough to not matter for CLS.
 *
 * FAILURE POSTURE: enrichment is strictly best-effort. A missing asset, an
 * unreadable image or sharp failing to load must never make Publish fail —
 * the worst acceptable outcome is an image without dimensions, which is
 * exactly the status quo.
 */
const log = require('../telemetry/log');

const ASSET_URL_PREFIX = '/api/cms/asset/';

/** Extract the storage key from a media src, or null when it isn't ours. */
function assetKeyFromSrc(src) {
    if (typeof src !== 'string' || !src) return null;
    let s = src;
    if (s.startsWith(ASSET_URL_PREFIX)) s = s.slice(ASSET_URL_PREFIX.length);
    try { s = decodeURIComponent(s); } catch { /* keep raw */ }
    if (s.startsWith('cms/')) return s;
    return null;
}

function isMediaImage(o) {
    return o && typeof o === 'object' && !Array.isArray(o)
        && o.kind !== 'video'
        && typeof o.src === 'string' && o.src
        // The media shape always carries `frame` or `alt` alongside src —
        // this keeps the walk from mistaking e.g. a link object for media.
        && ('frame' in o || 'alt' in o || o.kind === 'image');
}

/**
 * Walk a content tree and set `width`/`height` on every image media object
 * that lacks them and whose src resolves to a CMS asset.
 *
 * @param {object|Array} tree   mutated in place (callers pass fresh clones)
 * @param {(key: string) => Promise<{width:number,height:number}|null>} probe
 * @returns {Promise<number>} how many media objects were enriched
 */
async function enrichMediaDims(tree, probe) {
    const jobs = [];
    const seen = new Set();

    const walk = (node) => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);

        // Only objects with NO dimension keys at all. Some content elements
        // carry an authored `height` with layout meaning (embed frames, the
        // live-component iframe) — an intrinsic-size write there would
        // change the page, and this walk exists to change nothing visible.
        if (isMediaImage(node) && node.width == null && node.height == null) {
            const key = assetKeyFromSrc(node.src);
            if (key) jobs.push({ node, key });
        }
        for (const v of Object.values(node)) walk(v);
    };
    walk(tree);

    let enriched = 0;
    const cache = new Map();
    for (const { node, key } of jobs) {
        try {
            if (!cache.has(key)) cache.set(key, await probe(key));
            const dims = cache.get(key);
            if (dims && dims.width > 0 && dims.height > 0) {
                node.width = Math.round(dims.width);
                node.height = Math.round(dims.height);
                enriched++;
            }
        } catch { /* best-effort — see header */ }
    }
    return enriched;
}

/**
 * Default probe: read the asset from storage and ask sharp.
 *
 * sharp is lazy-required so a platform where the native module fails to load
 * degrades to "no dimensions" instead of breaking every publish. SVG metadata
 * comes from the viewBox/width attributes, which our hand-written brand SVGs
 * all carry.
 */
function makeStorageProbe(storageStore) {
    let sharp = null;
    let sharpFailed = false;
    return async (key) => {
        if (sharpFailed) return null;
        if (!sharp) {
            try { sharp = require('sharp'); } catch (e) {
                sharpFailed = true;
                log.warn('[CMS] media dims disabled — sharp unavailable:', e.message);
                return null;
            }
        }
        try {
            // streamFile is the only body-reading API storageStore exposes
            // (the asset route streams too); buffer it — CMS assets are
            // screenshots and SVGs, not videos.
            const { stream } = await storageStore.streamFile(key);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const meta = await sharp(Buffer.concat(chunks)).metadata();
            return meta && meta.width && meta.height
                ? { width: meta.width, height: meta.height }
                : null;
        } catch {
            return null;
        }
    };
}

module.exports = { enrichMediaDims, makeStorageProbe, assetKeyFromSrc };
