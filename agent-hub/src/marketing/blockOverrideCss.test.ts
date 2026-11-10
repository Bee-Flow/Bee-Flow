/**
 * The style rule of a block's colour overrides (blockOverrideCss.ts): a stored colour is written
 * exactly as before, a value that is not a colour is no override.
 */
import { describe, expect, it } from 'vitest';
import { buildBlockOverrideCss } from './blockOverrideCss';
import type { BlockStyle } from './ProductWebsite.types';

const ALIASES = '--accent: var(--brand-primary); --accent-light: var(--brand-accent); --bg-primary: var(--brand-bg); --bg-secondary: var(--brand-surface); --text-primary: var(--brand-text); --text-secondary: var(--brand-text-secondary);';
const tail = (sel: string) => ` .marketing-root.cms-gradient ${sel} { --accent-gradient: linear-gradient(135deg, var(--brand-primary) 0%, var(--brand-accent) 100%); } .marketing-root:not(.cms-gradient) ${sel} { --accent-gradient: var(--brand-primary); }`;
const SEL = '[data-cms-block-id="blk_a1-B2"]';
const css = (colorOverrides: unknown, id = 'blk_a1-B2') => buildBlockOverrideCss(id, { colorOverrides } as BlockStyle);

describe('buildBlockOverrideCss', () => {
    it('writes every stored colour form as it is (the rule of before)', () => {
        expect(css({
            primary: '#112233', secondary: '#abc', accent: 'rgba(1, 2, 3, 0.5)', background: 'hsl(210 50% 40%)',
            surface: 'var(--brand-bg)', text: 'white', textSecondary: '#11223344',
        })).toBe(`${SEL} { --brand-primary: #112233; --brand-secondary: #abc; --brand-accent: rgba(1, 2, 3, 0.5); --brand-bg: hsl(210 50% 40%); --brand-surface: var(--brand-bg); --brand-text: white; --brand-text-secondary: #11223344; ${ALIASES} color: var(--text-primary); background-color: var(--bg-primary); }${tail(SEL)}`);
    });

    it('one override gives one declaration and no repaint', () => {
        expect(css({ primary: '#112233' })).toBe(`${SEL} { --brand-primary: #112233; ${ALIASES} }${tail(SEL)}`);
    });

    it('gives no rule without overrides, without an id, or for an empty value', () => {
        expect(buildBlockOverrideCss('blk_1', undefined)).toBeNull();
        expect(buildBlockOverrideCss('blk_1', {} as BlockStyle)).toBeNull();
        expect(buildBlockOverrideCss(undefined, { colorOverrides: { primary: '#112233' } } as BlockStyle)).toBeNull();
        expect(css({})).toBeNull();
        expect(css({ primary: '', text: '' })).toBeNull();
        expect(css('red')).toBeNull();
    });

    it('a value that is not a colour is no override; the colours beside it are written', () => {
        const bad = ['red; background: url(//example.test/x)', 'red } body { display: none', 'url(x)', '</style><script>', 'var(--a, url(x))', 3, null, { a: 1 }];
        for (const value of bad) {
            expect(css({ primary: value }), JSON.stringify(value)).toBeNull();
            expect(css({ primary: '#112233', text: value }), JSON.stringify(value)).toBe(`${SEL} { --brand-primary: #112233; ${ALIASES} }${tail(SEL)}`);
        }
    });

    it('writes letters, digits, "_" and "-" of the id as they are and escapes every other character', () => {
        const out = css({ primary: '#112233' }, 'blk"] {x}\\');
        const sel = '[data-cms-block-id="blk\\5d \\20 \\7b x\\7d \\5c "]';
        expect(out).toBe(`${sel} { --brand-primary: #112233; ${ALIASES} }${tail(sel)}`);
        expect(css({ primary: '#112233' }, '"""')).toBeNull();
    });

    it('the escaped selector still matches the block whose id it names', () => {
        for (const id of ['blk.main', 'hero section', 'blk\\x', 'blk]', 'blök']) {
            const el = document.createElement('div');
            el.setAttribute('data-cms-block-id', id);
            const rule = css({ primary: '#112233' }, id) as string;
            const selector = rule.slice(0, rule.indexOf(' {'));
            expect(el.matches(selector), id).toBe(true);
        }
    });
});
