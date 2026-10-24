// @typecheck
/**
 * The plain-text side of a blog post body: excerpts, reading time, the CMS
 * assets it references and the one rule for a stored media reference.
 *
 * Dependency-free on purpose and kept in stores/: the post store, the
 * published-blog reader and export/import need these, and a store may not
 * reach up into core/ (layering.test.js). core/cms/blogMarkdown.js, which turns
 * a body into safe HTML, builds on this module and re-exports it.
 */

'use strict';

const ASSET_PREFIX = '/api/cms/asset/';

/**
 * A media reference a post may carry: an uploaded CMS asset (bare `cms/…` key
 * or its `/api/cms/asset/…` URL) or an https URL. Anything else — `javascript:`,
 * `data:`, a protocol-relative URL, a path traversal — is dropped to ''.
 */
function sanitizeMediaRef(value) {
    if (typeof value !== 'string') return '';
    const s = value.trim();
    if (!s || s.length > 2048 || s.includes('..') || /[\s<>"'`\\]/.test(s)) return '';
    if (s.startsWith('cms/')) return s;
    if (s.startsWith('/api/cms/asset/cms/')) return s;
    if (/^https:\/\/[a-z0-9.-]+(?::\d+)?\//i.test(s)) return s;
    return '';
}

/** Markdown → readable plain text (for excerpts, meta descriptions, reading time). */
function markdownToPlainText(markdown) {
    return String(markdown || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
        .replace(/[*_~|]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Minutes to read, at ~220 words a minute; at least 1 for any text. */
function readingMinutes(markdown) {
    const words = markdownToPlainText(markdown).split(' ').filter(Boolean).length;
    return words ? Math.max(1, Math.round(words / 220)) : 0;
}

/** First ~`max` characters of the body as plain text, cut on a word boundary. */
function deriveExcerpt(markdown, max = 200) {
    const plain = markdownToPlainText(markdown);
    if (plain.length <= max) return plain;
    return `${plain.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/** Every CMS asset key a Markdown body references (images and links). */
function extractAssetKeys(markdown) {
    const out = new Set();
    const re = /(?:\]\(\s*<?|\s|^)((?:\/api\/cms\/asset\/)?cms\/[^\s)>"']+)/g;
    let m;
    const src = String(markdown || '');
    while ((m = re.exec(src))) {
        let key = m[1];
        if (key.startsWith(ASSET_PREFIX)) key = key.substring(ASSET_PREFIX.length);
        if (key.includes('..')) continue;
        try { out.add(decodeURIComponent(key)); } catch (_) { out.add(key); }
    }
    return [...out];
}

module.exports = { ASSET_PREFIX, sanitizeMediaRef, markdownToPlainText, readingMinutes, deriveExcerpt, extractAssetKeys };
