/**
 * marked, set up the way the web's react-markdown reads an answer: GFM
 * (tables, task lists, strikethrough, autolinks) plus TeX (math.ts).
 *
 * Two entry points, because a streaming answer is rendered block by block:
 *
 *   splitBlocks  the answer cut into its top-level blocks, by marked's BLOCK
 *                pass only. A streaming answer only grows at its tail, so every
 *                finished paragraph, list and code block keeps its source text
 *                and its rendered tree; only the last one is rebuilt.
 *   lexBlock     one block's tokens, block and inline — what MarkdownBlock
 *                renders, memoised on the block's source.
 *
 * Each block is the token's own `raw`, which lexes back to the same token on
 * its own. The one thing a block cannot carry is a reference-style link
 * (`[x][ref]` with `[ref]: url` elsewhere): those resolve across the whole
 * document, so an answer that defines any is kept as one block.
 */

import { Lexer, Marked, type MarkedOptions, type Token } from 'marked';

import { blockMath, inlineMath } from './math';

const OPTIONS: MarkedOptions = new Marked({ gfm: true }).use({ extensions: [blockMath, inlineMath] }).defaults;

function normaliseNewlines(value: string): string {
    return value.replace(/\r\n|\r/g, '\n');
}

export function splitBlocks(value: string): string[] {
    // What Lexer.lex does before its block pass, minus the inline pass after it.
    const lexer = new Lexer(OPTIONS);
    const tokens = lexer.blockTokens(normaliseNewlines(value), lexer.tokens);
    if (Object.keys(lexer.tokens.links).length > 0) return [value];
    return tokens.map((token) => token.raw);
}

/** One block (or a whole answer), fully lexed. */
export function lexBlock(raw: string): Token[] {
    return Lexer.lex(normaliseNewlines(raw), OPTIONS);
}
