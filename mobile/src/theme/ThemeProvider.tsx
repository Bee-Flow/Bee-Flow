/**
 * Theme context.
 *
 * What paints, in precedence order:
 *   1. `system`, if the user explicitly asked for it — "match my phone" is a
 *      device-scoped choice with no server equivalent, so nothing overrides it.
 *   2. The ACCOUNT's theme, from /api/branding/effective. This is the same
 *      source the web reads (agent-hub ThemeContext), which is what makes one
 *      account look like one product on both.
 *   3. The locally stored choice, as the offline cache — what this device last
 *      resolved to, so a cold start with no network paints correctly.
 *   4. Android's light/dark switch, as the last resort.
 *
 * Order 2-before-3 is the whole point of this file's history. The account was
 * previously never consulted at boot: `getBranding()` had exactly one caller,
 * the Settings → Appearance screen, and even there its answer was only used to
 * draw that screen — never fed back into the theme. So the phone fell through
 * to Android's colour scheme while the web obeyed the account, and a user whose
 * account said light opened a black app. The web's default is `light`
 * (ThemeContext DEFAULTS.preset); the phone's fallback was the device. That one
 * gap produced the entire difference between the two screenshots.
 *
 * An explicit concrete choice made HERE still takes effect instantly: it is
 * pushed to the account by the Appearance screen and mirrored into
 * `serverPreset` optimistically, so the UI never waits for the round trip and
 * never flickers back to the stale server value.
 *
 * The accent override deliberately recomputes `accentPrimaryFg` rather than
 * trusting the server's value: index.css documents that a custom accent
 * shipped without a matching foreground rendered white-on-#9ca3af at 2.54:1.
 * Deriving contrast here means an admin cannot pick an accent that makes their
 * own buttons unreadable.
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

import {
    DARK_THEMES,
    ELEVATION,
    HIT_SLOP,
    MIN_TOUCH,
    MOTION,
    PALETTES,
    RADII,
    SPACING,
    TYPE,
    type Palette,
    type PaletteSource,
    type ThemeName,
} from './tokens';

/** What the user picked. `system` is the default and is not a palette itself. */
export type ThemePreference = ThemeName | 'system';

const STORAGE_KEY = 'beeflow.theme.preference';
const BRANDING_KEY = 'beeflow.theme.branding';
/**
 * The account's theme, cached so the next cold start paints it before the
 * network answers. Separate from STORAGE_KEY because they mean different
 * things: one is what this person chose, the other is what the account says.
 */
const SERVER_PRESET_KEY = 'beeflow.theme.serverPreset';

/**
 * The subset of /api/branding that decides how the app looks. Structural, not
 * imported from features/settings — the theme layer sits below the feature
 * layer and must not depend upward on it.
 */
export interface ServerBranding {
    preset?: string | null;
    accent?: string | null;
    radiusScale?: number | null;
}

export interface Branding {
    /** Hex accent from org branding, e.g. "#f59e0b". */
    accentColor?: string | null;
    /** Multiplier on every radius. 0 = square, 1 = default, 1.5 = very round. */
    radiusScale?: number | null;
    /** Org display name, shown in the app bar when set. */
    appName?: string | null;
    /** Absolute or server-relative logo URL. */
    logoUrl?: string | null;
}

export interface Theme {
    name: ThemeName;
    preference: ThemePreference;
    dark: boolean;
    colors: Palette;
    radii: Record<keyof typeof RADII, number>;
    spacing: typeof SPACING;
    type: typeof TYPE;
    elevation: typeof ELEVATION;
    motion: typeof MOTION;
    hitSlop: typeof HIT_SLOP;
    minTouch: typeof MIN_TOUCH;
    branding: Branding;
    /** False until the stored theme has been read. The splash waits on it. */
    hydrated: boolean;
}

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

