// @typecheck
/**
 * Inline internally-hosted images into the outgoing prompt.
 *
 * Uploaded images are stored in RustFS and referenced in the prompt by a
 * 15-minute HMAC-signed URL on our OWN origin (directChat.js /
 * attachmentProcessor.js / historyHydrator.js). That only works if the model
 * provider can actually fetch that URL — and it generally cannot:
 *
 *   • Anthropic's image fetcher honours robots.txt, and ours carries
 *     `Disallow: /api/` (core/seo/sitemap.js). Every screenshot upload came
 *     back as HTTP 400 "This URL is disallowed by the website's robots.txt
 *     file" — and because it is a request-level 400, the whole turn failed,
 *     not just the image. Non-production hosts serve `Disallow: /`, so there
 *     the failure is total.
 *   • Self-hosted installs are usually not reachable from the internet at all.
 *   • Gemini's fileData accepts only File API / YouTube URIs, never an
 *     arbitrary https URL.
 *
 * So we read the bytes back out of storage ourselves and hand the provider a
 * data: URL. This costs bandwidth inside our own network but not one extra
 * token: image cost is computed from the pixel dimensions, never from the
 * base64 length. It also stabilises the prompt prefix — a freshly signed URL
 * on every turn used to bust the cache breakpoint directChat sets on the last
 * attachment block.
 *
 * Authorization: only URLs carrying a VALID, unexpired signature are resolved.
 * Reading straight from storage bypasses the /api/storage/tmp route, so the
 * signature check has to be repeated here — otherwise a crafted image_url
 * block in a client-supplied message would become a read-anything-in-the-
 * bucket primitive. Externally-hosted images (a URL the user pasted) are left
 * untouched; fetching those is the provider's job.
 */

// Read cap. Anthropic rejects images over ~5 MB, but downscaling happens later
// (core/imageDownscale.js) so the cap here only needs to stop a pathological
// object from being buffered into memory.
const log = require('../../telemetry/log');
const MAX_INLINE_BYTES = 25 * 1024 * 1024;

// The four types every vision provider we support accepts.
const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MEDIA_TYPE_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
};

const PLACEHOLDER = '[Attached image unavailable — it could not be read back from storage]';

function urlOf(part) {
    const img = part?.image_url;
    if (typeof img === 'string') return img;
    return (img && typeof img.url === 'string') ? img.url : '';
}

function isInternalImageUrl(url) {
    return typeof url === 'string' && url.includes('/api/storage/tmp/');
}

// Content types that carry no information — local-disk mode has no sidecar for
// older objects and S3 defaults to octet-stream when the uploader omitted one.
const GENERIC_CONTENT_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * Content-Type wins; the key's extension is only consulted when the stored type
 * says nothing. A concrete non-image type (application/pdf, image/svg+xml, …)
 * is a rejection, never something the extension can talk us out of.
 * null → not an image we can ship.
 */
function pickMediaType(contentType, key) {
    const ct = (contentType || '').split(';')[0].trim().toLowerCase();
    if (SUPPORTED_MEDIA_TYPES.has(ct)) return ct;
    if (ct === 'image/jpg') return 'image/jpeg';
    if (!GENERIC_CONTENT_TYPES.has(ct)) return null;
    const dot = key.lastIndexOf('.');
    if (dot === -1) return null;
    return MEDIA_TYPE_BY_EXT[key.slice(dot).toLowerCase()] || null;
}

/** Read one storage object into a data: URL, or null if it can't be shipped. */
async function readAsDataUrl(key) {
    const storageStore = require('../../stores/storageStore');
    if (!storageStore.isAvailable()) return null;

    const { stream, contentType, contentLength } = await storageStore.streamFile(key);
    if (contentLength && contentLength > MAX_INLINE_BYTES) {
        stream.destroy?.();
        log.warn(`[ImageInline] ${key} exceeds the ${MAX_INLINE_BYTES} byte inline cap`);
        return null;
    }
    const mediaType = pickMediaType(contentType, key);
    if (!mediaType) {
        stream.destroy?.();
        log.warn(`[ImageInline] ${key} has unsupported content type "${contentType}"`);
        return null;
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        if (total > MAX_INLINE_BYTES) {
            stream.destroy?.();
            log.warn(`[ImageInline] ${key} exceeded the inline cap mid-stream`);
            return null;
        }
        chunks.push(chunk);
    }
    return `data:${mediaType};base64,${Buffer.concat(chunks).toString('base64')}`;
}

/**
 * Copy-on-write rewrite of OpenAI-shaped messages: every `image_url` block
 * pointing at one of our signed temp URLs becomes an inline data: URL. Blocks
 * that can't be resolved degrade to a short text note rather than staying a
 * URL the provider will choke on.
 *
 * The input array is never mutated — callers persist these messages, and
 * writing megabytes of base64 back into conversation history would be a bug.
 *
 * @param {Array} messages - chat messages (content: string | block array)
 * @returns {Promise<Array>} the same array when nothing changed, else a copy
 */
async function inlineInternalImages(messages) {
    if (!Array.isArray(messages)) return messages;

    const hasInternal = messages.some(m => Array.isArray(m?.content)
        && m.content.some(p => p?.type === 'image_url' && isInternalImageUrl(urlOf(p))));
    if (!hasInternal) return messages;

    const { resolveTempDownloadKey } = require('../../utils/tempDownloadUrl');
    // One read per object, even when the same image appears in several turns.
    const cache = new Map();
    let inlined = 0;
    let failed = 0;

    const resolve = async (url) => {
        const key = resolveTempDownloadKey(url);
        if (!key) {
            log.warn('[ImageInline] refusing to inline an unsigned/expired storage URL');
            return null;
        }
        if (cache.has(key)) return cache.get(key);
        let dataUrl = null;
        try {
            dataUrl = await readAsDataUrl(key);
        } catch (err) {
            log.warn(`[ImageInline] failed to read ${key}: ${err.message}`);
        }
        cache.set(key, dataUrl);
        return dataUrl;
    };

    const out = [];
    for (const msg of messages) {
        if (!Array.isArray(msg?.content)
            || !msg.content.some(p => p?.type === 'image_url' && isInternalImageUrl(urlOf(p)))) {
            out.push(msg);
            continue;
        }
        const content = [];
        for (const part of msg.content) {
            if (part?.type !== 'image_url' || !isInternalImageUrl(urlOf(part))) {
                content.push(part);
                continue;
            }
            const dataUrl = await resolve(urlOf(part));
            if (dataUrl) {
                const img = typeof part.image_url === 'string' ? {} : { ...part.image_url };
                content.push({ ...part, image_url: { ...img, url: dataUrl } });
                inlined++;
            } else {
                content.push({ type: 'text', text: PLACEHOLDER });
                failed++;
            }
        }
        out.push({ ...msg, content });
    }

    if (inlined) log.info(`[ImageInline] inlined ${inlined} stored image(s) as base64`);
    if (failed) log.warn(`[ImageInline] ${failed} image(s) replaced with a placeholder`);
    return out;
}

module.exports = { inlineInternalImages, readAsDataUrl, MAX_INLINE_BYTES, PLACEHOLDER };
