// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { imageStatusHint } from './imageStatus';

const t = (_key: string, en: string, params?: Record<string, unknown>) => en.replace('{count}', String(params?.count ?? ''));

describe('imageStatusHint', () => {
    it('says nothing without pictures, or when the model saw every one', () => {
        expect(imageStatusHint(null, t)).toBeNull();
        expect(imageStatusHint({ attached: 0, shown: 0, skipped: 0, blind: false }, t)).toBeNull();
        expect(imageStatusHint({ attached: 2, shown: 2, skipped: 0, blind: false }, t)).toBeNull();
    });

    it('says in one line that a model cannot see images', () => {
        expect(imageStatusHint({ attached: 1, shown: 0, skipped: 0, blind: true }, t)).toBe('This model cannot see images, so the assistant did not see what you attached. Describe it in words, or pick a model that can see images.');
    });

    it('names pictures over a cap, one or more', () => {
        expect(imageStatusHint({ attached: 5, shown: 4, skipped: 1, blind: false }, t)).toMatch(/^One image was too large, or one too many/);
        expect(imageStatusHint({ attached: 3, shown: 0, skipped: 3, blind: false }, t)).toBe('3 images were too large, or too many, so the assistant did not see them.');
    });
});
