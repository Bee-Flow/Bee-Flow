import { describe, expect, it } from 'vitest';
import { applyThemeToDocument, THEME_DEFAULT_ACCENT } from './applyTheme';

describe('applyThemeToDocument accent', () => {
    it('leaves the theme its own accent when the stored accent is the default grey', () => {
        const root = document.createElement('html');
        root.style.setProperty('--accent-primary', '#ef4444');
        applyThemeToDocument({ preset: 'light', accent: THEME_DEFAULT_ACCENT.toUpperCase() }, root);
        expect(root.getAttribute('data-theme')).toBe('light');
        expect(root.style.getPropertyValue('--accent-primary')).toBe('');
        expect(root.style.getPropertyValue('--accent-primary-fg')).toBe('');
    });

    it('writes a chosen accent and its readable foreground inline', () => {
        const root = document.createElement('html');
        applyThemeToDocument({ preset: 'light', accent: '#3b82f6' }, root);
        expect(root.style.getPropertyValue('--accent-primary')).toBe('#3b82f6');
        expect(root.style.getPropertyValue('--accent-primary-fg')).toBe('#000000');
    });
});
