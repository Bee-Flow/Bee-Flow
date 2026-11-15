import { describe, expect, it } from 'vitest';
import { TONE_KEYS } from '@/components/shared/statusTone';
import { toneDotClass, toneInkClass } from './toneClasses';

describe('toneClasses', () => {
    it('has a dot and an ink class for every status tone', () => {
        for (const tone of TONE_KEYS) {
            expect(toneDotClass(tone)).toMatch(/^bg-\[var\(--/);
            expect(toneInkClass(tone)).toMatch(/^text-\[var\(--/);
        }
    });

    it('draws the raw colour as the dot and the ink as text', () => {
        expect(toneDotClass('error')).toBe('bg-[var(--error)]');
        expect(toneInkClass('error')).toBe('text-[var(--error-ink)]');
    });

    it('reads a missing or unknown tone as neutral, never an inherited key', () => {
        expect(toneDotClass(null)).toBe(toneDotClass('neutral'));
        expect(toneInkClass('mauve')).toBe(toneInkClass('neutral'));
        expect(toneInkClass('toString')).toBe(toneInkClass('neutral'));
    });
});
