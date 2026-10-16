// @typecheck
'use strict';
/**
 * Resized WebP variants of uploaded CMS images, for `srcset` on the public
 * site. A phone used to download the full-size original of every image.
 *
 * `GET /api/cms/asset/cms/<key>?w=640` answers the image scaled DOWN to 640 px
 * wide (never enlarged) as WebP. Only widths from {@link VARIANT_WIDTHS} are
 * honoured, so the query string cannot be used to make the server render an
 * unbounded number of variants. The route is public, so rendering is bounded:
 * a pixel limit, a source-size cap, two concurrent renders (the rest get the
 * original), one render per key and width at a time, and failures are
 * remembered. Animated images, SVG, video and anything that
 * is not JPEG/PNG/WebP are served as stored. Uploaded keys are never
 * overwritten, so a variant is as immutable as its source.
 */

const VARIANT_WIDTHS = [320, 640, 960, 1280, 1920];
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** Sources above this are served as stored (they are buffered to resize). */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40e6;
const MAX_CONCURRENT = 2;
const NEGATIVE_MAX = 500;

/** @type {Map<string, Buffer>} insertion order = least recently used first */
const cache = new Map();
let cacheBytes = 0;
/** ids that cannot or need not be resized (animated, small, undecodable) */
const negative = new Set();
/** @type {Map<string, Promise<Buffer | null>>} */
const inflight = new Map();
let running = 0;

/**
 * @param {unknown} raw the `w` query value
 * @returns {number | null} an allowed width, or null for "serve the original"
 */
function parseVariantWidth(raw) {
    if (typeof raw !== 'string' || !/^\d{2,4}$/.test(raw)) return null;
    const w = Number(raw);
    return VARIANT_WIDTHS.includes(w) ? w : null;
}

/** @param {string | undefined} contentType */
function isResizable(contentType) {
    return RESIZABLE_TYPES.has(String(contentType || '').split(';')[0].trim().toLowerCase());
}

/** @param {string} id @param {Buffer} buf */
function remember(id, buf) {
    if (buf.length > CACHE_MAX_BYTES / 4) return;
    cache.set(id, buf);
    cacheBytes += buf.length;
    for (const [k, v] of cache) {
        if (cacheBytes <= CACHE_MAX_BYTES) break;
        cache.delete(k);
        cacheBytes -= v.length;
    }
}

/** @param {string} id */
function forget(id) {
    if (negative.size >= NEGATIVE_MAX) negative.clear();
    negative.add(id);
}

/** @param {Buffer} source @param {number} width @returns {Promise<Buffer | null>} */
async function resize(source, width) {
    const sharp = require('sharp');
    const opts = { limitInputPixels: MAX_INPUT_PIXELS, failOn: /** @type {'error'} */ ('error') };
    const meta = await sharp(source, opts).metadata();
    // Animated, or already no wider than asked: nothing to gain.
    if ((meta.pages || 1) > 1 || !meta.width || meta.width <= width) return null;
    const out = await sharp(source, opts)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    return out.length < source.length ? out : null;
}

/**
 * @param {string} cacheKey identity of the stored bytes (key plus version)
 * @param {Buffer} source the stored bytes
 * @param {number} width an allowed width
 * @returns {Promise<Buffer | null>} WebP bytes, or null when the original
 *   should be served (not resizable, too big, busy, failed)
 */
async function renderVariant(cacheKey, source, width) {
    const id = `${cacheKey}@${width}`;
    const hit = cache.get(id);
    if (hit) {
        cache.delete(id);
        cache.set(id, hit);
        return hit;
    }
    if (negative.has(id) || source.length > MAX_SOURCE_BYTES) return null;
    const pending = inflight.get(id);
    if (pending) return pending;
    if (running >= MAX_CONCURRENT) return null;
    running++;
    const job = resize(source, width)
        .then((out) => {
            if (out) remember(id, out); else forget(id);
            return out;
        })
        .catch(() => { forget(id); return null; })
        .finally(() => { running--; inflight.delete(id); });
    inflight.set(id, job);
    return job;
}

module.exports = { VARIANT_WIDTHS, MAX_SOURCE_BYTES, parseVariantWidth, isResizable, renderVariant };
