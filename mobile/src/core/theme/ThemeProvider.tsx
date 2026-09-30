/**
 * Theme context: holds what the user chose, what the account says and the
 * org's branding, and hands every screen the resolved Theme.
 *
 * The decisions live in pure modules this file only composes: resolve.ts says
 * which palette wins (device choice, then the account's theme, then Android's
 * switch), derive.ts computes the colours the palettes cannot carry, fonts.ts
 * maps the org's font to faces, and color.ts does the arithmetic. What stays
 * here is state and persistence.
 *
 * An explicit choice made on this device takes effect instantly: the
 * Appearance screen pushes it to the account and it is mirrored into
 * `serverPreset` optimistically, so the UI never waits for the round trip.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';

import { isFontChoice } from './fonts';
import { buildTheme, serverPresetTheme, storedPreference } from './resolve';
import type { DayNight } from './tokens';
import type { Branding, ServerBranding, Theme, ThemePreference } from './types';
import { useFontAvailability, type FontRuntime } from './useFontAvailability';

export type { Branding, ServerBranding, Theme, ThemePreference } from './types';
export type { FontRuntime } from './useFontAvailability';

const STORAGE_KEY = 'beeflow.theme.preference';
const BRANDING_KEY = 'beeflow.theme.branding';
/**
 * The account's theme, cached so the next cold start paints it before the
 * network answers. Separate from STORAGE_KEY: one is what this person chose,
 * the other is what the account says.
 */
const SERVER_PRESET_KEY = 'beeflow.theme.serverPreset';

