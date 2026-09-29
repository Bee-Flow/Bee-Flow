import { describe, it, expect } from 'vitest';
import { categoryStyle, confidenceLabel } from './dlpCategoryColors';

const t = (key: string, fallback?: string) => fallback ?? key;

describe('confidenceLabel', () => {
    it('never renders a number — only category-agnostic words', () => {
        for (const band of ['high', 'medium', 'low', null] as const) {
            const label = confidenceLabel('pii', band, t);
            expect(label).not.toMatch(/\d/);
        }
    });

    it('a manual mark reads as "marked by you", regardless of band', () => {
        expect(confidenceLabel('manual', null, t)).toBe('Marked by you');
    });

    it('a custom term reads as "custom rule", regardless of band', () => {
        expect(confidenceLabel('custom', null, t)).toBe('Custom rule');
    });

    it('a pii finding with no band still returns a sensible label, not a crash', () => {
        expect(confidenceLabel('pii', null, t)).toBe('High confidence');
    });
});

describe('categoryStyle', () => {
    it('resolves to the category-token custom property, not a raw hex', () => {
        const style = categoryStyle('Person', 'high');
        expect(style.color).toBe('var(--pii-cat-1)');
        expect(style.borderColor).toBe('var(--pii-cat-1)');
        expect(style.background).toContain('var(--pii-cat-1)');
    });

    it('an unknown category id (manual mark / custom term) falls back to the "other" slot', () => {
        const style = categoryStyle('UserMarked', null);
        expect(style.color).toBe('var(--pii-cat-8)');
    });

    it('lower confidence bands produce a lighter background than high/null', () => {
        const high = categoryStyle('Person', 'high');
        const medium = categoryStyle('Person', 'medium');
        const low = categoryStyle('Person', 'low');
        const extractAlpha = (bg: string) => Number(bg.match(/(\d+)%/)?.[1]);
        expect(extractAlpha(low.background)).toBeLessThan(extractAlpha(medium.background));
        expect(extractAlpha(medium.background)).toBeLessThan(extractAlpha(high.background));
    });
});
