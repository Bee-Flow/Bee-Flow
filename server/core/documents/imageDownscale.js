// @typecheck
/**
 * Image downscaling for LLM requests.
 *
 * Anthropic caps images two ways, and BOTH of them fail the whole request.
 *
 *   Dimensions — max 2000 pixels per side in a many-image request. One
 *   oversized image 400s everything, and because SSE headers are already
 *   flushed the browser sees ERR_INCOMPLETE_CHUNKED_ENCODING.
 *
 *   Bytes — the request as a whole has a size limit, and pixels are a poor
 *   proxy for it. Seven phone photos of a meter cupboard, each already inside
 *   2000px, came to well over twenty megabytes as PNG and were answered with
 *   413 request_too_large. A camera image has no business being PNG at all:
 *   it is lossless encoding of sensor noise. So an image that is still heavy
 *   after resizing is re-encoded as JPEG, and the batch carries a budget so
 *   that N images cannot collectively blow a limit no single one of them
 *   crosses.
 *
 * This module walks an array of Claude-shaped messages and downscales any
 * base64-encoded `image` content block whose longest side exceeds the cap,
 * preserving aspect ratio and the original media_type. URL-source images are
 * left untouched (we don't pay the bandwidth to fetch + re-host).
 *
 * Uses `sharp`. If sharp is unavailable for any reason, the original block is
 * returned unchanged — the request may still fail upstream, but we never block
 * the conversation on a missing dep.
 */
const log = require('../../telemetry/log');

const MAX_DIM = 2000;
const MIN_RESIZE_TRIGGER = MAX_DIM + 1;
// Per image, encoded. A 2000px UI screenshot lands well under this; a camera
// photo saved as PNG lands far over it, which is exactly the split we want —
// re-encoding a screenshot as JPEG would ring around its text for nothing.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
// For the whole request. Deliberately far below Anthropic's own ceiling: the
// text, the schema and the reply all have to fit alongside the pictures.
const MAX_REQUEST_IMAGE_BYTES = 16 * 1024 * 1024;
// When `sharp` can't be loaded we can't measure dimensions — fall back to a
// rough byte-size heuristic and drop any block whose decoded base64 is
// suspiciously large. A clean 2000×2000 PNG is ~1–3 MB; anything > 2 MB likely
// exceeds the dimension cap. Better to lose one image's content than have
// Anthropic 400 the whole request mid-stream.
const FALLBACK_SIZE_HEURISTIC_BYTES = 2 * 1024 * 1024;

let _sharp = null;
let _sharpProbed = false;
function loadSharp() {
    if (_sharpProbed) return _sharp;
    _sharpProbed = true;
    try { _sharp = require('sharp'); }
    catch (e) {
        log.warn('[ImageDownscale] sharp unavailable — large images will reach the API unmodified:', e.message);
        _sharp = null;
    }
    return _sharp;
}

