// @typecheck
/**
 * Blog post Markdown → HTML that is safe to serve to anonymous visitors.
 *
 * Used for the server-rendered post page (crawlers and first paint) and for the
 * RSS feed. The browser renders the same Markdown with react-markdown
 * (agent-hub/src/marketing/blog/BlogMarkdown.tsx), whose rules match these.
 *
 * WHY THREE LAYERS. A post body is stored data that ends up in a public page,
 * which is exactly where a stored XSS is worth most, and the author may be an
 * MCP client fed by text from anywhere. So:
 *   1. raw HTML inside the Markdown is ESCAPED, never passed through;
 *   2. every link and image URL goes through safeUrl(): http(s), mailto (links
 *      only), site-relative paths, #anchors and CMS asset keys survive;
 *      `javascript:`, `data:`, `vbscript:`, protocol-relative and anything
 *      unknown become plain text / are dropped;
 *   3. the result is run through DOMPurify with a short tag allow-list, so a
 *      future marked change or renderer bug still cannot emit a <script>, an
 *      event handler or an <iframe>.
 *
 * Headings shift one level down (`#` → <h2>): the post title is the page's h1.
 */

'use strict';

const {
    ASSET_PREFIX, sanitizeMediaRef, markdownToPlainText, readingMinutes, deriveExcerpt, extractAssetKeys,
} = require('../../stores/cms/postText');
const ALLOWED_TAGS = [
    'p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
];
const ALLOWED_ATTR = ['href', 'title', 'src', 'alt', 'loading', 'decoding', 'id', 'start', 'align', 'type', 'checked', 'disabled'];

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => HTML_ENTITIES[c]); }

/** `cms/<key>` → `/api/cms/asset/cms/<key>` (segment-encoded), else unchanged. */
function assetPath(key) {
    return `${ASSET_PREFIX}${String(key).split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The one URL gate. Returns a safe href/src, or '' when the URL must go.
 * @param {string} raw
 * @param {{ kind?: 'link'|'image', origin?: string }} [opts] origin makes
 *   site-relative URLs absolute (the feed is read outside the site).
 */
function safeUrl(raw, { kind = 'link', origin = '' } = {}) {
    if (typeof raw !== 'string') return '';
    // Browsers ignore control characters and whitespace inside a scheme
    // ("java\tscript:"), so the test runs on the collapsed form.
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- single character-class repeat and anchored scheme/path tests, all linear; input is capped at 2048 chars right after
    const s = raw.trim().replace(/[\u0000-\u001F\u007F\s]+/g, '');
    if (!s || s.length > 2048) return '';
    const abs = (p) => (origin ? `${origin}${p}` : p);
    if (s.startsWith('cms/')) return s.includes('..') ? '' : abs(assetPath(s));
    if (s.startsWith('#')) return kind === 'link' ? s : '';
    if (s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\')) return abs(s);
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
    if (!scheme) {
        // A bare relative path ("pricing", "./x") — resolve against the site root.
        return /^[a-z0-9._~-]/i.test(s) && !s.includes('\\') ? abs(`/${s.replace(/^\.\//, '')}`) : '';
    }
    const proto = scheme[1].toLowerCase();
    if (proto === 'https' || proto === 'http') return s;
    if (proto === 'mailto' && kind === 'link') return s;
    return '';
}

function isExternal(href) { return /^https?:\/\//i.test(href); }

let purify = null;
// The origin of the render in progress (sanitize is synchronous), read by the
// hook below to tell this site's own absolute links from external ones.
let currentOrigin = '';
function getPurify() {
    if (purify) return purify;
    const createDOMPurify = require('dompurify');
    const { JSDOM } = require('jsdom');
    purify = createDOMPurify(new JSDOM('').window);
    // DOMPurify drops `rel` and the image loading hints, so they are set here,
    // after sanitizing: every external link opens without a referrer, an
    // opener or a vote of trust, and article images load lazily.
    purify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'IMG') {
            node.setAttribute('loading', 'lazy');
            node.setAttribute('decoding', 'async');
            return;
        }
        if (node.tagName !== 'A') return;
        const href = node.getAttribute('href') || '';
        if (isExternal(href) && !(currentOrigin && href.startsWith(`${currentOrigin}/`))) {
            node.setAttribute('rel', 'noopener noreferrer nofollow');
        }
    });
    return purify;
}

function sanitizeHtml(html, { origin = '' } = {}) {
    currentOrigin = origin;
    return getPurify().sanitize(html, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/(?!\/)|#)/i,
        ALLOW_DATA_ATTR: false,
    });
}

/** Stable heading ids so `[jump](#setup)` works and readers can link a section. */
function headingId(textValue, used) {
    const base = String(textValue || '')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z0-9#]+;/gi, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
    let id = base;
    let i = 2;
    while (used.has(id)) id = `${base}-${i++}`;
    used.add(id);
    return id;
}

/**
 * @param {string} markdown
 * @param {{ origin?: string }} [opts]
 * @returns {string} sanitized HTML
 */
function renderPostMarkdown(markdown, { origin = '' } = {}) {
    const src = String(markdown || '');
    if (!src.trim()) return '';
    const { Marked } = require('marked');
    const used = new Set();
    const md = new Marked({ gfm: true, breaks: false, async: false });
    md.use({
        renderer: {
            html(token) { return esc(token.text || token.raw || ''); },
            heading(token) {
                const inner = this.parser.parseInline(token.tokens);
                const level = Math.min(6, Math.max(2, token.depth + 1));
                return `<h${level} id="${esc(headingId(inner, used))}">${inner}</h${level}>\n`;
            },
            link(token) {
                const inner = this.parser.parseInline(token.tokens);
                const href = safeUrl(token.href, { kind: 'link', origin });
                if (!href) return inner;
                const title = token.title ? ` title="${esc(token.title)}"` : '';
                return `<a href="${esc(href)}"${title}>${inner}</a>`;
            },
            image(token) {
                const src2 = safeUrl(token.href, { kind: 'image', origin });
                if (!src2) return esc(token.text || '');
                const title = token.title ? ` title="${esc(token.title)}"` : '';
                return `<img src="${esc(src2)}" alt="${esc(token.text || '')}"${title} loading="lazy" decoding="async">`;
            },
        },
    });
    return sanitizeHtml(md.parse(src), { origin });
}

module.exports = {
    renderPostMarkdown, safeUrl, markdownToPlainText, readingMinutes, deriveExcerpt,
    extractAssetKeys, assetPath, sanitizeHtml, sanitizeMediaRef,
};
