import { readEffectiveBranding, readPublicBranding, readUserBrandingResponse } from './readers';

describe('the branding readers', () => {
    it('reads the effective theme', () => {
        expect(
            readEffectiveBranding({
                preset: 'light',
                accent: '#f59e0b',
                radiusScale: 1.2,
                font: 'Inter',
                wallpaperUrl: null,
                allowUserOverride: false,
                source: 'admin',
                glassTint: 'warm',
            }),
        ).toEqual({
            preset: 'light',
            accent: '#f59e0b',
            radiusScale: 1.2,
            font: 'Inter',
            wallpaperUrl: null,
            allowUserOverride: false,
            source: 'admin',
        });
    });

    it('reads a missing theme knob as null, which the theme reads as "keep what you have"', () => {
        const branding = readEffectiveBranding({});
        expect(branding).toMatchObject({ preset: null, accent: null, radiusScale: null });
        expect(branding?.allowUserOverride).toBe(true);
        expect(branding?.source).toBe('default');
    });

    it('reads the public subset without the per-user fields', () => {
        const branding = readPublicBranding({ preset: 'dark', allowUserOverride: false });
        expect(branding).not.toHaveProperty('allowUserOverride');
        expect(branding?.preset).toBe('dark');
        expect(readPublicBranding(null)).toBeNull();
    });

    it('reads the save answer', () => {
        const saved = readUserBrandingResponse({ override: { preset: 'paper' }, effective: { preset: 'paper' } });
        expect(saved?.override).toEqual({ preset: 'paper', accent: undefined, wallpaperPreset: undefined });
        expect(saved?.effective.preset).toBe('paper');
        expect(readUserBrandingResponse({ override: null, effective: {} })?.override).toBeNull();
    });
});
