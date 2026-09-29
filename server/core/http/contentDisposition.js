// @typecheck
/**
 * Download names that cannot break out of a header or a directory.
 *
 * contentDisposition(): a stripped ASCII fallback that cannot leave the quoted
 * string, plus RFC 5987 `filename*` carrying the real (possibly non-Latin)
 * name. safeFileName(): one path segment of harmless characters, for a name
 * that ends up in a filesystem path.
 */
'use strict';

/** @param {unknown} filename */
function contentDisposition(filename) {
    const name = String(filename || 'document');
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'document';
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * A single path segment: no directory parts, no dot-only names, only
 * [A-Za-z0-9._-]. Anything else becomes `_`.
 * @param {unknown} filename
 */
function safeFileName(filename) {
    const base = String(filename || '').split(/[\\/]/).pop() || '';
    const cleaned = base.replace(/[^a-zA-Z0-9.\-_]/g, '_').replace(/^\.+/, '_');
    return cleaned || 'document';
}

module.exports = { contentDisposition, safeFileName };
