/**
 * Which theme paints, as pure functions the provider composes.
 *
 * Precedence, and the reason for it: an explicit choice made ON THIS DEVICE
 * wins ('system' included — the Appearance screen promises "your choice stays
 * on this phone"); then the ACCOUNT's theme, which is what the web reads and
 * what makes one account look like one product on both; then Android's own
 * light/dark switch, where the phone used to start. So the account supplies
 * the default rather than the law.
 */

import {
    accentShades,
    applyBranding,
    brandedShadows,
    deriveContrast,
    elevationFrom,
    scaledRadii,
} from './derive';
import { resolveFonts, typeScale } from './fonts';
import { WEB_TOKENS } from './generated/webTokens.generated';
import {
    DARK_THEMES,
    HIT_SLOP,
    MIN_TOUCH,
    MOTION,
    PALETTES,
    SPACING,
    type DayNight,
    type ThemeName,
} from './tokens';
import type { Branding, Theme, ThemePreference } from './types';

/**
 * Names with no palette of their own, mapped to the one they paint. `custom`
 * has no block in index.css, so the web paints `:root` — the dark palette —
 * with the org's accent on top.
 */
const ALIASES: Readonly<Record<string, DayNight>> = { custom: 'dark' };

const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

/**
 * The theme the phone paints for a web theme name, or null for a name that is
 * no theme at all. The phone paints Day and Night only (tokens.ts
 * PICKABLE_THEMES), so every other web theme lands on its family: a dark-ink
 * theme (glass-dark, obsidian, high contrast) on Night, the rest (glass,
 * paper, sepia) on Day.
 */
export function familyOf(name: string): DayNight | null {
    if (own(ALIASES, name)) return ALIASES[name] ?? null;
    if (!own(PALETTES, name)) return null;
    return DARK_THEMES.has(name as ThemeName) ? 'dark' : 'light';
}

/**
 * Narrow an untrusted name — an older build's stored preference, a server
 * preset, a hand-edited value — to Day or Night. `PALETTES[name]` for an
 * unknown name is undefined and every colour read after it throws, a startup
 * crash; an unknown name therefore follows the device.
 */
export function resolveThemeName(candidate: string, system: DayNight): DayNight {
    return familyOf(candidate) ?? system;
}

export function resolveActiveTheme({
    preference,
    serverPreset,
    device,
}: {
    /** null when nobody has ever chosen on this device. */
    preference: ThemePreference | null;
    /** null until the account's theme has been fetched or restored from cache. */
    serverPreset: DayNight | null;
    /** Android's own switch. Only ever these two — it is a binary signal. */
    device: DayNight;
}): DayNight {
    if (preference === 'system') return device;
    if (preference) return resolveThemeName(preference, device);
    if (serverPreset) return resolveThemeName(serverPreset, device);
    return device;
}

/**
 * The theme a server preset paints on the phone, or null to ignore it. Any
 * web theme lands on its family and 'custom' is the dark palette, as on the
 * web; an unknown preset is ignored rather than guessed.
 */
export function serverPresetTheme(preset: string): DayNight | null {
    return familyOf(preset);
}

/**
 * A stored preference, validated on the way in: the preference to use (null
 * when there is none) and whether the stored value must be rewritten because
 * it named a theme the picker no longer offers. A removed theme becomes its
 * family (obsidian → Night, paper → Day); an unknown value is dropped, which
 * leaves the account's theme and then Android's switch to decide.
 */
export function storedPreference(raw: string | null): { preference: ThemePreference | null; rewrite: boolean } {
    if (raw === 'system' || raw === 'light' || raw === 'dark') {
        return { preference: raw, rewrite: false };
    }
    const family = raw ? familyOf(raw) : null;
    return family ? { preference: family, rewrite: true } : { preference: null, rewrite: false };
}

/** Everything a consumer reads off useTheme(), except the setters. */
export function buildTheme({
    preference,
    serverPreset,
    system,
    branding,
    hydrated,
    fontAvailable = () => false,
}: {
    preference: ThemePreference | null;
    serverPreset: DayNight | null;
    /** React Native's useColorScheme(); anything but 'light' counts as dark. */
    system: string | null | undefined;
    branding: Branding;
    hydrated: boolean;
    /** Whether a font family is registered yet (expo-font's isLoaded). */
    fontAvailable?: (family: string) => boolean;
}): Theme {
    const device: DayNight = system === 'light' ? 'light' : 'dark';
    const name = resolveActiveTheme({ preference, serverPreset, device });
    const dark = DARK_THEMES.has(name);
    const web = WEB_TOKENS[name];
    const shadows = brandedShadows(name, branding);
    const fonts = resolveFonts(branding.font, fontAvailable);
    return {
        name,
        // Nothing chosen reads as 'system': the Appearance screen's "Match my
        // phone" row shows as selected, because that is what is happening.
        preference: preference ?? 'system',
        dark,
        // Branding first, then derivation — so a custom org accent gets a
        // readable text shade computed from ITS value, not the default's.
        colors: deriveContrast(
            applyBranding(PALETTES[name], branding),
            accentShades(PALETTES[name], branding, dark),
        ),
        stepType: web.stepType,
        kind: web.kind,
        chart: web.chart,
        pii: web.pii,
        learn: web.learn,
        shadows,
        elevation: elevationFrom(shadows),
        radii: scaledRadii(branding.radiusScale),
        spacing: SPACING,
        type: typeScale(fonts),
        fonts,
        motion: MOTION,
        hitSlop: HIT_SLOP,
        minTouch: MIN_TOUCH,
        branding,
        hydrated,
    };
}
