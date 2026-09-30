/**
 * Which font families the theme may name, and loading the org's on demand.
 *
 * The font FILES live in core/providers (fonts.ts), which hands them to
 * ThemeProvider as a FontRuntime: Inter and Fira Code are registered before
 * the splash lifts, IBM Plex Sans and Geist only when an org picks one. Until
 * a family is registered the theme names the web's next fallback (Inter, then
 * the platform face), so text never points at a family Android cannot find.
 */

import { useCallback, useEffect, useState } from 'react';

import { FONT_FAMILIES, isFontChoice, type FontChoice } from './fonts';

export interface FontRuntime {
    /** Whether a family name is registered (expo-font's isLoaded). */
    isLoaded: (family: string) => boolean;
    /** Register a choice's faces; resolves once they can be drawn. */
    load: (choice: FontChoice) => Promise<void>;
}

/**
 * A predicate for buildTheme's `fontAvailable`, which changes identity when a
 * family arrives, so the theme is rebuilt with it.
 */
export function useFontAvailability(
    choice: FontChoice | null | undefined,
    runtime: FontRuntime | undefined,
): (family: string) => boolean {
    const [arrived, setArrived] = useState<readonly string[]>([]);

    useEffect(() => {
        if (!runtime || !isFontChoice(choice) || choice === 'system') return undefined;
        const family = FONT_FAMILIES[choice].regular;
        if (runtime.isLoaded(family)) return undefined;
        let alive = true;
        runtime.load(choice).then(
            () => {
                if (alive) setArrived((prev) => (prev.includes(family) ? prev : [...prev, family]));
            },
            // A family that fails to load stays on the fallback; nothing to retry.
            () => undefined,
        );
        return () => {
            alive = false;
        };
    }, [choice, runtime]);

    return useCallback(
        (family: string) => arrived.includes(family) || (runtime?.isLoaded(family) ?? false),
        [arrived, runtime],
    );
}
