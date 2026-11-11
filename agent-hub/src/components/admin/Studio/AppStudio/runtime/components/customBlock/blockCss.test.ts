import { describe, expect, it } from 'vitest';
import { BLOCK_CSS_MAX, sanitizeBlockCssClient } from './blockCss';

const X = 'http://leak.example/x.png';
const kept = (css: string) => sanitizeBlockCssClient(css).css;

describe('the stylesheet of a custom block', () => {
    it('keeps ordinary rules, attribute selectors, strings that are no address and inline images', () => {
        const css = '.a{color:var(--bf-primary)}\nhtml[data-appearance="dark"] .a{color:white}\n.b::before{content:"→";font-family:"Inter",sans-serif}\n.c{background:url(data:image/png;base64,AAAA)}\n@media (max-width: 400px){.a{display:none}}';
        expect(sanitizeBlockCssClient(css)).toEqual({ css, removed: [] });
    });

    it.each([
        `.a{background:url(${X})}`,
        `.a{background:url("${X}")}`,
        '.a{background:url(/api/me)}',
        '.a{background:url(asset:abc)}',
        `.a{background:u\\72l(${X})}`,
        `.a{background-image:image-set("${X}" 1x)}`,
        '.a{background-image:image-set("data:image/png;base64,AAAA" 1x)}',
        '.a{background:image(var(--x))}',
        `.a{background:cross-fade(url(${X}), url(data:image/png;base64,AAAA))}`,
        `@import url(${X});`,
        `@import "${X}";`,
        `@font-face{font-family:x;src:url(${X})}`,
        `.a{content:"${X}"}`,
    ])('leaves out %s', (css) => {
        const result = sanitizeBlockCssClient(`${css}\n.keep{color:red}`);
        expect(result.css).not.toContain('leak.example');
        expect(result.css).not.toContain('/api/me');
        expect(result.css).not.toContain('asset:');
        expect(result.css).not.toContain('image');
        expect(result.css).toContain('.keep{color:red}');
        expect(result.removed.length).toBeGreaterThan(0);
    });

    it('cannot end the style element it is written into, and refuses a text over the limit whole', () => {
        expect(kept('.a{color:red}</style><p>')).not.toContain('</');
        expect(sanitizeBlockCssClient('a'.repeat(BLOCK_CSS_MAX + 1))).toEqual({ css: '', removed: [`over ${BLOCK_CSS_MAX} characters`] });
        expect(sanitizeBlockCssClient(null)).toEqual({ css: '', removed: [] });
    });
});