interface ThemeContextValue extends Theme {
    setPreference: (p: ThemePreference) => void;
    setBranding: (b: Branding) => void;
    /**
     * Feed in what the server says this account looks like. Called by
     * <BrandingSync>, which owns the fetch — this module stays free of any
     * dependency on the API layer.
     */
    applyServerBranding: (b: ServerBranding) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface StoredTheme {
    setPreference: (p: ThemePreference | null) => void;
    setBranding: (b: Branding) => void;
    setServerPreset: (name: DayNight) => void;
    setHydrated: (done: boolean) => void;
}

/**
 * Read the stored theme off disk, and release the splash when done.
 *
 * `hydrated` is what AuthGate holds the splash on, and it waits for the DISK
 * read only, never the network: without it the first frames paint from the
 * DEVICE scheme, so a light account on a dark phone flashed black on every
 * cold start. The cached account theme is read here too, so after the first
 * launch the right theme paints immediately.
 */
function useHydrate(store: StoredTheme): void {
    const { setPreference, setBranding, setServerPreset, setHydrated } = store;
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const [pref, brand, cachedServer] = await Promise.all([
                    AsyncStorage.getItem(STORAGE_KEY),
                    AsyncStorage.getItem(BRANDING_KEY),
                    AsyncStorage.getItem(SERVER_PRESET_KEY),
                ]);
                if (!alive) return;
                // Validated on the way in: a theme the picker no longer offers
                // (paper, obsidian, glass…) is rewritten to Day or Night.
                const stored = storedPreference(pref);
                if (stored.preference) setPreference(stored.preference);
                if (stored.rewrite && stored.preference) {
                    void AsyncStorage.setItem(STORAGE_KEY, stored.preference);
                }
                if (brand) setBranding(JSON.parse(brand) as Branding);
                const cached = cachedServer ? serverPresetTheme(cachedServer) : null;
                if (cached) setServerPreset(cached);
            } catch {
                // A corrupt preference is not worth failing to start over.
            } finally {
                // In `finally`, so a throw above still releases the splash: a
                // theme that failed to load is cosmetic, a stuck splash is not.
                if (alive) setHydrated(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [setPreference, setBranding, setServerPreset, setHydrated]);
}

/**
 * `fonts` is how the theme learns which font families exist (core/providers
 * supplies it with the font files). Without it every face is the platform's,
 * which is what tests render with.
 */
export function ThemeProvider({ children, fonts }: { children: ReactNode; fonts?: FontRuntime }) {
    const system = useColorScheme();
    // `null` means "nobody has chosen on this device". Distinct from 'system',
    // which is somebody explicitly choosing to follow Android — the difference
    // decides whether the account's theme is allowed to win.
    const [preference, setPreferenceState] = useState<ThemePreference | null>(null);
    const [branding, setBrandingState] = useState<Branding>({});
    const [serverPreset, setServerPresetState] = useState<DayNight | null>(null);
    const [hydrated, setHydrated] = useState(false);

    useHydrate({
        setPreference: setPreferenceState,
        setBranding: setBrandingState,
        setServerPreset: setServerPresetState,
        setHydrated,
    });
    const fontAvailable = useFontAvailability(branding.font, fonts);

    const setPreference = useCallback((p: ThemePreference) => {
        setPreferenceState(p);
        void AsyncStorage.setItem(STORAGE_KEY, p);
    }, []);

    /**
     * What the account says: the theme for anyone who has not chosen on this
     * device (cached for the next cold start), plus the accent, roundness and
     * font, which ride along on the same payload. Never overrides a local choice.
     */
    const applyServerBranding = useCallback((b: ServerBranding) => {
        const flat = typeof b.preset === 'string' ? serverPresetTheme(b.preset) : null;
        if (flat) {
            setServerPresetState(flat);
            void AsyncStorage.setItem(SERVER_PRESET_KEY, flat);
        }
        setBrandingState((prev) => {
            const next: Branding = {
                ...prev,
                accentColor: typeof b.accent === 'string' ? b.accent : prev.accentColor,
                radiusScale: typeof b.radiusScale === 'number' ? b.radiusScale : prev.radiusScale,
                font: isFontChoice(b.font) ? b.font : prev.font,
            };
            void AsyncStorage.setItem(BRANDING_KEY, JSON.stringify(next)).catch(() => undefined);
            return next;
        });
    }, []);

    const setBranding = useCallback((b: Branding) => {
        setBrandingState(b);
        void AsyncStorage.setItem(BRANDING_KEY, JSON.stringify(b));
    }, []);

    const value = useMemo<ThemeContextValue>(
        () => ({
            ...buildTheme({ preference, serverPreset, system, branding, hydrated, fontAvailable }),
            setPreference,
            setBranding,
            applyServerBranding,
        }),
        [
            preference,
            serverPreset,
            system,
            branding,
            hydrated,
            fontAvailable,
            setPreference,
            setBranding,
            applyServerBranding,
        ],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
    return ctx;
}

/**
 * The documented way to write themed styles: a module-level factory from the
 * Theme to a style object, rebuilt only when the theme changes.
 *
 *     const makeStyles = (theme: Theme) => ({
 *         row: { padding: theme.spacing.lg, backgroundColor: theme.colors.bgCard },
 *     });
 *     const styles = useThemedStyles(makeStyles);
 *
 * Not `StyleSheet.create`: that caches by object identity, and a themed sheet
 * must be rebuilt when the theme changes. The memo below is the cache.
 */
export function useThemedStyles<T extends Record<string, object>>(factory: (theme: Theme) => T): T {
    const theme = useTheme();
    // `factory` is expected to be a module-level constant. Including it in the
    // dependency array would rebuild the sheet on every render for any caller
    // that defines the factory inline, which is the exact cost this hook exists
    // to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => factory(theme), [theme]);
}

/**
 * A style factory built at most once per theme, however many components ask
 * for it. useThemedStyles memoizes per component INSTANCE, which is right for
 * a screen and wrong for a sheet that every row of a virtualised list or every
 * node of a pannable canvas uses: those mount and unmount as the window moves,
 * and each mount would rebuild the whole sheet. Wrap such a factory in this at
 * module level and hand the result to useThemedStyles as usual.
 */
export function perTheme<T>(factory: (theme: Theme) => T): (theme: Theme) => T {
    const cache = new WeakMap<Theme, T>();
    return (theme) => {
        const hit = cache.get(theme);
        if (hit) return hit;
        const built = factory(theme);
        cache.set(theme, built);
        return built;
    };
}