/** Relative luminance per WCAG 2.1, for the accent-foreground derivation. */
function luminance(hex: string): number {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const channel = (i: number) => {
        const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function isHexColor(value: unknown): value is string {
    return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/** WCAG contrast ratio between two hex colours. 1 for anything not hex. */
function contrast(a: string, b: string): number {
    if (!isHexColor(a) || !isHexColor(b)) return 1;
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
}

/** HSL saturation, 0..1. Zero for anything not hex. */
function saturation(hex: string): number {
    if (!isHexColor(hex)) return 0;
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const [r, g, b] = [0, 1, 2].map((i) => parseInt(full.slice(i * 2, i * 2 + 2), 16)) as [
        number,
        number,
        number,
    ];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const l = (max + min) / 2 / 255;
    return (max - min) / 255 / (1 - Math.abs(2 * l - 1));
}

/**
 * Four colours the palettes cannot carry, because they depend on each OTHER.
 *
 * The palettes are a literal port of the web app's index.css and are pinned to
 * it by a test that parses that file, so a value in `tokens.ts` cannot be
 * changed here without changing the web product — and `accentPrimary` is also
 * org-brandable, so any fixed replacement would be wrong for half the
 * customers anyway. Deriving instead gets the fix for free on a custom accent,
 * because `applyBranding` has already run by the time this does.
 *
 *   `accentText`  — the first accent shade that is actually READABLE on a
 *                   card. The default accent is #9ca3af, which lands at 2.8:1
 *                   on the dark card; every "Try again", "Show more" and
 *                   inline link in the app was drawn in it.
 *   `cardBorder`  — a visible edge when a card and the surface behind it are
 *                   the same value. On obsidian both are #131316, so a Card
 *                   was an invisible rectangle. That is a faithful port of
 *                   index.css, not a mobile bug, so the token must not move.
 */
function deriveContrast(p: PaletteSource): Palette {
    const readable =
        [p.accentPrimary, p.accentPrimaryHover, p.accentSecondary].find(
            (c) => contrast(c, p.bgCard) >= 4.5,
        ) ?? p.textPrimary;
    /**
     * A filled primary button in a GREY reads as a disabled control, at any
     * contrast ratio. Bee Flow's accent is #9ca3af — a blue-grey at 11%
     * saturation — so on the shipped build every primary action in the app,
     * including "Start recording", looked switched off. The label passed
     * contrast at 6.99:1, which is exactly why the photometric pass did not
     * catch it: the failure is semantic.
     *
     * The discriminator is chroma, not luminance. A saturated fill reads as a
     * control whatever its brightness; an achromatic one does not, however
     * dark. So an accent with real colour in it (an org that branded itself
     * amber or blue) is used as-is, and an achromatic one falls back to ink —
     * maximum contrast, which is the one thing a disabled control never is.
     *
     * 0.25 sits an order of magnitude above every achromatic accent in the
     * table (0.09–0.11) and well below any real brand colour (0.83+).
     */
    const chromatic = saturation(p.accentPrimary) >= 0.25;
    return {
        ...p,
        accentText: readable,
        cardBorder: contrast(p.bgCard, p.bgSecondary) < 1.15 ? p.borderDefault : p.borderSubtle,
        accentFill: chromatic ? p.accentPrimary : p.textPrimary,
        accentFillFg: chromatic ? p.accentPrimaryFg : p.bgPrimary,
    };
}

/** Darken/lighten a hex colour by `amount` (-1..1), for the hover step. */
function shift(hex: string, amount: number): string {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const out = [0, 1, 2].map((i) => {
        const v = parseInt(full.slice(i * 2, i * 2 + 2), 16);
        const next = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
        return Math.max(0, Math.min(255, Math.round(next)))
            .toString(16)
            .padStart(2, '0');
    });
    return `#${out.join('')}`;
}

/**
 * Narrow whatever we were handed into a theme that actually has a palette.
 *
 * Three sources can put a name here and none of them is trusted: a preference
 * stored by an older build, an org-pinned branding preset from the server, and
 * a hand-edited AsyncStorage value. `PALETTES[name]` for an unknown name is
 * `undefined`, and every colour read after that throws — a hard crash at
 * startup with no way to recover from inside the app. This was already a
 * shipped bug, not one introduced by removing the glass themes; the removal is
 * just what made it certain to fire.
 *
 * The glass names map to their flat equivalents rather than the default,
 * because someone who chose `glass-dark` wanted a dark theme.
 */
function resolveThemeName(candidate: string, system: 'light' | 'dark'): ThemeName {
    if (candidate === 'glass') return 'light';
    if (candidate === 'glass-dark') return 'dark';
    return candidate in PALETTES ? (candidate as ThemeName) : system;
}

function applyBranding(palette: PaletteSource, branding: Branding, dark: boolean): PaletteSource {
    if (!isHexColor(branding.accentColor)) return palette;
    const accent = branding.accentColor.trim();
    // Contrast is derived, never taken on trust — see the header comment.
    const fg = luminance(accent) > 0.45 ? '#111827' : '#ffffff';
    return {
        ...palette,
        accentPrimary: accent,
        // On a dark theme "hover" reads as brighter; on a light one, as deeper.
        accentPrimaryHover: shift(accent, dark ? 0.18 : -0.18),
        accentSecondary: shift(accent, dark ? 0.3 : -0.08),
        accentPrimaryFg: fg,
        itemActiveBg: `rgba(${[0, 1, 2]
            .map((i) => {
                const h = accent.replace('#', '');
                const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
                return parseInt(full.slice(i * 2, i * 2 + 2), 16);
            })
            .join(', ')}, 0.12)`,
    };
}

/**
 * Which palette wins.
 *
 * Pulled out of the provider and exported because this precedence IS the fix,
 * and a precedence rule that lives inside a `useMemo` is a precedence rule
 * nobody can test. Each branch below corresponds to a real report:
 *
 *   - An explicit choice made ON THIS DEVICE wins, 'system' included. The
 *     Appearance screen already promises this in as many words — when an admin
 *     has pinned the org theme it tells the user "your choice stays on this
 *     phone and will not follow you to the web app" — and a precedence that
 *     silently overrode it on the next cold start would make that copy a lie.
 *   - The ACCOUNT next. This is the line that was missing, and it is the whole
 *     fix: it is what the web reads, so it is what makes one account look like
 *     one product on both clients.
 *   - The device LAST, which is where the phone used to start.
 *
 * So the account supplies the DEFAULT rather than the law. Someone who has
 * never opened Appearance — which is almost everyone, and was the person in the
 * bug report — now gets their account's theme instead of Android's.
 */
export function resolveActiveTheme({
    preference,
    serverPreset,
    device,
}: {
    /** null when nobody has ever chosen on this device. */
    preference: ThemePreference | null;
    /** null until the account's theme has been fetched or restored from cache. */
    serverPreset: ThemeName | null;
    /** Android's own switch. Only ever these two — it is a binary signal. */
    device: 'light' | 'dark';
}): ThemeName {
    if (preference === 'system') return device;
    if (preference) return resolveThemeName(preference, device);
    if (serverPreset) return serverPreset;
    return device;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const system = useColorScheme();
    // `null` means "nobody has chosen on this device". Distinct from 'system',
    // which is somebody explicitly choosing to follow Android — the difference
    // decides whether the account's theme is allowed to win below.
    const [preference, setPreferenceState] = useState<ThemePreference | null>(null);
    const [branding, setBrandingState] = useState<Branding>({});
    const [serverPreset, setServerPresetState] = useState<ThemeName | null>(null);
    // False until the read off disk has finished. The splash screen waits on
    // this — see the note on the hydrate effect below.
    const [hydrated, setHydrated] = useState(false);

    // Hydrate from disk, and hold the splash screen until it lands.
    //
    // The comment here used to claim the app "paints the dark theme" until this
    // resolves, so a mis-guess was invisible. It never did: both pieces of
    // state start null, so the first render resolves to the DEVICE theme. On a
    // light account held by a dark phone that meant a black app for the length
    // of an AsyncStorage read, then a flip to light — the exact impression of
    // the original bug, on a build where the precedence was already fixed.
    //
    // `hydrated` is what AuthGate holds the splash on. It waits for the DISK
    // read only, never the network: the cached account theme is read here, so
    // after the first launch the right theme paints immediately, and a slow or
    // absent server delays nothing.
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
                // Validated on the way in as well as on the way out: an
                // unusable stored value should not survive to be written back.
                if (pref === 'system' || (pref && pref in PALETTES)) {
                    setPreferenceState(pref as ThemePreference);
                } else if (pref === 'glass' || pref === 'glass-dark') {
                    // Written back inline rather than through `setPreference`,
                    // which is declared below this effect — and rewriting it
                    // here is the point: an unusable stored value should not
                    // survive to be read again on the next launch.
                    const flat = resolveThemeName(pref, 'dark');
                    setPreferenceState(flat);
                    void AsyncStorage.setItem(STORAGE_KEY, flat);
                }
                if (brand) setBrandingState(JSON.parse(brand) as Branding);
                // Last known account theme. Painting it now is what stops the
                // app flashing the device's theme for the length of a network
                // round trip on every cold start.
                if (cachedServer && cachedServer in PALETTES) {
                    setServerPresetState(cachedServer as ThemeName);
                }
            } catch {
                // A corrupt preference is not worth failing to start over.
            } finally {
                // In `finally`, so a throw above still releases the splash.
                // A theme that failed to load is a cosmetic problem; an app
                // that never gets past its splash screen is not.
                if (alive) setHydrated(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, []);

    const setPreference = useCallback((p: ThemePreference) => {
        setPreferenceState(p);
        void AsyncStorage.setItem(STORAGE_KEY, p);
    }, []);

    /**
     * What the account says. Supplies the theme for anyone who has not chosen
     * on this device, and is cached so the next cold start paints it without
     * waiting for the network. Never overrides an explicit local choice.
     */
    const applyServerBranding = useCallback((b: ServerBranding) => {
        const preset = typeof b.preset === 'string' ? b.preset : null;
        if (preset) {
            // 'custom' is a real server value with no palette on this client,
            // and glass/glass-dark collapse to a flat pair — resolveThemeName
            // handles both. An unknown preset is ignored rather than guessed.
            const resolved = preset in PALETTES ? (preset as ThemeName) : null;
            const flat = resolved ?? (preset === 'glass' ? 'light' : preset === 'glass-dark' ? 'dark' : null);
            if (flat) {
                setServerPresetState(flat);
                void AsyncStorage.setItem(SERVER_PRESET_KEY, flat);
            }
        }
        // The accent and roundness ride along on the same payload. These used
        // to update only while the Appearance screen was open, so an admin's
        // brand colour reached the phone exactly once and only if the user went
        // looking for it.
        setBrandingState((prev) => {
            const next: Branding = {
                ...prev,
                accentColor: typeof b.accent === 'string' ? b.accent : prev.accentColor,
                radiusScale: typeof b.radiusScale === 'number' ? b.radiusScale : prev.radiusScale,
            };
            void AsyncStorage.setItem(BRANDING_KEY, JSON.stringify(next)).catch(() => undefined);
            return next;
        });
    }, []);

    const setBranding = useCallback((b: Branding) => {
        setBrandingState(b);
        void AsyncStorage.setItem(BRANDING_KEY, JSON.stringify(b));
    }, []);

    const value = useMemo<ThemeContextValue>(() => {
        const device: ThemeName = system === 'light' ? 'light' : 'dark';
        const name = resolveActiveTheme({ preference, serverPreset, device });
        const dark = DARK_THEMES.has(name);
        const scale = typeof branding.radiusScale === 'number' && branding.radiusScale >= 0
            ? Math.min(2, branding.radiusScale)
            : 1;

        return {
            name,
            // Nothing chosen reads as 'system' to consumers: the Appearance
            // screen's "Match my phone" row should show as selected when the
            // user has never chosen, because that is what is happening.
            preference: preference ?? 'system',
            dark,
            // Branding first, then derivation — so a custom org accent gets a
            // readable text shade computed from ITS value, not the default's.
            colors: deriveContrast(applyBranding(PALETTES[name], branding, dark)),
            radii: {
                sm: Math.round(RADII.sm * scale),
                md: Math.round(RADII.md * scale),
                lg: Math.round(RADII.lg * scale),
                xl: Math.round(RADII.xl * scale),
                // The pill radius is not a roundness choice, it is a shape.
                pill: RADII.pill,
            },
            spacing: SPACING,
            type: TYPE,
            elevation: ELEVATION,
            motion: MOTION,
            hitSlop: HIT_SLOP,
            minTouch: MIN_TOUCH,
            branding,
            hydrated,
            setPreference,
            setBranding,
            applyServerBranding,
        };
    }, [preference, serverPreset, system, branding, hydrated, setPreference, setBranding, applyServerBranding]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
    return ctx;
}

/**
 * Build a StyleSheet from the current theme.
 *
 * `StyleSheet.create` is not used here on purpose: it caches by object
 * identity, and a themed sheet must be rebuilt when the theme changes. The
 * memo below is the cache, keyed on the theme the caller actually rendered
 * with.
 */
export function useThemedStyles<T extends Record<string, object>>(
    factory: (theme: Theme) => T,
): T {
    const theme = useTheme();
    // `factory` is expected to be a module-level constant. Including it in the
    // dependency array would rebuild the sheet on every render for any caller
    // that defines the factory inline, which is the exact cost this hook exists
    // to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => factory(theme), [theme]);
}
