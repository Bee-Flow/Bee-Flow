// @typecheck
/**
 * Notebook document HTML sanitizer + plaintext extractor.
 *
 * sanitizeDocumentHtml is the write-path defense for notebook/legal-matter
 * document bodies: the editor renders stored HTML back with innerHTML-level
 * trust, so hostile markup written via the PUT route, an AI tool, or a version
 * restore must never reach the row. Same lazy DOMPurify+JSDOM singleton as
 * utils/svgSanitizer.js.
 *
 * DOMPurify defaults are deliberately kept: `style` and `data-*` attributes
 * survive (mermaid blocks are divs carrying data-type/data-code) and data:
 * URIs stay allowed on <img> src (file import embeds images as base64).
 */

const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

let purifyInstance = null;

function getPurify() {
    if (purifyInstance) return purifyInstance;
    const window = new JSDOM('').window;
    purifyInstance = createDOMPurify(window);
    return purifyInstance;
}

function sanitizeDocumentHtml(html) {
    const raw = String(html ?? '');
    if (!raw) return '';
    return getPurify().sanitize(raw, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'],
    });
}

// ── HTML → plaintext ───────────────────────────────────────────────

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'TR', 'BLOCKQUOTE', 'PRE', 'TABLE', 'BR']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

let domParser = null;
function getParser() {
    if (!domParser) domParser = new (new JSDOM('').window.DOMParser)();
    return domParser;
}

/**
 * Extract readable text with REAL block boundaries. A bare textContent glues
 * adjacent blocks together ('<p>a</p><p>b</p>' → 'ab'), which is what mangled
 * the card previews; this walk emits 'a\nb' instead.
 */
function htmlToPlainText(html) {
    const raw = String(html ?? '');
    if (!raw.trim()) return '';
    const doc = getParser().parseFromString(raw, 'text/html');
    const parts = [];
    const walk = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === 3) {
                // Source-formatting whitespace (indentation, wraps) is not a break.
                parts.push(child.textContent.replace(/\s+/g, ' '));
            } else if (child.nodeType === 1 && !SKIP_TAGS.has(child.tagName)) {
                walk(child);
                if (BLOCK_TAGS.has(child.tagName)) parts.push('\n');
            }
        }
    };
    walk(doc.body);
    return parts.join('')
        .replace(/ +/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n+/g, '\n')
        .trim();
}

// ── Plain-text identity fields ─────────────────────────────────────

/** Longest a name/tagline/address field may be after sanitising. */
const DEFAULT_TEXT_MAX = 512;

/**
 * Strip ALL markup from a field that is supposed to be plain text.
 *
 * The sibling above keeps rich HTML because a notebook document IS rich HTML.
 * This one is for the opposite case: organisation names, taglines, descriptions,
 * display names — values that are only ever rendered as text, and where markup
 * arriving at all is either a mistake or an attack.
 *
 * A pentest stored `<img src=x onerror=...>` in an organisation's tagline and it
 * round-tripped verbatim. It did not execute, because React escapes on render —
 * but that made every current and future render path load-bearing, and one of
 * them was already not React: the invitation email interpolated the same field
 * straight into an HTML document. Escaping at the sinks is now handled too, and
 * this closes the other end, so the value is never dangerous in the first place.
 *
 * DOMPurify with no allowed tags drops the markup and keeps the text, so
 * `<b>Acme</b>` stores as `Acme` rather than being rejected — a customer who
 * pastes formatted text from a document gets a sensible result instead of an
 * error. It entity-encodes what survives, so the output goes back through
 * htmlToPlainText to store real characters rather than `&amp;`.
 *
 * Also strips zero-width/steganographic characters via the existing unicode
 * sanitiser: those are invisible in every UI and are how a name hides a payload.
 */
function sanitizePlainText(value, { maxLen = DEFAULT_TEXT_MAX } = {}) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string') return value;
    if (!value) return value;

    const stripped = getPurify().sanitize(value, {
        ALLOWED_TAGS: [],
        ALLOWED_ATTR: [],
        KEEP_CONTENT: true,
    });
    // sanitize() returns entity-encoded text; decode it back to characters so
    // the stored value is what the user typed, minus the markup.
    let text = stripped.includes('&') ? htmlToPlainText(stripped) : stripped;

    try {
        const { sanitizeUnicode } = require('./unicodeSanitizer');
        text = sanitizeUnicode(text).clean ?? text;
    } catch (_) { /* optional helper — never block a write on it */ }

    text = text.replace(/\s+/g, ' ').trim();
    return maxLen > 0 ? text.slice(0, maxLen) : text;
}

/**
 * Apply sanitizePlainText across the named keys of an object, in place-safe
 * fashion (returns a new object). Keys that are absent stay absent, so it can be
 * used on a partial update payload without inventing fields.
 */
function sanitizePlainTextFields(obj, fields, opts) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = { ...obj };
    for (const key of fields) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
        out[key] = sanitizePlainText(out[key], opts);
    }
    return out;
}

module.exports = {
    sanitizeDocumentHtml,
    htmlToPlainText,
    sanitizePlainText,
    sanitizePlainTextFields,
};
