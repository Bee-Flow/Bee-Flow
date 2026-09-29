// @typecheck
/**
 * Shared text helpers for notebook word counts and excerpts.
 *
 * A util rather than core code because it needs nothing: no store, no config,
 * no model. Two stores and three routes read it, and a store reaching up into
 * core/ for a pure function is the upward edge layering.test.js counts.
 *
 * countWords must agree with the editor's counter (BeeEditor.jsx) — the naive
 * `split(/\s+/).length` reads an empty string as 1 word, which put "1 word"
 * badges on empty documents in five server call sites.
 */

function countWords(text) {
    const t = String(text ?? '').trim();
    return t ? t.split(/\s+/).length : 0;
}

/**
 * Cheap Markdown → plain-ish text, good enough for a 300-char excerpt.
 * NOT a renderer — inline underscores etc. inside words are sacrificed for
 * simplicity.
 */
function stripMarkdownLite(md) {
    return String(md ?? '')
        .replace(/```[\s\S]*?```/g, ' ')            // fenced code blocks
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')         // heading markers
        .replace(/^\s{0,3}>\s?/gm, '')              // blockquote markers
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')  // links/images → label
        .replace(/[*_~`]+/g, '')                    // emphasis / backticks
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = { countWords, stripMarkdownLite };
