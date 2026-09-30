/**
 * TeX in an answer: `$…$` inline and `$$…$$` as a display block, the two
 * delimiters the web's remark-math reads. marked knows neither, so these are
 * marked extensions that turn them into `inlineMath` / `blockMath` tokens.
 *
 * One deliberate difference from remark-math: a `$` only opens inline math
 * when a non-space follows it, and only closes it when a non-space precedes
 * it and no digit follows (Pandoc's rule). remark-math pairs any two dollars,
 * so "it costs $5 or $10" renders "5 or " as a formula on the web; here it
 * stays a sentence about money.
 *
 * Scanned by hand rather than by regex: the input is a model's answer and the
 * scan has to stay linear on anything it is given.
 */

import type { TokenizerExtension, Tokens } from 'marked';

export interface MathToken extends Tokens.Generic {
    type: 'inlineMath' | 'blockMath';
    text: string;
    /** blockMath only: false while the closing `$$` has not arrived. */
    closed?: boolean;
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** The index of the `$` that closes inline math opened at 0, or -1. */
function inlineClose(src: string): number {
    for (let i = 1; i < src.length; i += 1) {
        const c = src[i];
        if (c === '\\') {
            i += 1;
        } else if (c === '\n' && src[i + 1] === '\n') {
            return -1; // a blank line ends the paragraph, and the formula with it
        } else if (c === '$' && !isSpace(src[i - 1]) && !isDigit(src[i + 1])) {
            return i;
        }
    }
    return -1;
}

export const inlineMath: TokenizerExtension = {
    name: 'inlineMath',
    level: 'inline',
    start: (src) => {
        const at = src.indexOf('$');
        return at < 0 ? undefined : at;
    },
    tokenizer(src) {
        if (src[0] !== '$') return undefined;
        if (src[1] === '$') return inlineDisplay(src);
        if (isSpace(src[1])) return undefined;
        const end = inlineClose(src);
        if (end < 0) return undefined;
        return { type: 'inlineMath', raw: src.slice(0, end + 1), text: src.slice(1, end) } satisfies MathToken;
    },
};

/** `$$…$$` inside a line of text: inline, as remark-math renders it. */
function inlineDisplay(src: string): MathToken | undefined {
    const end = src.indexOf('$$', 2);
    if (end < 0) return undefined;
    const text = src.slice(2, end);
    if (!text.trim() || text.includes('\n\n')) return undefined;
    return { type: 'inlineMath', raw: src.slice(0, end + 2), text: text.trim() };
}

/**
 * Where a display block starts, so a paragraph above it stops there: a line
 * that opens with `$$` and is a block by blockTokenizer's own rules.
 */
function blockStart(src: string): number | undefined {
    for (let at = src.indexOf('$$'); at >= 0; at = src.indexOf('$$', at + 2)) {
        const lineStart = src.lastIndexOf('\n', at - 1) + 1;
        const opensLine = at - lineStart <= 3 && src.slice(lineStart, at).trim() === '';
        if (opensLine && blockTokenizer(src.slice(lineStart))) return lineStart;
    }
    return undefined;
}

/**
 * A display block: `$$` opening a line, closed by the next `$$` — on the same
 * line (`$$ x^2 $$`) or a later one. An unclosed block runs to the end of the
 * answer, as an unclosed code fence does, and is marked so: while an answer
 * streams, that is a formula still arriving.
 */
function blockTokenizer(src: string): MathToken | undefined {
    const open = /^ {0,3}\$\$/.exec(src);
    if (!open) return undefined;
    const bodyStart = open[0].length;
    const end = src.indexOf('$$', bodyStart);
    if (end < 0) {
        return { type: 'blockMath', raw: src, text: src.slice(bodyStart).trim(), closed: false };
    }
    // The rest of the closing line belongs to the block (usually just "\n").
    const lineEnd = src.indexOf('\n', end + 2);
    const raw = lineEnd < 0 ? src : src.slice(0, lineEnd + 1);
    const trailing = src.slice(end + 2, lineEnd < 0 ? src.length : lineEnd);
    if (trailing.trim()) return undefined; // `$$a$$ and more` is a sentence with a formula in it
    return { type: 'blockMath', raw, text: src.slice(bodyStart, end).trim(), closed: true };
}

export const blockMath: TokenizerExtension = {
    name: 'blockMath',
    level: 'block',
    start: blockStart,
    tokenizer: blockTokenizer,
};

export function isMathToken(token: { type: string }): token is MathToken {
    return token.type === 'inlineMath' || token.type === 'blockMath';
}
