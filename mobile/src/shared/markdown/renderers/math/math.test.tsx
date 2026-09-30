/**
 * TeX, typeset by MathJax (the real engine, which runs under Jest as it runs
 * under Hermes), fitted for react-native-svg, and the fallbacks: the source
 * as written while a formula is still arriving, when it does not parse, and
 * when the engine cannot load at all.
 */

import { screen } from '@testing-library/react-native';

import { renderMarkdown } from '@/shared/testing/renderMarkdown';

import { fitMathSvg, mathError } from './mathSvg';
import { MATH_SCALE, renderTex } from './renderTex';

describe('fitMathSvg', () => {
    const svg =
        '<svg style="vertical-align: -0.566ex;" xmlns="http://www.w3.org/2000/svg" width="7.7ex" height="2.3ex" role="img" viewBox="0 -750 3406 1000"><g/></svg>';

    it('sizes the formula from its viewBox, at 1000 units per em', () => {
        const fit = fitMathSvg(svg, 20);
        expect(fit).toMatchObject({ width: 68.12, height: 20, depth: 5 });
    });

    it('drops the root’s CSS size and alignment, which SvgXml cannot read', () => {
        const xml = fitMathSvg(svg, 20)?.xml ?? '';
        expect(xml).not.toMatch(/style=|width=|height=/);
        expect(xml).toContain('viewBox="0 -750 3406 1000"');
        expect(xml.endsWith('<g/></svg>')).toBe(true);
    });

    it('refuses what is not MathJax’s SVG', () => {
        expect(fitMathSvg('<svg><g/></svg>', 20)).toBeNull();
        expect(fitMathSvg('nope', 20)).toBeNull();
    });

    it('reads MathJax’s own error mark', () => {
        expect(mathError('<g data-mjx-error="Missing close brace"></g>')).toBe('Missing close brace');
        expect(mathError('<g></g>')).toBeNull();
    });
});

describe('renderTex', () => {
    it('typesets inline and display formulas at KaTeX’s size', () => {
        const inline = renderTex('E = mc^2', false, 15);
        const display = renderTex('\\int_0^1 x^2\\,dx = \\frac{1}{3}', true, 15);
        expect(inline?.xml.startsWith('<svg')).toBe(true);
        expect(inline?.height).toBeGreaterThan(15);
        expect(display?.height).toBeGreaterThan(inline?.height ?? 0);
        expect(MATH_SCALE).toBe(1.21);
    });

    it('covers the AMS environments models write', () => {
        expect(renderTex('\\begin{pmatrix}a & b\\\\ c & d\\end{pmatrix}', true, 15)).not.toBeNull();
        expect(renderTex('f(x)=\\begin{cases}1 & x>0\\\\0 & \\text{else}\\end{cases}', true, 15)).not.toBeNull();
        expect(renderTex('\\mathbb{R}^n \\to \\boldsymbol{\\theta}', false, 15)).not.toBeNull();
    });

    it('answers null for a formula that does not parse, so its source is shown', () => {
        expect(renderTex('\\frac{a', false, 15)).toBeNull();
        expect(renderTex('   ', false, 15)).toBeNull();
    });
});

describe('in an answer', () => {
    it('draws inline math inside the sentence', async () => {
        await renderMarkdown('The area is $\\pi r^2$ exactly.');
        expect(screen.getByLabelText('\\pi r^2')).toBeTruthy();
    });

    it('draws display math, and shows TeX that is still arriving as written', async () => {
        await renderMarkdown('$$\nx^2 + y^2 = z^2\n$$');
        expect(screen.getByLabelText('x^2 + y^2 = z^2')).toBeTruthy();
        await renderMarkdown('$$\n\\frac{a}{', { streaming: true });
        expect(screen.getByText('\\frac{a}{')).toBeTruthy();
    });

    it('shows a formula that does not parse as its source', async () => {
        await renderMarkdown('Broken: $\\frac{a$ here');
        expect(screen.getByText(/\\frac\{a/)).toBeTruthy();
    });
});

describe('without the engine', () => {
    it('falls back to the TeX when MathJax cannot load', () => {
        jest.isolateModules(() => {
            jest.doMock('./mathjaxEngine', () => {
                throw new Error('engine unavailable on this device');
            });
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh registry, after the mock above
            const { loadMathEngine } = require('../lazyModules') as typeof import('../lazyModules');
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- the same registry's renderTex
            const isolated = require('./renderTex') as typeof import('./renderTex');
            expect(loadMathEngine()).toBeNull();
            expect(isolated.renderTex('x^2', false, 15)).toBeNull();
        });
    });
});
