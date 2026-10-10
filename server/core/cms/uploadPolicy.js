/**
 * What the CMS accepts as an uploaded asset, in one place.
 *
 * The browser uploader (`routes/cms.js`, `routes/cmsMedia.js`) and the one-time
 * upload URLs of the CMS MCP server (`cms/mcp/`) must agree on the allowed types
 * and sizes, so both read these constants instead of keeping a copy each.
 * A second list would drift the first time a type is added.
 */

'use strict';

const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const CLIP_MAX_BYTES = 500 * 1024 * 1024;
const VTT_MAX_BYTES = 1024 * 1024;

// Images cover the hero/feature/logo case; gif + apng + webp cover animated
// graphics; mp4 + webm cover the "silent loop" video kind. SVG is accepted
// only after server-side sanitisation.
const UPLOAD_MIME_WHITELIST = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/apng',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
]);

const CLIP_MIME_WHITELIST = new Set(['video/mp4', 'video/webm']);

/** Captions are stored as text/vtt whatever the browser labelled them. */
const VTT_CONTENT_TYPE = 'text/vtt';

/**
 * The size ceiling for a content type, or null when the type is not accepted.
 * Clips (mp4/webm) go through the 500 MB multipart path, captions are capped at
 * 1 MB, every other type at 25 MB.
 * @param {string} contentType
 * @returns {number|null}
 */
function maxBytesFor(contentType) {
    const type = String(contentType || '').toLowerCase();
    if (CLIP_MIME_WHITELIST.has(type)) return CLIP_MAX_BYTES;
    if (type === VTT_CONTENT_TYPE) return VTT_MAX_BYTES;
    if (UPLOAD_MIME_WHITELIST.has(type)) return IMAGE_MAX_BYTES;
    return null;
}

module.exports = {
    IMAGE_MAX_BYTES, CLIP_MAX_BYTES, VTT_MAX_BYTES,
    UPLOAD_MIME_WHITELIST, CLIP_MIME_WHITELIST, VTT_CONTENT_TYPE,
    maxBytesFor,
};
