import type { Token, Tokens } from 'marked';

import { lexBlock, splitBlocks } from './lexer';
import type { MathToken } from './math';

/** The inline tokens of a one-paragraph answer. */
function inline(value: string): Token[] {
    const [paragraph] = lexBlock(value) as Tokens.Paragraph[];
    return paragraph?.tokens ?? [];
}

const formulas = (tokens: Token[]) =>
    tokens.filter((t): t is MathToken => t.type === 'inlineMath').map((t) => t.text);

describe('inline math', () => {
    it('reads $…$ as a formula', () => {
        expect(formulas(inline('The area is $\\pi r^2$ exactly.'))).toEqual(['\\pi r^2']);
    });

    it('reads several on one line', () => {
        expect(formulas(inline('$a$ and $b$ and $c_1$'))).toEqual(['a', 'b', 'c_1']);
    });

    it('leaves money alone (the Pandoc rule, not remark-math’s)', () => {
        expect(formulas(inline('It costs $5 or $10 a month.'))).toEqual([]);
        expect(formulas(inline('Between $ 5 and 10 $ is not math.'))).toEqual([]);
        expect(formulas(inline('A $x$5 is not closed by a dollar before a digit.'))).toEqual([]);
    });

    it('keeps an escaped dollar inside a formula', () => {
        expect(formulas(inline('Say $\\$x$ here'))).toEqual(['\\$x']);
    });

    it('does not read a formula out of a code span', () => {
        expect(formulas(inline('Use `$x$` literally'))).toEqual([]);
    });

    it('reads $$…$$ inside a sentence as inline math', () => {
        expect(formulas(inline('So $$E=mc^2$$ holds.'))).toEqual(['E=mc^2']);
    });

    it('does not open on a lone dollar', () => {
        expect(formulas(inline('Just $ a dollar'))).toEqual([]);
    });
});

describe('display math', () => {
    const blockOf = (value: string) => lexBlock(value).find((t) => t.type === 'blockMath') as MathToken | undefined;

    it('reads a $$ fence over several lines', () => {
        const token = blockOf('$$\n\\int_0^1 x\\,dx\n$$\n');
        expect(token).toMatchObject({ text: '\\int_0^1 x\\,dx', closed: true });
    });

    it('reads $$ … $$ on one line', () => {
        expect(blockOf('$$ a^2 + b^2 = c^2 $$')).toMatchObject({ text: 'a^2 + b^2 = c^2', closed: true });
    });

    it('interrupts the paragraph above it', () => {
        const tokens = lexBlock('The formula:\n$$\nx^2\n$$\nAfter.');
        expect(tokens.map((t) => t.type)).toEqual(['paragraph', 'blockMath', 'paragraph']);
    });

    it('marks a block whose closing $$ has not arrived', () => {
        expect(blockOf('$$\n\\frac{a}{')).toMatchObject({ closed: false, text: '\\frac{a}{' });
    });

    it('is its own block when the answer is split for streaming', () => {
        const value = 'Intro.\n\n$$\nx\n$$\n\nOutro.';
        const blocks = splitBlocks(value);
        expect(blocks.join('')).toBe(value);
        expect(blocks.some((b) => b.startsWith('$$'))).toBe(true);
    });

    it('leaves a sentence that merely starts with $$…$$ a paragraph', () => {
        expect(lexBlock('$$x$$ is the formula').map((t) => t.type)).toEqual(['paragraph']);
    });

    it('does not read $$ inside a code fence', () => {
        expect(lexBlock('```\n$$\nx\n$$\n```').map((t) => t.type)).toEqual(['code']);
    });
});
