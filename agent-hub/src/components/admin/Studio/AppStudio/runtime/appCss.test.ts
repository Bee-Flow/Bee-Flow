import { describe, it, expect } from 'vitest';
import snapshot from './catalogSnapshot.generated.json';
import { APP_CSS_MAX, CSS_CLASS_MAX, isCssClassName, resolveCssAssets, sanitizeAppCssClient, withAuthorClass, wrapAppCss } from './appCss';
import { assetUrl } from './assets/assetUrl';
import { sanitizeFormCssClient } from '@/components/forms/formCssSanitizer';
import vectorFile from '../../../../../../../server/appStudio/appCss.vectors.json';

/**
 * The client half of the app's stylesheet rules. The vectors are the ones the server half
 * runs (server/appStudio/appCss.test.js): both must name the same removals.
 */

const sorted = (list: string[]) => [...list].sort();

describe('sanitizeAppCssClient: the vectors the server runs too', () => {
    for (const vector of vectorFile.vectors) {
        it(vector.name, () => {
            const { css, removed } = sanitizeAppCssClient(vector.css);
            expect(sorted(removed)).toEqual(sorted(vector.removed));
            for (const kept of vector.keeps) expect(css).toContain(kept);
            for (const gone of vector.drops) expect(css).not.toContain(gone);
            // Sanitising what was kept again takes nothing more out.
            expect(sanitizeAppCssClient(css).removed).toEqual([]);
        });
    }
});

describe('sanitizeAppCssClient', () => {
    it('is stricter than a form about addresses on this server', () => {
        const css = '.a{background:url(/api/users/me)}';
        expect(sanitizeFormCssClient(css).removed).toEqual([]);
        expect(sanitizeAppCssClient(css)).toEqual({ css: '.a{}', removed: ['outside address'] });
        expect(sanitizeFormCssClient('.a{background:url(asset:abc)}').removed).toEqual(['outside address']);
        expect(sanitizeAppCssClient('.a{background:url(asset:abc)}').removed).toEqual([]);
    });

    it('takes nothing but text of at most the limit', () => {
        expect(APP_CSS_MAX).toBe(snapshot.limits.MAX_CUSTOM_CSS_LEN);
        expect(CSS_CLASS_MAX).toBe(snapshot.limits.MAX_CSS_CLASS_LEN);
        for (const value of [undefined, null, 7, {}, '   ']) expect(sanitizeAppCssClient(value)).toEqual({ css: '', removed: [] });
        expect(sanitizeAppCssClient(`.a{color:red}${' '.repeat(APP_CSS_MAX)}`)).toEqual({ css: '', removed: [`over ${APP_CSS_MAX} characters`] });
    });

    it('refuses an image built from a variable, whatever the function is called', () => {
        for (const css of [
            '.a{background:-webkit-image-set(var(--x) 1x)}',
            '.a{background:image(var(--x))}',
            '.a{background:cross-fade(attr(data-x), url(asset:a))}',
            '.a{--x:"/api/users/me";background:IMAGE-SET(var(--x) 1x)}',
        ]) {
            const out = sanitizeAppCssClient(css);
            expect(out.removed, css).toEqual(['address from var()']);
            expect(out.css.toLowerCase(), css).not.toContain('image');
        }
    });
});

describe('what only looks like a token hides no closing brace', () => {
    it('reads url( after a hash, an at-sign or a longer name, and a string over CR LF, as the browser does', () => {
        for (const text of [
            'a{color:#url(data:image/x " ) " ) } } nav{color:red} b{c:" }',
            'a{color:@url(data:image/x " ) " ) } } nav{color:red} b{c:" }',
            'a{b:\u00e9url(data:image/x " ) " ) } } nav{color:red} b{c:" }',
            'a{b:"\\\r\n" } } nav{color:red} c{d:"}',
            'a{b:url(\u00a0"data:image/x\n x{ ) } } nav{color:red}',
        ]) {
            for (const sanitize of [sanitizeAppCssClient, sanitizeFormCssClient]) {
                const { css, removed } = sanitize(text);
                expect(removed, `${JSON.stringify(text)} → ${JSON.stringify(css)}`).toContain('unbalanced }');
                expect(css).not.toContain('\r');
            }
        }
    });

    it('refuses a position that is not a plain keyword', () => {
        expect(sanitizeAppCssClient('.a{--p:fixed;position:var(--p);top:0}')).toEqual({ css: '.a{--p:fixed;top:0}', removed: ['position: var(--p)'] });
        expect(sanitizeAppCssClient('.a{position:absolute !important}').removed).toEqual([]);
        expect(sanitizeAppCssClient('.a{position:sticky}').removed).toEqual([]);
    });
});

