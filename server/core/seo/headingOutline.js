// @typecheck strict
/**
 * The heading outline of the server-rendered page (core/seo/renderBlocks.js):
 * one h1 for the document, then every block's own headings from h2 down.
 * Split out of renderBlocks.js.
 */

const { esc } = require('./html');

/**
 * @typedef {{ h1Used: boolean, blockIndex: number, columns: number,
 *   heroImage: { src: string, srcset?: string, sizes: string } | null,
 *   blockHeading?: { depth: number, level: number } | null }} HeadingState
 *   `blockHeading`: the first heading of the block being walked (its depth and level)
 */

/**
 * @param {string} text
 * @param {string[]} out
 * @param {number} depth
 * @param {HeadingState} state
 */
function emitHeading(text, out, depth, state) {
    // Exactly one h1 per document. The first heading encountered wins, which
    // is the hero's — two h1s is a real (if mild) SEO defect and an
    // accessibility one, so the rule is enforced here rather than trusted.
    if (!state.h1Used) {
        state.h1Used = true;
        state.blockHeading = { depth, level: 1 };
        out.push(`<h1>${esc(text)}</h1>`);
        return;
    }
    const { level, visual } = headingLevel(depth, state);
    // The size stays the one the depth gave before (see PREHYDRATE_CSS), so a
    // heading promoted for the outline does not grow before React mounts.
    const cls = visual !== level ? ` class="h${visual}"` : '';
    out.push(`<h${level}${cls}>${esc(text)}</h${level}>`);
}

/**
 * The level of a heading below the h1, counted from the block's first heading
 * rather than from the depth in the content tree alone. A content block keeps
 * its headings three levels down (columns → elements → heading), which put an
 * h4 straight under the page's h1. Now a block's first heading is an h2, a
 * heading deeper in the same block one level per step below it (at least h3,
 * at most h4), and `visual` is the old depth level, for the size.
 * @param {number} depth
 * @param {HeadingState} state
 * @returns {{ level: number, visual: number }}
 */
function headingLevel(depth, state) {
    const visual = Math.min(2 + Math.max(0, depth - 1), 4);
    const first = state.blockHeading;
    if (!first) {
        state.blockHeading = { depth, level: 2 };
        return { level: 2, visual };
    }
    const level = Math.min(4, Math.max(first.level + 1, first.level + depth - first.depth));
    return { level, visual };
}

module.exports = { emitHeading, headingLevel };
