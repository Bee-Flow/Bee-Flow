import { describe, expect, it } from 'vitest';
import { resolveNodeStyle } from '../styleResolver';
import { BOX_SHADOWS, resolveBoxBorderColor, resolveBoxFill } from '../styleResolver/box';
import type { StyleKnobs } from '../styleResolver.types';

const resolve = (style: Record<string, unknown>) => resolveNodeStyle({ style: style as StyleKnobs });

describe('box knob group on the grid cell', () => {
    it('a style without the knobs, or with their identity values, resolves exactly as before', () => {
        const base = { span: 6, padding: 3, background: 'surface', border: 'default', radius: 'md' };
        const before = resolve(base);
        expect(resolve({ ...base, marginTop: 0, marginBottom: 0, shadow: 'none', opacity: 100 })).toEqual(before);
        expect(resolve({ ...base, backgroundColor: null, borderColor: null })).toEqual(before);
    });

    it('margins are spacing steps, shadow the semantic tokens, opacity a fraction', () => {
        const { style, className } = resolve({ span: 6, marginTop: 2, marginBottom: 8, shadow: 'lg', opacity: 40 });
        expect(style.marginTop).toBe('calc(8px * var(--app-space, 1))');
        expect(style.marginBottom).toBe('calc(32px * var(--app-space, 1))');
        expect(style.boxShadow).toBe('var(--app-shadow-3)');
        expect(style.opacity).toBe(0.4);
        expect(className).toBe(resolve({ span: 6 }).className);
        expect(BOX_SHADOWS).toEqual({ sm: 'var(--app-shadow-1)', md: 'var(--app-shadow-2)', lg: 'var(--app-shadow-3)' });
    });

    it('backgroundColor wins over background: a hex as written, a role as a wash over the card surface', () => {
        expect(resolve({ background: 'gradient', backgroundColor: '#fef3c7' }).style.background).toBe('#fef3c7');
        expect(resolve({ backgroundColor: 'primary' }).style.background).toBe('color-mix(in srgb, var(--app-primary) 14%, var(--bg-card))');
        expect(resolveBoxFill('danger')).toBe('color-mix(in srgb, #ef4444 14%, var(--bg-card))');
        expect(resolveBoxFill('#abc')).toBeNull();
        expect(resolveBoxFill('url(x)')).toBeNull();
    });

    it('a border knob draws a solid border on the chosen sides and replaces the border knob', () => {
        const left = resolve({ border: 'default', borderSides: 'left', borderWidth: 3, borderColor: 'primary' }).style;
        expect(left.border).toBeUndefined();
        expect(left).toMatchObject({ borderStyle: 'solid', borderWidth: '0px 0px 0px 3px', borderColor: 'var(--app-primary)' });
        expect(resolve({ borderWidth: 2 }).style).toMatchObject({ borderWidth: '2px 2px 2px 2px', borderColor: 'var(--border-color, var(--border-default))' });
        expect(resolve({ borderColor: '#123456' }).style).toMatchObject({ borderWidth: '1px 1px 1px 1px', borderColor: '#123456' });
        expect(resolve({ borderSides: 'y' }).style.borderWidth).toBe('1px 0px 1px 0px');
        expect(resolve({ borderSides: 'x' }).style.borderWidth).toBe('0px 1px 0px 1px');
        expect(resolveBoxBorderColor(null)).toBe('var(--border-color, var(--border-default))');
    });

    it('the node keeps its surface class, so the hairline rules still apply where no border is set', () => {
        expect(resolve({ background: 'surface', shadow: 'sm' }).className).toContain('app-surface');
    });
});