describe('wrapAppCss', () => {
    it('scopes the text to the app root and leaves empty text empty', () => {
        expect(wrapAppCss('.a{color:red}')).toBe('.app-shell:has([data-app-css-root]) { position: relative; overflow: clip; }\n@scope ([data-app-css-root]) {\n.a{color:red}\n}');
        expect(wrapAppCss(' \n')).toBe('');
    });
});

describe('resolveCssAssets', () => {
    const signedIn = { appId: 'app_1' };
    const at = (id: string) => assetUrl(`asset:${id}`, signedIn);

    it('turns a whole-argument asset reference into the address of this page', () => {
        expect(resolveCssAssets('.a{background:url(asset:abc)}', signedIn)).toBe(`.a{background:url(${at('abc')})}`);
        expect(resolveCssAssets('.a{background:url( "asset:a-b_1" )}', signedIn)).toBe(`.a{background:url(${at('a-b_1')})}`);
        expect(resolveCssAssets(".a{background:URL('asset:abc') center}", signedIn)).toBe(`.a{background:URL(${at('abc')}) center}`);
        expect(at('abc')).toMatch(/\/api\/studio-apps\/app_1\/assets\/abc$/);
        const viaToken = resolveCssAssets('.a{background:url(asset:abc)}', { publicToken: 'tok' });
        expect(viaToken).toBe(`.a{background:url(${assetUrl('asset:abc', { publicToken: 'tok' })})}`);
        expect(viaToken).toContain('/api/public-app/tok/assets/abc)');
    });

    it('leaves everything else exactly as it is', () => {
        for (const css of [
            '.a{color:red}',
            '.a{background:url(data:image/png;base64,AAAA)}',
            '.a::after{content:"url(asset:abc)"}',
            ".a::after{content:'x\\'url(asset:abc)'}",
            '.a{background:url(asset:abc/extra)}',
            '.a{background:url("asset:abc)}',
            '.a{background:curl(asset:abc)}',
            '.a{background:url(asset:)}',
            '.a{background:url\\(asset:abc)}',
        ]) expect(resolveCssAssets(css, signedIn), css).toBe(css);
    });

    it('writes nothing without an address for this page', () => {
        const css = '.a{background:url(asset:abc)}';
        expect(resolveCssAssets(css, {})).toBe(css);
        // An app id that is not plain address characters is never written into the text.
        expect(resolveCssAssets(css, { appId: 'a) } body{color:red' })).not.toContain('body{color:red');
    });
});

describe('the author class of a node', () => {
    it('accepts a lower-case name only', () => {
        for (const ok of ['a', 'hero', 'hero-2', 'a'.repeat(CSS_CLASS_MAX)]) expect(isCssClassName(ok), ok).toBe(true);
        for (const bad of ['', 'Hero', '2col', '-x', 'a b', 'a_b', 'a.b', 'a'.repeat(CSS_CLASS_MAX + 1), null, 3]) expect(isCssClassName(bad), String(bad)).toBe(false);
    });

    it('adds u-<name> to the cell and changes nothing without a valid name', () => {
        expect(withAuthorClass('app-span-6', { cssClass: 'hero' })).toBe('app-span-6 u-hero');
        expect(withAuthorClass(undefined, { cssClass: 'hero' })).toBe('u-hero');
        expect(withAuthorClass('app-span-6', {})).toBe('app-span-6');
        expect(withAuthorClass('app-span-6', { cssClass: 'x y' })).toBe('app-span-6');
        expect(withAuthorClass(undefined, { cssClass: null })).toBeUndefined();
    });
});