async function shrinkOne(b64, mediaType) {
    const sharp = loadSharp();
    if (!sharp) return null;
    const buf = Buffer.from(b64, 'base64');
    try {
        const meta = await sharp(buf, { failOn: 'none' }).metadata();
        const w = meta.width || 0;
        const h = meta.height || 0;
        // Either reason is enough to touch the image. Measuring only pixels
        // let a 1900x1900 PNG of six megabytes through untouched.
        const oversized = w >= MIN_RESIZE_TRIGGER || h >= MIN_RESIZE_TRIGGER;
        const heavy = buf.length > MAX_IMAGE_BYTES;
        if (!oversized && !heavy) return null; // no-op
        const longest = Math.max(w, h) || MAX_DIM;
        const ratio = Math.min(1, MAX_DIM / longest);
        const newW = Math.max(1, Math.round(w * ratio)) || undefined;
        const newH = Math.max(1, Math.round(h * ratio)) || undefined;

        // Pick output encoder that matches input mediaType so we don't break
        // Claude's expectation. Default to PNG when format is exotic.
        let pipeline = sharp(buf, { failOn: 'none' }).rotate().resize({
            width: newW,
            height: newH,
            fit: 'inside',
            withoutEnlargement: true,
        });

        const mt = (mediaType || '').toLowerCase();
        let outMime;  // reassigned by the JPEG fallback below
        if (mt.includes('jpeg') || mt.includes('jpg')) {
            pipeline = pipeline.jpeg({ quality: 85 });
            outMime = 'image/jpeg';
        } else if (mt.includes('webp')) {
            pipeline = pipeline.webp({ quality: 85 });
            outMime = 'image/webp';
        } else if (mt.includes('gif')) {
            // sharp can't write GIF in all builds — fall through to PNG.
            pipeline = pipeline.png();
            outMime = 'image/png';
        } else {
            pipeline = pipeline.png();
            outMime = 'image/png';
        }

        let out = await pipeline.toBuffer();

        // Still heavy, and not already a lossy format: the content is
        // photographic and PNG is the wrong container for it. Flatten onto
        // white first — JPEG has no alpha, and a transparent PNG would
        // otherwise composite onto black.
        if (out.length > MAX_IMAGE_BYTES && outMime !== 'image/jpeg' && outMime !== 'image/webp') {
            try {
                out = await sharp(buf, { failOn: 'none' })
                    .rotate()
                    .resize({ width: newW, height: newH, fit: 'inside', withoutEnlargement: true })
                    .flatten({ background: '#ffffff' })
                    .jpeg({ quality: 82 })
                    .toBuffer();
                outMime = 'image/jpeg';
            } catch (err) {
                log.warn('[ImageDownscale] JPEG re-encode failed, keeping original encoding:', err.message);
            }
        }

        return {
            base64: out.toString('base64'),
            mediaType: outMime,
            bytes: out.length,
            originalDims: { w, h },
            newDims: { w: newW || w, h: newH || h },
        };
    } catch (err) {
        log.warn('[ImageDownscale] failed to shrink image:', err.message);
        return null;
    }
}

/**
 * In-place rewrite. Walks Claude messages, finds image blocks with
 * source.type === 'base64', and downscales any whose dimensions exceed
 * MAX_DIM. Mutates and also returns the input array for convenience.
 */
async function downscaleClaudeMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    const sharpAvailable = !!loadSharp();
    let touched = 0;
    let dropped = 0;
    let usedBytes = 0;
    for (const msg of messages) {
        if (!msg || !Array.isArray(msg.content)) continue;
        for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (!block || block.type !== 'image') continue;
            const src = block.source;
            if (!src || src.type !== 'base64' || !src.data) continue;

            if (!sharpAvailable) {
                // No sharp → can't measure or shrink. Estimate decoded byte
                // size from the base64 length (base64 is 4/3 the raw size)
                // and drop any block over the heuristic to keep the request
                // from 400-ing on dimension limits.
                const approxBytes = Math.floor(src.data.length * 3 / 4);
                if (approxBytes > FALLBACK_SIZE_HEURISTIC_BYTES) {
                    msg.content[i] = {
                        type: 'text',
                        text: '[image omitted — server image processor unavailable, image too large to ship as-is]',
                    };
                    dropped++;
                }
                continue;
            }

            const shrunk = await shrinkOne(src.data, src.media_type);
            if (shrunk) {
                block.source = { type: 'base64', media_type: shrunk.mediaType, data: shrunk.base64 };
                touched++;
                log.info(`[ImageDownscale] resized ${shrunk.originalDims.w}x${shrunk.originalDims.h} → ${shrunk.newDims.w}x${shrunk.newDims.h} (${src.media_type} → ${shrunk.mediaType}, ${Math.round(shrunk.bytes / 1024)} KB)`);
            }

            // The budget is per REQUEST, because that is what the API weighs.
            // Every image so far is inside the per-image cap and the request
            // can still be too large; when it is, say so in the transcript
            // rather than dropping a picture the model is being asked about.
            const bytes = Buffer.byteLength(block.source.data, 'base64');
            if (usedBytes + bytes > MAX_REQUEST_IMAGE_BYTES) {
                msg.content[i] = {
                    type: 'text',
                    text: '[image omitted — the request had already reached its image size budget. Say so if the answer depends on this image.]',
                };
                dropped++;
                continue;
            }
            usedBytes += bytes;
        }
    }
    if (touched > 0) log.info(`[ImageDownscale] downscaled ${touched} oversized image(s)`);
    if (dropped > 0) log.warn(`[ImageDownscale] omitted ${dropped} image(s) — over the request budget or no image processor`);
    return messages;
}

module.exports = { downscaleClaudeMessages, MAX_DIM, MAX_IMAGE_BYTES, MAX_REQUEST_IMAGE_BYTES };
