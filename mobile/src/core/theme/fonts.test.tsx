/**
 * The org's font choice, mapped to faces the way the web's stacks fall back:
 * the chosen family, then Inter, then the platform face.
 */

import { act, renderHook } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { FONT_FAMILIES, MONO_FAMILY, resolveFonts, typeScale } from './fonts';
import { buildTheme } from './resolve';
import { ThemeProvider, useTheme, type FontRuntime } from './ThemeProvider';

const only =
    (...families: string[]) =>
    (family: string) =>
        families.includes(family);

describe('resolveFonts', () => {
    it("paints the platform face for 'system', the web's default, and for no choice at all", () => {
        for (const choice of ['system', null, undefined, 'comic-sans']) {
            const fonts = resolveFonts(choice, only(FONT_FAMILIES.inter.regular));
            expect(fonts.regular).toEqual({ fontWeight: '400' });
            expect(fonts.semibold).toEqual({ fontWeight: '600' });
        }
    });

    it('names one family per weight, never a family AND a weight', () => {
        // A weight on a single-weight family makes Android draw Roboto instead.
        const fonts = resolveFonts('inter', only(FONT_FAMILIES.inter.regular));
        expect(fonts.bold).toEqual({ fontFamily: 'Inter_700Bold' });
        expect(fonts.medium).toEqual({ fontFamily: 'Inter_500Medium' });
    });

    it('falls back to Inter while IBM Plex Sans or Geist is not loaded, then to the platform face', () => {
        expect(resolveFonts('plex', only(FONT_FAMILIES.inter.regular)).regular).toEqual({
            fontFamily: 'Inter_400Regular',
        });
        expect(resolveFonts('plex', only(FONT_FAMILIES.plex.regular)).regular).toEqual({
            fontFamily: 'IBMPlexSans_400Regular',
        });
        expect(resolveFonts('geist', only()).regular).toEqual({ fontWeight: '400' });
    });

    it('draws code in Fira Code once it is loaded, and in the platform monospace until then', () => {
        expect(resolveFonts('system', only(MONO_FAMILY)).mono).toEqual({ fontFamily: MONO_FAMILY });
        expect(resolveFonts('system', only()).mono).toEqual({ fontFamily: 'monospace' });
    });

    it('builds the type scale on the chosen faces', () => {
        const type = typeScale(resolveFonts('inter', only(FONT_FAMILIES.inter.regular, MONO_FAMILY)));
        expect(type.title).toEqual({
            fontSize: 22,
            lineHeight: 28,
            letterSpacing: -0.3,
            fontFamily: 'Inter_600SemiBold',
        });
        expect(type.body.fontFamily).toBe('Inter_400Regular');
        expect(type.code.fontFamily).toBe(MONO_FAMILY);
    });
});

describe('the theme follows branding.font', () => {
    it('reads it off the branding', () => {
        const theme = buildTheme({
            preference: null,
            serverPreset: null,
            system: 'dark',
            branding: { font: 'inter' },
            hydrated: true,
            fontAvailable: only(FONT_FAMILIES.inter.regular),
        });
        expect(theme.fonts.semibold).toEqual({ fontFamily: 'Inter_600SemiBold' });
        expect(theme.type.heading.fontFamily).toBe('Inter_600SemiBold');
    });

    it('loads an on-demand family when the server names it, and rebuilds the theme once it arrives', async () => {
        const loaded = new Set<string>([FONT_FAMILIES.inter.regular]);
        let finish: () => void = () => undefined;
        const runtime: FontRuntime = {
            isLoaded: (family) => loaded.has(family),
            load: jest.fn(
                (choice) =>
                    new Promise<void>((resolve) => {
                        finish = () => {
                            loaded.add(FONT_FAMILIES[choice as 'plex'].regular);
                            resolve();
                        };
                    }),
            ),
        };
        const wrapper = ({ children }: { children: ReactNode }) => (
            <ThemeProvider fonts={runtime}>{children}</ThemeProvider>
        );
        const { result } = await renderHook(() => useTheme(), { wrapper });

        await act(async () => result.current.applyServerBranding({ font: 'plex' }));
        expect(runtime.load).toHaveBeenCalledWith('plex');
        // The web's plex stack falls back to Inter; so does the phone, meanwhile.
        expect(result.current.fonts.regular).toEqual({ fontFamily: 'Inter_400Regular' });

        await act(async () => finish());
        expect(result.current.fonts.regular).toEqual({ fontFamily: 'IBMPlexSans_400Regular' });
    });

    it('keeps the font it has when the server sends none', async () => {
        const wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider>{children}</ThemeProvider>;
        const { result } = await renderHook(() => useTheme(), { wrapper });
        await act(async () => result.current.applyServerBranding({ font: 'geist' }));
        await act(async () => result.current.applyServerBranding({ font: '' }));
        expect(result.current.branding.font).toBe('geist');
    });
});
