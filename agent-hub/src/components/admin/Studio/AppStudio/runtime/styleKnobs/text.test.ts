import { describe, expect, it } from 'vitest';
import { resolveNodeStyle } from '../styleResolver';

const node = (style: Record<string, unknown>) => resolveNodeStyle({ style } as never);

describe('text knobs', () => {
    it('emit nothing for a style that does not set them', () => {
        const { className, style } = node({ span: 6, color: 'primary', weight: 'semibold' });
        expect(className).not.toMatch(/app-tk-/);
        expect(Object.keys(style)).not.toContain('letterSpacing');
        expect(Object.keys(style)).not.toContain('textTransform');
    });

    it('emit nothing for the identity value of each knob', () => {
        const { className, style } = node({ font: 'body', textSize: 'auto', lineHeight: 'auto', tracking: 'auto', transform: 'none' });
        expect(className).not.toMatch(/app-tk-/);
        expect(style).toEqual({ gridColumn: 'span 12 / span 12' });
    });

    it('size brings its line height and a class that hands both to the root', () => {
        const { className, style } = node({ textSize: '4xl' });
        expect(style).toMatchObject({ fontSize: '2.25rem', lineHeight: 1.15 });
        expect(className).toContain(' app-tk-size');
    });

    it('lets lineHeight win over the leading a size brings', () => {
        const { className, style } = node({ textSize: '2xl', lineHeight: 'relaxed' });
        expect(style).toMatchObject({ fontSize: '1.5rem', lineHeight: 1.625 });
        expect(className.match(/app-tk-size/g)).toHaveLength(1);
        expect(className).not.toContain('app-tk-lh');
    });

    it('lineHeight alone, tracking, transform and font', () => {
        const { className, style } = node({ lineHeight: 'tight', tracking: 'wide', transform: 'uppercase', font: 'mono' });
        expect(style).toMatchObject({ lineHeight: 1.25, letterSpacing: '0.05em', textTransform: 'uppercase' });
        expect(String(style.fontFamily)).toContain('--app-font-mono');
        expect(className).toContain('app-tk-lh');
        expect(className).toContain('app-tk-tracking');
    });

    it('heading follows the heading font variable and falls back to the inherited font', () => {
        expect(node({ font: 'heading' }).style.fontFamily).toBe('var(--app-font-heading, inherit)');
    });

    it('ignores an unknown value', () => {
        const { className, style } = node({ textSize: '9xl', tracking: 'constructor', font: '__proto__' });
        expect(className).not.toMatch(/app-tk-/);
        expect(style.fontSize).toBeUndefined();
        expect(style.fontFamily).toBeUndefined();
    });

    it('weight bold is 700', () => {
        expect(node({ weight: 'bold' }).style.fontWeight).toBe(700);
        expect(node({ weight: 'semibold' }).style.fontWeight).toBe(600);
    });
});
