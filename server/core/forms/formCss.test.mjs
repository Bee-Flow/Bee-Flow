/**
 * core/forms/formCss.mts: the custom CSS sanitiser. The CSS is served to
 * anonymous visitors inside `.bf-form-scope { <css> }`, so every removal rule
 * is pinned here, and so is the property that makes the wrapper safe to
 * close: balanced output.
 *
 * Run: cd server && node --test core/forms/formCss.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FORM_CSS_MAX_CHARS, sanitizeFormCss } from './formCss.mts';

const clean = (css) => sanitizeFormCss(css).css;
const removed = (css) => sanitizeFormCss(css).removed;

/** Braces, brackets and strings close, so `.bf-form-scope { <css> }` ends where it should. */
function assertBalanced(css) {
    let depth = 0;
    let quote = '';
    for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (c === '\\') { assert.ok(i + 1 < css.length, 'no trailing backslash'); i += 1; continue; }
        if (quote) { if (c === quote || c === '\n') quote = ''; continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '{') depth += 1;
        if (c === '}') { depth -= 1; assert.ok(depth >= 0, `a } closes more than it opened in ${JSON.stringify(css)}`); }
    }
    assert.equal(quote, '', 'every string closes');
    assert.equal(depth, 0, `every { closes in ${JSON.stringify(css)}`);
}

