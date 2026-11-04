// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FORM_CSS_MAX, sanitizeFormCssClient } from './formCssSanitizer';

const clean = (css: string) => sanitizeFormCssClient(css);

describe('sanitizeFormCssClient: what stays', () => {
    it('keeps ordinary rules verbatim, nested at-rules included', () => {
        const css = '.bf-form__title { color: #7c2d12; letter-spacing: .02em; }\n@media (max-width: 600px) { .bf-form__card { padding: 12px; } }\n@supports (backdrop-filter: blur(4px)) { .bf-form__card { backdrop-filter: blur(4px); } }';
        expect(clean(css)).toEqual({ css, removed: [] });
    });

    it('keeps same-origin and inline-image addresses', () => {
        const css = '.bf-form__card { background: url(/assets/paper.png); } .bf-form__logo { background-image: url("data:image/svg+xml;utf8,<svg/>"); }';
        expect(clean(css).removed).toEqual([]);
    });

    it('keeps braces and semicolons inside strings as text', () => {
        const css = '.bf-form__title::after { content: "a } b ; c {"; }';
        expect(clean(css)).toEqual({ css, removed: [] });
    });

    it('is empty for nothing, and never throws on a non-string', () => {
        expect(clean('')).toEqual({ css: '', removed: [] });
        expect(sanitizeFormCssClient(42)).toEqual({ css: '', removed: [] });
    });
});

describe('sanitizeFormCssClient: what goes', () => {
    it.each([
        ['@import url(/x.css);', '@import'],
        ['@charset "utf-8";', '@charset'],
        ['@namespace svg url(http://www.w3.org/2000/svg);', '@namespace'],
        ['.a { background: url(https://tracker.example/p.gif); }', 'outside address'],
        ['.a { background: url(//tracker.example/p.gif); }', 'outside address'],
        ['.a { background: url("/\\\\tracker.example/p.gif"); }', 'outside address'],
        ['.a { width: expression(alert(1)); }', 'expression('],
        ['.a { behavior: url(/x.htc); }', 'behavior:'],
        ['.a { -moz-binding: url(/x.xml#y); }', '-moz-binding'],
        ['.a { background: url(javascript:alert(1)); }', 'javascript:'],
        ['.a { position: fixed; inset: 0; }', 'position: fixed'],
        ['.a { background-image: image-set("https://tracker.example/p.png" 1x); }', 'outside address'],
        ['.a { --pic: "//tracker.example/p.png"; }', 'outside address'],
    ])('removes %s', (css, label) => {
        const out = clean(css);
        expect(out.removed).toContain(label);
        expect(out.css).not.toMatch(/tracker|alert|fixed|@import|@charset|@namespace|binding|behavior/);
    });

    it('drops only the offending declaration and keeps its neighbours', () => {
        const out = clean('.a { color: red; background: url(https://x.example/a.png); padding: 4px; }');
        expect(out.css).toBe('.a { color: red; padding: 4px; }');
    });

    it('drops a whole @font-face block, and any nested block other than @media, @supports, @container', () => {
        const out = clean('@font-face { font-family: X; src: url(/x.woff2); } @page { margin: 0; } .a { color: red; }');
        expect(out.css).toBe('.a { color: red; }');
        expect(out.removed).toEqual(expect.arrayContaining(['@font-face', '@page']));
    });

    it('sees through CSS escapes and comments', () => {
        expect(clean('@\\69mport "/x.css";').removed).toContain('@import');
        expect(clean('.a { background: u\\72l(https://x.example/a.png); }').removed).toContain('outside address');
        expect(clean('.a { position: /* hi */ fixed; }').removed).toContain('position: fixed');
        expect(clean('.a { color: red; } /* a comment */').css).toBe('.a { color: red; }');
    });

    it('removes </ and <!-- however they are put together', () => {
        const out = clean('.a { content: "<</style>"; } <!-- x');
        expect(out.css).not.toMatch(/<\/|<!--/);
        expect(out.removed).toEqual(expect.arrayContaining(['</', '<!--']));
    });

    it('refuses a selector that reaches outside the form', () => {
        for (const css of ['& ~ * { display: none; }', '& + div { display: none; }', '~ p { color: red; }']) {
            const out = clean(css);
            expect(out.removed).toContain('sibling selector');
            expect(out.css).toBe('');
        }
        // Inside the form, siblings are fine.
        expect(clean('.bf-form__field + .bf-form__field { margin-top: 2px; }').removed).toEqual([]);
    });
});

describe('sanitizeFormCssClient: the scope cannot be closed early', () => {
    it('drops a brace that would close the wrapper', () => {
        const out = clean('.a { color: red; } } body { display: none; }');
        expect(out.removed).toContain('unbalanced }');
        // What follows stays INSIDE the scope, where `body` matches nothing.
        expect(out.css.split('}').length - 1).toBe(out.css.split('{').length - 1);
    });

    it('closes what was left open', () => {
        const out = clean('.a { color: red;');
        expect(out.css.endsWith('}')).toBe(true);
        expect(out.removed).toContain('unbalanced }');
    });

    it('reads an unquoted url() as one token, as the browser does, so a brace inside it is not counted', () => {
        // To the browser `url(/x{)` is one token: the two `}` after it close
        // `a` and then the WRAPPER. Counting the `{` inside it would miss that.
        const out = clean('a { b: url(/x{) } } body { color: red; }');
        expect(out.removed).toContain('unbalanced }');
        expect(out.css).toBe('a { b: url(/x{) } body { color: red; }');
    });

    it('treats an escaped brace as a character, not a block', () => {
        const out = clean('.a\\} { color: red; }');
        expect(out).toEqual({ css: '.a\\} { color: red; }', removed: [] });
    });
});

it(`refuses CSS over ${FORM_CSS_MAX} characters as a whole`, () => {
    const out = clean(`.a { color: red; }${' '.repeat(FORM_CSS_MAX)}`);
    expect(out).toEqual({ css: '', removed: [`over ${FORM_CSS_MAX} characters`] });
});
