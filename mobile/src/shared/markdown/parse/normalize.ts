/**
 * What the web does to an answer before it parses it, ported from the two
 * pre-passes in agent-hub/src/components/renderers/MarkdownRenderer.jsx
 * (`stripWrappingCodeBlock`, `stripDirectiveBlocks`). normalize.lockstep.test.ts
 * holds every pattern here to the web's own.
 *
 * Both exist because of what models write, not what people write:
 *
 *   - a whole answer wrapped in ```markdown … ``` (the model "quoting" its own
 *     Markdown), which would otherwise render as one grey code block;
 *   - `:::writing Title` directive blocks from newer GPT models, which have no
 *     meaning in GFM and would otherwise print as literal colons.
 */

/** An opening ```markdown / ```md / ```text / ``` fence at the very start. */
export const WRAPPING_FENCE_OPEN = /^\s*```(?:markdown|md|text)?\n/i;
/** A closing fence at the very end. */
export const WRAPPING_FENCE_CLOSE = /\n```\s*$/;
/** `:::writing Title` and its siblings, which become `## Title`. */
export const DIRECTIVE_OPEN = /^:::(writing|note|tip|warning|important|caution)[\t ]+(.+)$/gm;
/** A bare `:::` closing line, which is dropped. */
export const DIRECTIVE_CLOSE = /^:::[\t ]*$/gm;

/**
 * Remove a fence that wraps the whole answer. The opening one is removed even
 * while the answer is still streaming and has no closing fence yet — that is
 * the case the web wrote this for.
 *
 * One deliberate difference: the web also strips a closing fence at the end
 * of ANY answer, so an answer that merely ends in a code block loses that
 * block's closing fence. A browser does not mind (an unclosed fence runs to
 * the end, which is where it ended anyway), but the phone reads a fence with
 * no closing line as still streaming (FenceBlock). So the closing fence goes
 * only with the opening one it belongs to; what is drawn is the same.
 */
export function stripWrappingCodeBlock(text: string): string {
    const start = WRAPPING_FENCE_OPEN.exec(text);
    if (!start) return text;
    const cleaned = text.substring(start[0].length);
    const end = WRAPPING_FENCE_CLOSE.exec(cleaned);
    return end ? cleaned.substring(0, end.index) : cleaned;
}

/** `:::writing Title` → `## Title`; a lone `:::` line → nothing. */
export function stripDirectiveBlocks(text: string): string {
    return text.replace(DIRECTIVE_OPEN, '## $2').replace(DIRECTIVE_CLOSE, '');
}

/** Both passes, in the web's order. */
export function normalizeAnswer(text: string): string {
    return stripDirectiveBlocks(stripWrappingCodeBlock(text));
}
