/**
 * The font files and the family names the theme asks for are one list, kept
 * in two places (the theme may not import the files, which live here). A name
 * with no file is text Android draws in its fallback face without a word.
 */

import { loadAsync } from 'expo-font';

import { FONT_FAMILIES, MONO_FAMILY } from '@/core/theme/fonts';

import { FONT_RUNTIME, ON_DEMAND_FONTS, STARTUP_FONTS } from './fonts';

jest.mock('expo-font', () => ({
    __esModule: true,
    isLoaded: jest.fn(() => false),
    loadAsync: jest.fn(async () => undefined),
    useFonts: jest.fn(() => [true, null]),
}));

describe('font files', () => {
    it('registers Inter and Fira Code before the splash lifts', () => {
        expect(Object.keys(STARTUP_FONTS).sort()).toEqual(
            [...Object.values(FONT_FAMILIES.inter), MONO_FAMILY].sort(),
        );
    });

    it('has a file for every face of every on-demand family, under the name the theme uses', () => {
        for (const [choice, faces] of Object.entries(FONT_FAMILIES)) {
            if (choice === 'inter') continue;
            const files = ON_DEMAND_FONTS[choice as keyof typeof ON_DEMAND_FONTS] ?? {};
            expect(Object.keys(files).sort()).toEqual(Object.values(faces).sort());
        }
    });

    it('loads an on-demand family when asked, and nothing for one that is already there', async () => {
        await FONT_RUNTIME.load('geist');
        expect(loadAsync).toHaveBeenCalledWith(ON_DEMAND_FONTS.geist);
        (loadAsync as jest.Mock).mockClear();
        await FONT_RUNTIME.load('system');
        await FONT_RUNTIME.load('inter');
        expect(loadAsync).not.toHaveBeenCalled();
    });
});
