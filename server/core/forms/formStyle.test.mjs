/**
 * core/forms/formStyle.mts: the form-only look (`form.style`): the spec, the
 * canonical form a renderer reads, the save-time issues and the per-key
 * inheritance of a page. The CSS sanitiser has its own tests (formCss.test.mjs).
 *
 * Run: cd server && node --test core/forms/formStyle.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    FORM_STYLE_SPEC, FORM_CSS_MAX_CHARS, canonicalizeFormStyle, validateFormStyle, isSameOriginPath, overInherited, styleEntry,
    sanitizeFormCss,
} from './formStyle.mts';
import { sanitizeFormCss as sanitizeFromItsModule } from './formCss.mts';

describe('FORM_STYLE_SPEC', () => {
    test('the knobs of the contract, nothing else', () => {
        assert.deepEqual(Object.keys(FORM_STYLE_SPEC).sort(), [
            'align', 'button', 'cardColor', 'customCss', 'font', 'footerText', 'inputStyle', 'labelColor',
            'labelStyle', 'logoUrl', 'textColor', 'width',
        ]);
        assert.deepEqual(FORM_STYLE_SPEC.font.values, ['system', 'inter', 'serif', 'mono', 'rounded']);
        assert.deepEqual(Object.keys(FORM_STYLE_SPEC.button.fields), ['width', 'shape', 'textColor']);
        assert.equal(FORM_CSS_MAX_CHARS, 20000);
    });
});

describe('canonicalizeFormStyle', () => {
    test('nothing set is {}: no defaults are filled in', () => {
        assert.deepEqual(canonicalizeFormStyle(undefined), {});
        assert.deepEqual(canonicalizeFormStyle(null), {});
        assert.deepEqual(canonicalizeFormStyle([]), {});
        assert.deepEqual(canonicalizeFormStyle({}), {});
    });

    test('valid values stay, unknown keys and invalid or cleared values go', () => {
        const out = canonicalizeFormStyle({
            font: 'serif', width: 'wide', align: 'center', cardColor: '#FFFFFF', textColor: null, labelColor: 'red',
            labelStyle: 'inside', inputStyle: 'filled', logoUrl: '/api/assets/logo.png', footerText: '  Made with care  ',
            secret: 'x', __proto__: { polluted: true },
        });
        assert.deepEqual(out, {
            font: 'serif', width: 'wide', align: 'center', cardColor: '#FFFFFF', labelStyle: 'inside', inputStyle: 'filled',
            logoUrl: '/api/assets/logo.png', footerText: 'Made with care',
        });
    });

    test('button keeps its valid sub-keys and is absent when none is valid', () => {
        assert.deepEqual(canonicalizeFormStyle({ button: { width: 'full', shape: 'oval', textColor: '#000000', extra: 1 } }).button,
            { width: 'full', textColor: '#000000' });
        assert.equal('button' in canonicalizeFormStyle({ button: { shape: 'oval' } }), false);
        assert.equal('button' in canonicalizeFormStyle({ button: 'pill' }), false);
    });

    test('logoUrl: only a same-origin path', () => {
        for (const bad of ['https://cdn.example.com/logo.png', '//evil.example/logo.png', '/\\evil.example/x', 'logo.png',
            'javascript:alert(1)', '/a b.png', `/${'a'.repeat(512)}`, '/x"onerror="y']) {
            assert.equal('logoUrl' in canonicalizeFormStyle({ logoUrl: bad }), false, bad);
            assert.equal(isSameOriginPath(bad), false, bad);
        }
        assert.equal(canonicalizeFormStyle({ logoUrl: '/files/logo.svg?v=2' }).logoUrl, '/files/logo.svg?v=2');
    });

    test('footerText: plain text up to 300 characters', () => {
        assert.equal('footerText' in canonicalizeFormStyle({ footerText: 'x'.repeat(301) }), false);
        assert.equal('footerText' in canonicalizeFormStyle({ footerText: '   ' }), false);
        assert.equal(canonicalizeFormStyle({ footerText: 'x'.repeat(300) }).footerText.length, 300);
    });

    test('customCss is stored sanitised, and dropped when over the cap or empty after sanitising', () => {
        assert.equal(canonicalizeFormStyle({ customCss: '@import url(https://x/y.css); .bf-form__card { padding: 2rem }' }).customCss,
            ' .bf-form__card { padding: 2rem }');
        assert.equal('customCss' in canonicalizeFormStyle({ customCss: `.a{color:red}${' '.repeat(FORM_CSS_MAX_CHARS)}` }), false);
        assert.equal('customCss' in canonicalizeFormStyle({ customCss: '@import "x.css";' }), false);
    });
});

describe('validateFormStyle', () => {
    const codes = (issues) => issues.map((i) => i.code).sort();

    test('absent is valid; a non-object is one shape issue', () => {
        assert.deepEqual(validateFormStyle(undefined), []);
        assert.deepEqual(validateFormStyle(null), []);
        const issues = validateFormStyle('dark', 'form.style');
        assert.equal(issues.length, 1);
        assert.deepEqual({ ...issues[0], hint: '' }, { code: 'style_shape', path: 'form.style', message: 'style must be an object.', hint: '' });
        assert.match(issues[0].hint, /customCss/);
    });

    test('every wrong value is named by path, in the shape validateTheme returns', () => {
        const issues = validateFormStyle({
            font: 'comic', cardColor: 'blue', textColor: null, glow: true,
            button: { shape: 'blob', textColor: '#zzzzzz', size: 'xl' },
            logoUrl: 'https://cdn.example.com/x.png', footerText: 5, customCss: 'x'.repeat(FORM_CSS_MAX_CHARS + 1),
        }, 'form.style');
        assert.deepEqual(codes(issues), [
            'style_color', 'style_color', 'style_css_too_long', 'style_enum', 'style_enum', 'style_logo_url', 'style_text',
            'style_unknown_key', 'style_unknown_key',
        ]);
        assert.deepEqual(issues.map((i) => i.path).sort(), [
            'form.style.button.shape', 'form.style.button.size', 'form.style.button.textColor', 'form.style.cardColor',
            'form.style.customCss', 'form.style.font', 'form.style.footerText', 'form.style.glow', 'form.style.logoUrl',
        ]);
        for (const i of issues) {
            assert.deepEqual(Object.keys(i).sort(), ['code', 'hint', 'message', 'path']);
        }
    });

    test('a full valid style and every null clear pass', () => {
        assert.deepEqual(validateFormStyle({
            font: 'rounded', width: 'narrow', align: 'left', cardColor: '#112233', textColor: '#445566', labelColor: null,
            labelStyle: 'above', inputStyle: 'underlined', button: { width: 'auto', shape: 'pill', textColor: null },
            logoUrl: null, footerText: null, customCss: null,
        }), []);
        assert.deepEqual(validateFormStyle({ button: null, customCss: '@import "x";' }), [], 'a removal is not a save error');
    });

    test('the CSS cap is 20 000 characters exactly', () => {
        assert.deepEqual(validateFormStyle({ customCss: 'x'.repeat(FORM_CSS_MAX_CHARS) }), []);
        assert.equal(validateFormStyle({ customCss: 'x'.repeat(FORM_CSS_MAX_CHARS + 1) })[0].code, 'style_css_too_long');
    });
});

describe('overInherited', () => {
    test('a page without its own takes the inherited one; its own keys win, null included', () => {
        const base = { font: 'serif', width: 'wide' };
        assert.equal(overInherited(undefined, base), base);
        assert.equal(overInherited(null, null), null);
        assert.deepEqual(overInherited({ width: 'narrow', cardColor: null }, base), { font: 'serif', width: 'narrow', cardColor: null });
        assert.deepEqual(overInherited({ width: 'narrow' }, 'nonsense'), { width: 'narrow' });
    });
});

describe('styleEntry', () => {
    test('a rendered form carries style only when a knob is set', () => {
        assert.deepEqual(styleEntry(undefined), {});
        assert.deepEqual(styleEntry({ font: 'comic', glow: 1 }), {});
        assert.deepEqual(styleEntry({ font: 'mono' }), { style: { font: 'mono' } });
    });
});

describe('the sanitiser is re-exported', () => {
    test('formStyle.mts hands out the one in formCss.mts', () => {
        assert.equal(sanitizeFormCss, sanitizeFromItsModule);
    });
});
