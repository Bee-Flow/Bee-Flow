/**
 * The theme's public types. Kept apart from the provider so the pure modules
 * (derive, resolve) and the provider can share them without importing React.
 */

import type { FontChoice, FontSet, TypeScale } from './fonts';
import type {
    WebChart,
    WebKind,
    WebLearn,
    WebPii,
    WebShadows,
    WebStepType,
} from './generated/webTokens.generated';
import type { DayNight, HIT_SLOP, MIN_TOUCH, MOTION, Palette, RADII, SPACING } from './tokens';

/**
 * What the user picked: Day, Night, or `system` (Android's switch decides).
 * `system` is the default and is not a palette itself.
 */
export type ThemePreference = DayNight | 'system';

/**
 * The subset of /api/branding that decides how the app looks. Structural, not
 * imported from a feature — the theme layer sits below the feature layer and
 * must not depend upward on it.
 */
export interface ServerBranding {
    preset?: string | null;
    accent?: string | null;
    radiusScale?: number | null;
    /** One of the web's FONT_STACKS keys: system, inter, plex, geist. */
    font?: string | null;
}

export interface Branding {
    /** Hex accent from org branding, e.g. "#f59e0b". */
    accentColor?: string | null;
    /** Multiplier on every radius, 0.5 (square-ish) to 1.5 (very round), as the server allows. */
    radiusScale?: number | null;
    /** The org's font. Unset is the web's default, the platform face. */
    font?: FontChoice | null;
    /** Org display name, shown in the app bar when set. */
    appName?: string | null;
    /** Absolute or server-relative logo URL. */
    logoUrl?: string | null;
}

/** A shadow as a style to spread into a view's: `{ ...theme.elevation.card }`. */
export interface ShadowStyle {
    boxShadow: string;
}

/**
 * `theme.shadows` as ready-made styles, by the names the screens use: `raised`
 * is the web's `--shadow-md`.
 */
export interface Elevation {
    card: ShadowStyle;
    cardHover: ShadowStyle;
    raised: ShadowStyle;
    popover: ShadowStyle;
}

export interface Theme {
    /** Always Day or Night: every other web theme is painted as its family. */
    name: DayNight;
    preference: ThemePreference;
    dark: boolean;
    colors: Palette;
    /** Flow-editor step families (`--type-*`): a step card's bar and icon tile. */
    stepType: WebStepType;
    /** Studio object kinds (`--kind-*`): an object's icon tile and pill. */
    kind: WebKind;
    /** Chart series colours, slot 1 first (`--chart-*`). */
    chart: WebChart;
    /** PII category colours, slot 1 first (`--pii-cat-*`). */
    pii: WebPii;
    /** Learning Center progress colours (`--learn-*`). */
    learn: WebLearn;
    /**
     * The theme's box shadows (`--shadow-*`), as React Native `boxShadow`
     * strings: soft drops on most themes, 1–2px rings on obsidian and
     * high-contrast. Android draws them from API 28.
     */
    shadows: WebShadows;
    elevation: Elevation;
    radii: Record<keyof typeof RADII, number>;
    spacing: typeof SPACING;
    type: TypeScale;
    /** The faces for the org's font; `mono` is for code. */
    fonts: FontSet;
    motion: typeof MOTION;
    hitSlop: typeof HIT_SLOP;
    minTouch: typeof MIN_TOUCH;
    branding: Branding;
    /** False until the stored theme has been read. The splash waits on it. */
    hydrated: boolean;
}
