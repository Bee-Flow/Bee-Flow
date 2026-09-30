/**
 * The font files, and when they are registered.
 *
 * Before the splash lifts: Inter (the web's stack falls back to it, and it is
 * an org's most common pick) and Fira Code (code, as on the web). The org's
 * other choices, IBM Plex Sans and Geist, load when branding names one: most
 * orgs never do, and the web's default is the platform face, which needs no
 * file at all. core/theme/fonts.ts maps a choice to these family names.
 *
 * Each weight is imported from its own module. The package index requires
 * every weight and italic it ships, and Metro bundles whatever is required:
 * importing `@expo-google-fonts/inter` put all eighteen Inter files in the APK.
 */

import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular';
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { Geist_700Bold } from '@expo-google-fonts/geist/700Bold';
import { IBMPlexSans_400Regular } from '@expo-google-fonts/ibm-plex-sans/400Regular';
import { IBMPlexSans_500Medium } from '@expo-google-fonts/ibm-plex-sans/500Medium';
import { IBMPlexSans_600SemiBold } from '@expo-google-fonts/ibm-plex-sans/600SemiBold';
import { IBMPlexSans_700Bold } from '@expo-google-fonts/ibm-plex-sans/700Bold';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { isLoaded, loadAsync, useFonts } from 'expo-font';

import type { FontChoice } from '@/core/theme/fonts';
import type { FontRuntime } from '@/core/theme/ThemeProvider';

/** Asset module ids by the family name expo-font registers them under. */
type FontFiles = Record<string, number>;

export const STARTUP_FONTS: FontFiles = {
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    FiraCode_400Regular,
};

export const ON_DEMAND_FONTS: Partial<Record<FontChoice, FontFiles>> = {
    plex: {
        IBMPlexSans_400Regular,
        IBMPlexSans_500Medium,
        IBMPlexSans_600SemiBold,
        IBMPlexSans_700Bold,
    },
    geist: {
        Geist_400Regular,
        Geist_500Medium,
        Geist_600SemiBold,
        Geist_700Bold,
    },
};

/**
 * Register the startup fonts; true once the app may paint. A font that failed
 * to load counts as done: its text falls back to the platform face, which is
 * better than a splash that never lifts.
 */
export function useAppFonts(): boolean {
    const [loaded, error] = useFonts(STARTUP_FONTS);
    return loaded || error !== null;
}

/** What ThemeProvider uses to ask for the org's font (RootProviders passes it). */
export const FONT_RUNTIME: FontRuntime = {
    isLoaded,
    load: async (choice) => {
        const files = ON_DEMAND_FONTS[choice];
        if (files) await loadAsync(files);
    },
};
