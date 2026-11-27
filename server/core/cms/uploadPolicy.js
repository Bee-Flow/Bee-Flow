// @typecheck strict
/**
 * What the CMS accepts as an uploaded asset, in one place.
 *
 * The browser uploader (`routes/cms.js`, `routes/cmsMedia.js`) and the one-time
 * upload URLs of the CMS MCP server (`cms/mcp/`) must agree on the allowed types
 * and sizes, so both read these constants instead of keeping a copy each.
 * A second list would drift the first time a type is added.
 */

'use strict';

const { envInt } = require('../../utils/envNumber.mts');

const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const CLIP_MAX_BYTES = 500 * 1024 * 1024;
const VTT_MAX_BYTES = 1024 * 1024;

// Images cover the hero/feature/logo case; gif + apng + webp cover animated
// graphics; mp4 + webm cover the "silent loop" video kind. SVG is accepted
// only after server-side sanitisation. The document types are added below.
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

// Documents for download (a template, a white paper, a form): checked on their bytes
// (core/cms/documentSniff.mts) and always served as a download, never inline
// (routes/cmsAssets.js serveAsset). Macro-enabled Office files are refused.
/** @type {Readonly<Record<string, string>>} content type → the extension the stored asset gets */
const DOCUMENT_EXT_BY_TYPE = Object.freeze({
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
});
const DOCUMENT_MIME_WHITELIST = new Set(Object.keys(DOCUMENT_EXT_BY_TYPE));
for (const type of DOCUMENT_MIME_WHITELIST) UPLOAD_MIME_WHITELIST.add(type);

const DOCUMENT_MAX_MB_DEFAULT = 25;

/**
 * The largest document upload: CMS_DOCUMENT_MAX_MB megabytes (default 25), 0 = no limit.
 * Read per call, so a changed setting needs no restart of this module.
 * @returns {number}
 */
function documentMaxBytes() {
    const mb = envInt('CMS_DOCUMENT_MAX_MB', DOCUMENT_MAX_MB_DEFAULT, { min: 0 });
    return mb === 0 ? Number.MAX_SAFE_INTEGER : mb * 1024 * 1024;
}

const CLIP_MIME_WHITELIST = new Set(['video/mp4', 'video/webm']);

/** Captions are stored as text/vtt whatever the browser labelled them. */
const VTT_CONTENT_TYPE = 'text/vtt';

/**
 * The size ceiling for a content type, or null when the type is not accepted.
 * Clips (mp4/webm) go through the 500 MB multipart path, captions are capped at
 * 1 MB, documents at CMS_DOCUMENT_MAX_MB (documentMaxBytes), every other type at 25 MB.
 * @param {string} contentType
 * @returns {number|null}
 */
function maxBytesFor(contentType) {
    const type = String(contentType || '').toLowerCase();
    if (CLIP_MIME_WHITELIST.has(type)) return CLIP_MAX_BYTES;
    if (DOCUMENT_MIME_WHITELIST.has(type)) return documentMaxBytes();
    if (type === VTT_CONTENT_TYPE) return VTT_MAX_BYTES;
    if (UPLOAD_MIME_WHITELIST.has(type)) return IMAGE_MAX_BYTES;
    return null;
}

module.exports = {
    IMAGE_MAX_BYTES, CLIP_MAX_BYTES, VTT_MAX_BYTES,
    UPLOAD_MIME_WHITELIST, CLIP_MIME_WHITELIST, VTT_CONTENT_TYPE,
    DOCUMENT_MIME_WHITELIST, DOCUMENT_EXT_BY_TYPE, documentMaxBytes,
    maxBytesFor,
};
