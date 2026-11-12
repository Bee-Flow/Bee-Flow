// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    canvasVars, formStyleClasses, formStyleVars, formWidthClass, mergeFormStyle, readFormStyle, safeLogoUrl, scopedFormCss,
} from './formStyleVars';

describe('readFormStyle', () => {
    it('keeps known keys with valid values and never invents a key', () => {
        expect(readFormStyle({ font: 'serif', width: 'huge', cardColor: '#ffeedd', textColor: 'red', extra: 1, button: { shape: 'pill', width: 'half' } }))
            .toEqual({ font: 'serif', cardColor: '#ffeedd', button: { shape: 'pill' } });
        expect(readFormStyle(null)).toEqual({});
        expect(readFormStyle([])).toEqual({});
    });

    it('drops a logo that is not a same-origin path', () => {
        expect(readFormStyle({ logoUrl: 'https://cdn.example/logo.png' })).toEqual({});
        expect(readFormStyle({ logoUrl: '/brand/logo.svg' })).toEqual({ logoUrl: '/brand/logo.svg' });
    });
});

describe('safeLogoUrl', () => {
    it.each([
        ['/logo.png', '/logo.png'],
        ['//cdn.example/logo.png', null],
        ['/\\cdn.example/logo.png', null],
        ['https://cdn.example/logo.png', null],
        ['logo.png', null],
        ['/a b.png', null],
        [`/${'x'.repeat(600)}`, null],
        [42, null],
    ])('%s → %s', (input, expected) => {
        expect(safeLogoUrl(input)).toBe(expected);
    });
});

describe('formStyleVars', () => {
    it('is empty for no style, so an old form looks exactly as it did', () => {
        expect(formStyleVars(undefined)).toEqual({});
        expect(formStyleVars({})).toEqual({});
    });

    it('maps each knob to its variable', () => {
        const vars = formStyleVars({ font: 'mono', width: 'wide', align: 'center', labelColor: '#123456', inputStyle: 'underlined', button: { shape: 'pill', textColor: '#fafafa', width: 'auto' } });
        expect(vars['--bf-font']).toMatch(/monospace/);
        expect(vars['--bf-form-width']).toBe('860px');
        expect(vars['--bf-align']).toBe('center');
        expect(vars['--bf-align-self']).toBe('center');
        expect(vars['--bf-label']).toBe('#123456');
        expect(vars['--bf-input-border-width']).toBe('0 0 1px 0');
        expect(vars['--bf-button-radius']).toBe('999px');
        expect(vars['--bf-button-text']).toBe('#fafafa');
        // A fitted button follows the title's alignment.
        expect(vars['--bf-button-align']).toBe('center');
    });

    it('re-points the text tokens at the text colour, so every field follows it', () => {
        const vars = formStyleVars({ textColor: '#222222' });
        expect(vars['--text-primary']).toBe('#222222');
        expect(vars['--text-secondary']).toContain('#222222');
    });

    it('gives a dark card light text when no text colour was chosen', () => {
        const vars = formStyleVars({ cardColor: '#101010' });
        expect(vars['--bf-card-bg']).toBe('#101010');
        expect(vars['--text-primary']).toBe('#f8fafc');
        expect(formStyleVars({ cardColor: '#fffbeb' })['--text-primary']).toBe('#111827');
    });
});

describe('formStyleClasses / formWidthClass / canvasVars', () => {
    it('names each chosen option as a modifier', () => {
        expect(formStyleClasses({ labelStyle: 'inside', inputStyle: 'filled', button: { width: 'full' } }))
            .toBe('bf-form--labels-inside bf-form--inputs-filled bf-form--button-full');
        expect(formStyleClasses({})).toBe('');
    });

    it('gives the page container a width class, max-w-xl when none was chosen', () => {
        expect(formWidthClass({ width: 'narrow' })).toBe('max-w-[480px]');
        expect(formWidthClass(null)).toBe('max-w-xl');
    });

    it('paints the canvas only when the theme has one', () => {
        expect(canvasVars({ canvas: '#fef3c7' })).toEqual({ '--app-canvas': '#fef3c7' });
        expect(canvasVars({ canvas: 'url(x)' })).toEqual({});
        expect(canvasVars(null)).toEqual({});
    });
});

describe('mergeFormStyle', () => {
    it('lays a later page\'s own keys over the first page\'s, the button key by key', () => {
        expect(mergeFormStyle({ font: 'serif', button: { shape: 'pill', width: 'auto' } }, { width: 'wide', button: { shape: 'square' } }))
            .toEqual({ font: 'serif', width: 'wide', button: { shape: 'square', width: 'auto' } });
        expect(mergeFormStyle(null, null)).toEqual({});
    });
});

describe('scopedFormCss', () => {
    it('puts the sanitised CSS inside an @scope of this form\'s root', () => {
        const sheet = scopedFormCss({ customCss: '.bf-form__title { color: #7c2d12; } .a { background: url(https://x.example/a.png); }' }, 'r1');
        expect(sheet.startsWith('@scope (.bf-form-scope[data-bf-scope="r1"]) {\n:scope {\n')).toBe(true);
        expect(sheet).toContain('.bf-form__title { color: #7c2d12; }');
        expect(sheet).not.toContain('x.example');
        expect(sheet.trim().endsWith('}')).toBe(true);
    });

    it('keeps selectors that name the form inside :has() or :is() within the @scope, where they cannot match outside the form', () => {
        for (const customCss of ['html:has(&) body { display: none; }', ':is(&) ~ div { color: red; }']) {
            const sheet = scopedFormCss({ customCss }, 'r1');
            expect(sheet.startsWith('@scope (.bf-form-scope[data-bf-scope="r1"]) {')).toBe(true);
            expect(sheet.trim().endsWith('}\n}')).toBe(true);
            expect(sheet.indexOf(customCss.split(' {')[0])).toBeGreaterThan(sheet.indexOf(':scope {'));
        }
    });

    it('is empty without custom CSS, or when nothing survives', () => {
        expect(scopedFormCss({}, 'r1')).toBe('');
        expect(scopedFormCss({ customCss: '@import "/x.css";' }, 'r1')).toBe('');
    });
});
