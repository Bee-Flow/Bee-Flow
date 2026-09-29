/**
 * Escaping for server-rendered marketing HTML.
 *
 * Everything that reaches these helpers is CMS content — authored by an
 * admin, but still stored data that ends up in a document we serve to the
 * public. It gets escaped on the way out regardless of who typed it: a
 * marketing page is not a place to rely on "the author is trusted", and the
 * CMS is exactly the surface where a stored XSS would be most valuable.
 */

const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** Escape for use in element text or a double-quoted attribute. */
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
}

// Built from codepoints rather than written literally: a raw U+2028 in this
// file would itself be a line terminator and the source would not parse.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

// The JS escape sequences, assembled from a backslash char so that no layer
// between here and disk can helpfully collapse them back into the character
// they are meant to be escaping.
const BS = String.fromCharCode(92);
const ESCAPED_LT = BS + 'u003c';
const ESCAPED_LS = BS + 'u2028';
const ESCAPED_PS = BS + 'u2029';

/**
 * Escape a value for embedding inside a <script> block.
 *
 * JSON.stringify alone is NOT enough: a value containing the literal text
 * `</script>` closes the block, and everything after it becomes markup.
 * Replacing every `<` with its escape prevents that — a JSON parser reads it
 * back as `<`, but the HTML tokenizer never sees a tag. U+2028 and U+2029 are
 * legal inside a JSON string but are line terminators in JavaScript, so they
 * have to go the same way.
 */
function jsonForScript(value) {
    return JSON.stringify(value)
        .split('<').join(ESCAPED_LT)
        .split(LINE_SEP).join(ESCAPED_LS)
        .split(PARA_SEP).join(ESCAPED_PS);
}

/** A <meta> tag, or '' when the content is empty — never an empty tag. */
function meta(nameOrProperty, content, { property = false } = {}) {
    const text = (content === null || content === undefined) ? '' : String(content).trim();
    if (!text) return '';
    const attr = property ? 'property' : 'name';
    return `<meta ${attr}="${esc(nameOrProperty)}" content="${esc(text)}">`;
}

/** Collapse whitespace and hard-truncate — meta descriptions have a budget. */
function clamp(value, max) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    // Cut on a word boundary so the ellipsis does not land mid-word.
    return text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

module.exports = { esc, jsonForScript, meta, clamp };