describe('sanitizeFormCss', () => {
    test('ordinary CSS is kept byte for byte', () => {
        const css = [
            '.bf-form__card { background: #fffaf0; border-radius: 18px; box-shadow: 0 8px 24px rgb(0 0 0 / .12); }',
            '.bf-form__submit:hover { filter: brightness(1.05); }',
            '[data-field="email"] .bf-form__input { font-size: 1.1rem; }',
            '@media (max-width: 600px) { .bf-form__card { padding: 12px; } }',
            '@supports (backdrop-filter: blur(4px)) { .bf-form__card { backdrop-filter: blur(4px); } }',
            '@container (min-width: 400px) { .bf-form__actions { justify-content: end; } }',
            '& .bf-form__title { letter-spacing: -0.01em; }',
            '.bf-form__label::after { content: "\\2022"; }',
            '.bf-form__logo { position: relative; } .bf-form__progress { position: sticky; top: 0; }',
        ].join('\n');
        assert.deepEqual(sanitizeFormCss(css), { css, removed: [] });
    });

    test('nothing in, nothing out', () => {
        assert.deepEqual(sanitizeFormCss(''), { css: '', removed: [] });
        assert.deepEqual(sanitizeFormCss(null), { css: '', removed: [] });
        assert.deepEqual(sanitizeFormCss(42), { css: '', removed: [] });
    });

    test('over 20 000 characters: refused as a whole', () => {
        const big = `.a { color: red; }${' '.repeat(FORM_CSS_MAX_CHARS)}`;
        assert.deepEqual(sanitizeFormCss(big), { css: '', removed: ['over 20000 characters'] });
        const exact = `.a{}${' '.repeat(FORM_CSS_MAX_CHARS - 4)}`;
        assert.equal(sanitizeFormCss(exact).css, exact);
    });

    test('@import, @font-face, @charset and @namespace go, whole', () => {
        assert.deepEqual(sanitizeFormCss('@import url(https://fonts.example/x.css); .a { color: red }'),
            { css: ' .a { color: red }', removed: ['@import'] });
        assert.deepEqual(sanitizeFormCss('@IMPORT "x.css" screen;'), { css: '', removed: ['@import'] });
        assert.deepEqual(sanitizeFormCss('@font-face { font-family: X; src: url(/f.woff2); } .a { font-family: X }'),
            { css: ' .a { font-family: X }', removed: ['@font-face'] });
        assert.deepEqual(sanitizeFormCss('@charset "utf-8"; .a{}'), { css: ' .a{}', removed: ['@charset'] });
        assert.deepEqual(sanitizeFormCss('@namespace svg url(http://www.w3.org/2000/svg); .a{}'), { css: ' .a{}', removed: ['@namespace'] });
        assert.deepEqual(sanitizeFormCss('@media screen { @import "x.css"; .a { color: red } }'),
            { css: '@media screen { .a { color: red } }', removed: ['@import'] });
        assert.deepEqual(removed('@import "x.css"'), ['@import'], 'without a semicolon too');
    });

    test('url(): data:image/ and a same-origin path stay; everything else takes its declaration with it', () => {
        for (const ok of ['url(/api/assets/bg.png)', 'url("/img/a.png")', "url( '/img/a.png' )", 'url(data:image/png;base64,AAAA)',
            'url("DATA:IMAGE/svg+xml;utf8,%3Csvg%3E")']) {
            const css = `.a { background: ${ok}; }`;
            assert.deepEqual(sanitizeFormCss(css), { css, removed: [] }, ok);
        }
        for (const bad of ['url(https://evil.example/p.png)', 'url(http://evil.example/p.png)', 'url(//evil.example/p.png)',
            'url("/\\\\evil.example/p.png")', 'url(/\t/evil.example/p.png)', 'url( "  //evil.example" )', 'url(data:text/html,hi)',
            'url(#filter)', 'url(img/relative.png)', 'url()', 'URL(https://evil.example/p.png)', 'src(https://evil.example/p.png)']) {
            const out = sanitizeFormCss(`.a { color: red; background: ${bad}; padding: 1px }`);
            assert.equal(out.css, '.a { color: red; padding: 1px }', bad);
            assert.equal(out.removed.length, 1, bad);
            assert.deepEqual(out.removed, ['outside address'], bad);
        }
        assert.deepEqual(removed('.a { background: url(https://evil.example/p.png) }'), ['outside address']);
    });

    test('an external address in a custom property is caught where it is declared', () => {
        assert.deepEqual(sanitizeFormCss('.a { --bg: url(https://evil.example/p.png); background: var(--bg) }'),
            { css: '.a { background: var(--bg) }', removed: ['outside address'] });
    });

    test('image-set() and friends: an external string, or an address from var(), goes', () => {
        assert.deepEqual(sanitizeFormCss('.a { background: image-set("https://evil.example/a.png" 1x) }'),
            { css: '.a {}', removed: ['outside address'] });
        assert.deepEqual(removed('.a { background: -webkit-image-set("//evil.example/a.png" 1x) }'), ['outside address']);
        assert.deepEqual(removed('.a { --s: "https://evil.example/a.png"; background: image-set(var(--s) 1x) }'), ['address from var()']);
        assert.deepEqual(removed('.a { background: cross-fade(url(/a.png), attr(data-x)) }'), ['address from var()']);
        const ok = '.a { background: image-set("/a.png" 1x, "/a@2x.png" 2x) }';
        assert.deepEqual(sanitizeFormCss(ok), { css: ok, removed: [] });
    });

    test('expression(, behavior:, -moz-binding and javascript: take their declaration with them', () => {
        assert.deepEqual(sanitizeFormCss('.a { width: expression(alert(1)); color: red }'), { css: '.a { color: red }', removed: ['expression('] });
        assert.deepEqual(sanitizeFormCss('.a { behavior: url(/x.htc); color: red }'), { css: '.a { color: red }', removed: ['behavior:'] });
        assert.deepEqual(sanitizeFormCss('.a { -moz-binding: url(/x.xml#y); color: red }'), { css: '.a { color: red }', removed: ['-moz-binding'] });
        assert.deepEqual(sanitizeFormCss('.a { --x: "javascript:alert(1)"; color: red }'), { css: '.a { color: red }', removed: ['javascript:'] });
        assert.deepEqual(removed('.a { --x: "java\tscript:alert(1)" }'), ['javascript:'], 'a tab the URL parser would drop');
    });

    test('position: fixed goes; the other positions stay', () => {
        assert.deepEqual(sanitizeFormCss('.a { position: fixed; inset: 0 }'), { css: '.a { inset: 0 }', removed: ['position: fixed'] });
        assert.deepEqual(removed('.a { POSITION : Fixed !important }'), ['position: fixed']);
        assert.deepEqual(removed('.a { --p: fixed; position: var(--p) }'), ['position: var(--p)'], 'a variable cannot smuggle it in');
        for (const ok of ['static', 'relative', 'absolute', 'sticky', 'inherit']) {
            const css = `.a { position: ${ok} }`;
            assert.deepEqual(sanitizeFormCss(css), { css, removed: [] }, ok);
        }
    });

    test('</ and <!-- go wherever they are, also when removing one forms the next', () => {
        assert.deepEqual(sanitizeFormCss('.a { content: "</style><script>alert(1)</script>" }'),
            { css: '.a { content: "style><script>alert(1)script>" }', removed: ['</'] });
        assert.deepEqual(sanitizeFormCss('<!-- .a { color: red } -->'), { css: ' .a { color: red } -->', removed: ['<!--'] });
        const nested = clean('<<!--/style> .a{}');
        assert.ok(!nested.includes('</') && !nested.includes('<!--'), nested);
        const viaComment = clean('</**//style> .a{}');
        assert.ok(!viaComment.includes('</'), viaComment);
    });

    test('comments are stripped before anything is checked', () => {
        assert.deepEqual(sanitizeFormCss('/* hello */.a { color: red } /* bye */'), { css: '.a { color: red } ', removed: [] });
        assert.deepEqual(removed('.a { background: u/**/rl(https://evil.example/p.png) }'), ['outside address']);
        assert.deepEqual(removed('@im/* */port "x.css";'), ['@import']);
        assert.deepEqual(removed('.a { position: fix/**/ed }'), ['position: fixed']);
        assert.equal(clean('.a { color: red } /* never closed } body { display: none'), '.a { color: red } ');
        const keptInString = '.a { content: "/* not a comment */" }';
        assert.deepEqual(sanitizeFormCss(keptInString), { css: keptInString, removed: [] });
    });

    test('CSS escapes are decoded for the checks', () => {
        assert.deepEqual(removed('.a { background: \\75 rl(https://evil.example/p.png) }'), ['outside address']);
        assert.deepEqual(removed('.a { background: u\\72l(https://evil.example/p.png) }'), ['outside address']);
        assert.deepEqual(removed('@\\69mport "x.css";'), ['@import']);
        assert.deepEqual(removed('.a { background: url("\\2f\\2f evil.example/p.png") }'), ['outside address']);
        assert.deepEqual(removed('.a { position: \\66ixed }'), ['position: fixed']);
    });

    test('the scope cannot be closed from inside: a stray } goes, and the output is balanced', () => {
        assert.deepEqual(sanitizeFormCss('} body { display: none } .x {'),
            { css: '  body { display: none } .x {}', removed: ['unbalanced }'] });
        assert.equal(clean('.a { color: red'), '.a { color: red}');
        assert.equal(clean('.a { content: "abc'), '.a { content: "abc"}');
        assert.equal(clean('.a { background: url(/a.png'), '.a { background: url(/a.png)}');
        assert.equal(clean('.a { color: red }\\'), '.a { color: red }', 'a trailing backslash would escape the closing brace');
        assert.deepEqual(removed('.a { --x: f( } ); color: red }'), ['braces inside brackets']);
        for (const css of [
            '} } } body { display: none }', '.a { b { c { d', '.a { content: "}" } }', '.a { --x: "\\"}"; } }',
            '@media screen { .a { color: red } } }', '.a { content: "x\\', ':is(.a, .b { color: red }', '[data-x="}"] { color: red }',
            '.a { color: red } \\} body { display: none }', '@font-face { src: url(x) .a { color: red } } }',
        ]) {
            assertBalanced(clean(css));
        }
    });

    test('an unquoted url() is one token, as the browser reads it: a brace or quote inside cannot unbalance the scope', () => {
        // The browser ends this url at its `)`; the `"` inside is no string start, so the `}` after it is real.
        const css = '.a { background: url(/x"y) } body { display: none } .b { content: "q" }';
        const out = sanitizeFormCss(css);
        assert.deepEqual(out, { css, removed: [] }, 'balanced as it is: nothing to remove');
        assertBalanced(out.css.replace('url(/x"y)', 'url(/xy)'));
        // A `}` INSIDE the url token is not a brace: counting it would let the next real one close the scope.
        assert.deepEqual(sanitizeFormCss('.a { background: url(/a}b) } } body { display: none }'),
            { css: '.a { background: url(/a}b) }   body { display: none }', removed: ['unbalanced }'] });
        assert.equal(clean('.a { background: url(/a.png'), '.a { background: url(/a.png)}');
        assert.equal(clean('.a { background: url(/a.png\\'), '.a { background: url(/a.png)}', 'a trailing backslash would escape the closing )');
        assert.equal(clean('.a { background: url(/a/*b*/.png) }'), '.a { background: url(/a/*b*/.png) }', 'no comment inside a url token');
        assert.deepEqual(removed('.a { background: \\55rl(https://evil.example/p.png) }'), ['outside address']);
    });

    test('a selector that reaches out of the scope through nesting goes with its block', () => {
        for (const prelude of ['& ~ *', '& + .x', '~ div', '+ *', '.a, ~ p', ':is(& ~ div)', '\\26  ~ div', '&~*']) {
            const out = sanitizeFormCss(`${prelude} { display: none } .ok { color: red }`);
            assert.deepEqual(out, { css: ' .ok { color: red }', removed: ['sibling selector'] }, prelude);
        }
        assert.deepEqual(removed('@media screen { & ~ div { display: none } }'), ['sibling selector']);
        for (const ok of ['& > .bf-form__card', '.bf-form__field + .bf-form__field', '& .a ~ .b', '.a:nth-child(2n+1)']) {
            const css = `${ok} { color: red }`;
            assert.deepEqual(sanitizeFormCss(css), { css, removed: [] }, ok);
        }
    });

    test('only @media, @supports and @container stay; every other at-rule goes, its block with it', () => {
        assert.deepEqual(sanitizeFormCss('@keyframes pulse { from { opacity: 0 } to { opacity: 1 } } .a { color: red }'),
            { css: ' .a { color: red }', removed: ['@keyframes'] });
        assert.deepEqual(removed('@layer base; @page { margin: 0 }'), ['@layer', '@page']);
    });

    test('escaped braces and braces in strings are not structure', () => {
        const css = '.a\\{ { content: "{" } [data-x="}"] { color: red }';
        assert.deepEqual(sanitizeFormCss(css), { css, removed: [] });
    });

    test('a rule whose selector carries a banned token goes with its whole block', () => {
        assert.deepEqual(sanitizeFormCss('a[href^="javascript:"] { color: red; } .b { color: blue }'),
            { css: ' .b { color: blue }', removed: ['javascript:'] });
    });

    test('the output is a fixed point: sanitising it again changes nothing', () => {
        for (const css of [
            '} body { display: none } .x {', '<<!--/style> .a{}', '.a { background: u/**/rl(https://e.example) } }',
            '@import "a"; @font-face { src: url(x) } .a { position: fixed; color: red', '.a { content: "abc',
        ]) {
            const once = sanitizeFormCss(css).css;
            assert.deepEqual(sanitizeFormCss(once), { css: once, removed: [] }, css);
        }
    });

    test('each kind of removal is reported once', () => {
        assert.deepEqual(removed('@import "a"; @import "b"; .a { position: fixed } .b { position: fixed }'), ['@import', 'position: fixed']);
    });
});
