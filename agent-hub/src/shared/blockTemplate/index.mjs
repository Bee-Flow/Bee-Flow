// @typecheck strict
/**
 * Custom block (App Studio, schema 3): an HTML template and a stylesheet without script,
 * drawn in a frame that can run nothing and load nothing.
 *
 *   save   canonicalTemplate(text)                 strict reader -> allow-list -> stored text
 *   draw   canonicalTemplate(text) -> the browser's inert reader -> allow-list again
 *          -> renderBlock (formulas, repeats, conditions) -> serializeFrameBody
 *          -> buildFrameDocument
 */

import { parseTemplate } from './parse.mjs';
import { sanitizeTree } from './sanitize.mjs';
import { serializeTemplate } from './serialize.mjs';

export { BLOCK_LIMITS, RESERVED_NAMES, isBlockName, isSafeInlineStyle, isSafeSvgValue, attributeRule, isAllowedElement, HTML_ELEMENTS, SVG_ELEMENTS } from './vocabulary.mjs';
export { parseTemplate } from './parse.mjs';
export { sanitizeTree } from './sanitize.mjs';
export { serializeTemplate, serializeFrameBody, escapeText, escapeAttr } from './serialize.mjs';
export { renderBlock, inspectTemplate } from './render.mjs';
export { buildFrameDocument, clampFrameHeight, themeVariables, FRAME_SANDBOX, FRAME_CSP, FRAME_MIN_HEIGHT, FRAME_MAX_HEIGHT } from './frame.mjs';
export { domToTree } from './dom.mjs';
export { splitInterpolations, parseEach, formulasOf } from './interpolation.mjs';

/** @typedef {import('./vocabulary.mjs').TemplateNode} TemplateNode */
/** @typedef {import('./vocabulary.mjs').BlockFinding} BlockFinding */

/**
 * A template text as it may be stored: read strictly, held to the vocabulary, written back.
 * `findings` names everything that was left out, with its line. Doing it again changes nothing.
 * @param {unknown} source
 * @param {{ maxChars?: number, maxNodes?: number, maxDepth?: number }} [limits]
 * @returns {{ template: string, nodes: TemplateNode[], findings: BlockFinding[] }}
 */
export function canonicalTemplate(source, limits = {}) {
    if (typeof source !== 'string' || !source) return { template: '', nodes: [], findings: [] };
    const maxChars = limits.maxChars ?? Infinity;
    if (source.length > maxChars) {
        return { template: '', nodes: [], findings: [{ line: 1, code: 'template.too_long', message: `The template is ${source.length} characters; at most ${maxChars} are kept, so nothing of it is.` }] };
    }
    const parsed = parseTemplate(source);
    const clean = sanitizeTree(parsed.nodes, limits);
    const findings = [...parsed.findings, ...clean.findings].sort((a, b) => a.line - b.line);
    return { template: serializeTemplate(clean.nodes), nodes: clean.nodes, findings };
}
