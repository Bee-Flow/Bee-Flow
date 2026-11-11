import { describe, expect, it } from 'vitest';
import { appDesignProps } from './appDesign';
import { tokenColorVar, tokenVars } from './designTokens';
import { darkPaletteVars, scopeThemeVars, screenThemeScope, sectionThemeScope } from './themeScope';
import { resolveBoxBorderColor, resolveBoxFill } from './styleResolver/box';
import { resolveColor } from './styleResolver/text';

describe('theme scope', () => {
    it('emits only the variables of the keys an override names', () => {
        expect(scopeThemeVars({ density: 'compact' }, { primary: '#0F766E' })).toEqual({ '--app-space': '0.75' });
        expect(scopeThemeVars(null, {})).toEqual({});
        expect(scopeThemeVars({ bogus: 1 }, {})).toEqual({});
    });

    it('moves the accent with a new primary only when nothing has an accent of its own', () => {
        const follow = scopeThemeVars({ primary: '#B45309' }, { primary: '#0F766E' }) as Record<string, string>;
        expect(follow['--app-accent']).toBe('#B45309');
        const own = scopeThemeVars({ primary: '#B45309' }, { primary: '#0F766E', accent: '#1D4ED8' }) as Record<string, string>;
        expect(own['--app-accent']).toBeUndefined();
    });

    it('gives a screen without an override the app theme and nothing else', () => {
        const theme = { primary: '#0F766E', appearance: 'light' };
        expect(screenThemeScope(theme, { id: 's' })).toEqual({ theme, override: null, style: {}, className: '', appearance: 'light' });
        const dark = screenThemeScope(theme, { theme: { appearance: 'dark', canvas: '#0F172A' } });
        expect(dark.appearance).toBe('dark');
        expect(dark.className).toBe(' app-screen--canvas');
        expect(sectionThemeScope({ appearance: 'dark' }, theme)).toMatchObject({ appearance: 'dark', className: ' app-section--themed-ground' });
        expect(sectionThemeScope(undefined, theme)).toEqual({ style: {}, className: '', appearance: undefined });
    });

    it('derives the dark palette and lets a screen colour win over it', () => {
        expect(darkPaletteVars(undefined, {})).toEqual({ className: '', style: {} });
        expect(darkPaletteVars({ primary: '#5eead4' }, { appearance: 'light' }).className).toBe('');
        const auto = darkPaletteVars({ primary: '#5eead4', canvas: '#0b1220' }, { primary: '#0F766E' });
        expect(auto.className).toBe('app-dark-palette--auto app-dark-palette--canvas');
        expect((auto.style as Record<string, string>)['--app-dark-primary']).toBe('#5eead4');
        const screen = darkPaletteVars({ primary: '#5eead4' }, { appearance: 'dark' }, { primary: '#38BDF8' });
        expect(screen.className).toBe('app-dark-palette--on');
        expect((screen.style as Record<string, string>)['--app-dark-primary']).toBe('#38BDF8');
    });

    it('adds tokens, the pixel radius and the dark palette to the root only when set', () => {
        expect(appDesignProps({ design: { font: 'system' } })).toEqual({ className: '', style: {} });
        const props = appDesignProps({ theme: {}, design: { tokens: { brand: '#e0f2fe', gutter: 24, Bad: '#fff' }, radiusPx: 6 } as never });
        expect(props.style).toEqual({ '--app-token-brand': '#e0f2fe', '--app-token-gutter': '24px', '--app-radius': '6px' });
    });

    it('resolves token:<name> to the token variable in every colour knob', () => {
        expect(tokenColorVar('token:brand')).toBe('var(--app-token-brand)');
        expect(tokenColorVar('token:Bad')).toBeNull();
        expect(resolveColor('token:brand')).toBe('var(--app-token-brand)');
        expect(resolveBoxFill('token:brand')).toBe('var(--app-token-brand)');
        expect(resolveBoxBorderColor('token:brand')).toBe('var(--app-token-brand)');
        expect(tokenVars(null)).toEqual({});
    });
});
