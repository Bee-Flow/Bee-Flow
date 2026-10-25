// @typecheck strict
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

// Single shared DOMPurify instance — jsdom window is expensive to create.
const _window = new JSDOM('<!doctype html><html><body></body></html>').window;

const DOMPurify = createDOMPurify(_window);

// Iframe allowlist: only Bee Flow's own chat-embed pages may survive into a
// public snapshot. The host is derived from the same env var that the share
// URL builder uses, so deployments on white-label / self-hosted domains keep
// behaviour in lockstep. Trailing slash is normalised; path must be /chat/<id>
// with a conservative id charset.
function getEmbedAllowedHost() {
    const raw = process.env.PUBLIC_SHARE_BASE_URL
        || process.env.PUBLIC_APP_URL
        || 'https://beeflow.nl';
    try { return new URL(raw).origin; }
    catch { return 'https://beeflow.nl'; }
}

/** @param {unknown} src */
function isAllowedEmbedSrc(src) {
    if (typeof src !== 'string' || !src) return false;
    let u;
    try { u = new URL(src); }
    catch { return false; }
    if (u.origin !== getEmbedAllowedHost()) return false;
    return /^\/chat\/[A-Za-z0-9-]+\/?$/.test(u.pathname);
}

// Iframes whose `src` survives `isAllowedEmbedSrc` keep only this attribute
// set; everything else (sandbox/srcdoc/name/allow/onload/…) is stripped. We
// set the OUTER sandbox in publicViewer.js, so callers cannot escalate
// privileges by smuggling their own sandbox= here.
const IFRAME_ATTR_ALLOWLIST = new Set([
    'src', 'width', 'height', 'style', 'title', 'loading',
    'frameborder', 'scrolling', 'allowfullscreen',
]);

/** @type {{ USE_PROFILES: { html: boolean, svg: boolean }, FORBID_TAGS: string[], FORBID_ATTR?: string[], ALLOWED_ATTR?: string[], ADD_TAGS: string[], ADD_ATTR: string[], KEEP_CONTENT: boolean }} */
const SANITIZE_HTML_CONFIG = {
    USE_PROFILES: { html: true, svg: true },
    // `iframe` removed from FORBID_TAGS — the uponSanitizeElement hook above
    // gates it by src so only Bee Flow chat embeds pass through. Everything
    // else (script/object/embed/base/meta/form) stays banned.
    FORBID_TAGS: ['script', 'object', 'embed', 'base', 'meta', 'form'],
    FORBID_ATTR: ['style' /* allowed via SAFE_FOR_TEMPLATES off */],
    // Allow inline style — pages often rely on it heavily — but block the rest.
    ALLOWED_ATTR: undefined,
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['target', 'rel', 'allowfullscreen'],
    // Strip on* handlers (default), javascript:/vbscript: URLs (default),
    // and anything that could re-enable scripting.
    KEEP_CONTENT: true,
};

const SANITIZE_SVG_CONFIG = {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
};

/** @param {unknown} svg */
function sanitizeSvg(svg) {
    if (!svg) return '';
    return DOMPurify.sanitize(String(svg), SANITIZE_SVG_CONFIG);
}

const TEXT_LIKE_MIMES = ['text/html', 'image/svg', 'text/css'];

/** @param {string | null | undefined} mime */
function shouldSanitizeExtra(mime) {
    if (!mime) return false;
    return TEXT_LIKE_MIMES.some(p => mime.startsWith(p));
}

module.exports = { DOMPurify, isAllowedEmbedSrc, IFRAME_ATTR_ALLOWLIST, SANITIZE_HTML_CONFIG, sanitizeSvg, shouldSanitizeExtra };
