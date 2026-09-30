/**
 * The organisation theme as the web's Theme Studio edits it
 * (appearance/studio/look/*, ThemeContext.jsx THEME_PRESETS and FONT_OPTIONS),
 * over `GET|PUT /api/branding/admin` (routes/branding.js).
 *
 * PUT merges: brandingStore.setOrgDefault spreads the stored default under
 * the body, so a save sends only the knobs the admin changed here and the
 * glass and wallpaper knobs this screen does not show keep their values.
 * theme.lockstep.test.ts holds the ids to the web and the server.
 */

/** ThemeContext.jsx THEME_PRESETS, in the web's order. */
export const THEME_PRESET_IDS = [
    'light',
    'paper',
    'sepia',
    'glass',
    'glass-dark',
    'dark',
    'obsidian',
    'high-contrast',
    'custom',
] as const;
export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

/** ThemeContext.jsx FONT_OPTIONS. */
export const FONT_IDS = ['system', 'inter', 'plex', 'geist'] as const;
export type FontId = (typeof FONT_IDS)[number];

/** AccentSection.jsx ACCENT_PRESETS (no purple, brand-wide). */
export const ACCENT_PRESETS = ['#9ca3af', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'] as const;

/** RadiusSection.jsx's slider, and the server's refusal range. */
export const RADIUS_RANGE = { min: 0.5, max: 1.5, step: 0.05 } as const;

/** The knobs this screen edits. Defaults are brandingStore.js DEFAULTS. */
export interface OrgTheme {
    preset: ThemePresetId;
    accent: string;
    radiusScale: number;
    font: FontId;
    allowUserOverride: boolean;
}

export const THEME_DEFAULTS: OrgTheme = {
    preset: 'light',
    accent: '#9ca3af',
    radiusScale: 1,
    font: 'system',
    allowUserOverride: true,
};

/** The server's accent rule: `#` and six hex digits. */
export const ACCENT_RX = /^#[0-9a-fA-F]{6}$/;

export function isValidAccent(value: string): boolean {
    return ACCENT_RX.test(value);
}

/** What the admin typed, as the server stores it: trimmed, with a `#`, lower case. */
export function normalizeAccent(raw: string): string {
    const trimmed = raw.trim();
    return (trimmed.startsWith('#') ? trimmed : `#${trimmed}`).toLowerCase();
}

/** RadiusSection.jsx's `${v.toFixed(2)}×`. */
export function formatRadius(value: number): string {
    return `${value.toFixed(2)}×`;
}
