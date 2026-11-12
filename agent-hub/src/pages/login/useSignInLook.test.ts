import { describe, expect, it } from 'vitest';
import { signInPreset } from './useSignInLook';

describe('signInPreset', () => {
    it('draws light-surface presets in glass', () => {
        for (const preset of ['light', 'paper', 'sepia', 'glass', 'custom']) {
            expect(signInPreset(preset)).toBe('glass');
        }
    });

    it('draws dark-surface presets in dark glass', () => {
        for (const preset of ['dark', 'obsidian', 'glass-dark']) {
            expect(signInPreset(preset)).toBe('glass-dark');
        }
    });

    it('leaves high contrast alone', () => {
        expect(signInPreset('high-contrast')).toBe('high-contrast');
    });
});
