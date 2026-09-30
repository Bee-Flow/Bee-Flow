/**
 * Design tokens.
 *
 * The web's values are not copied here: scripts/sync-web-tokens.mjs reads
 * agent-hub/src/index.css and writes generated/webTokens.generated.ts, and
 * webTokens.lockstep.test.ts fails when that file is stale. A mobile app that
 * drifts a shade away from the web app looks broken next to it, and a script
 * does not forget a token the way a hand port did (about fifty never made it).
 *
 * What stays here is what only a phone has: touch targets, motion, the
 * spacing steps and the type scale.
 *
 * Two web-only concepts are resolved at build time instead of at paint time:
 *   - `color-mix(in srgb, X n%, transparent)` becomes a literal rgba(), because
 *     RN has no colour arithmetic in styles.
 *   - `--radius-scale` (the admin "roundness" dial) is applied by
 *     derive.ts (scaledRadii), not baked in, so it can still change at runtime.
 */

import { DEFAULT_FONT, resolveFonts, typeScale } from './fonts';
import { WEB_RADII, WEB_THEMES, type WebTheme } from './generated/webTokens.generated';

/** Every theme the web app offers, `:root` (dark) first, in stylesheet order. */
export const THEME_NAMES = WEB_THEMES;

export type ThemeName = WebTheme;

/** The two themes the app paints: Day (`light`) and Night (`dark`). */
export type DayNight = 'light' | 'dark';

/**
 * The themes the picker offers: Day and Night, after "Match my phone". NOT the
 * same set as THEME_NAMES, deliberately.
 *
 * The web's other six stopped being choices on the phone (2026-09): the glass
 * pair because expo-blur renders them as a flat grey wash on Android, and
 * paper, sepia, obsidian and high contrast because two themes done well beat
 * eight half-tuned ones on a small screen.
 *
 * They all stay in THEME_NAMES and PALETTES on purpose. The generator writes
 * that table from the web app's index.css, the server's branding presets share
 * the same vocabulary (an org admin can pin `paper`), and a device may already
 * have one stored as its preference. resolve.ts maps each one to its family —
 * a dark-ink theme to Night, the rest to Day — instead of crashing on it.
 */
export const PICKABLE_THEMES: readonly DayNight[] = ['light', 'dark'];

/** Themes whose ink is light — drives the status bar and keyboard appearance. */
export const DARK_THEMES: ReadonlySet<ThemeName> = new Set<ThemeName>([
    'dark',
    'glass-dark',
    'high-contrast',
    'obsidian',
]);

export { PALETTES, type Palette, type PaletteSource } from './palettes';

/**
 * Base radii (the web's `--radius-*`), before --radius-scale. derive.ts
 * multiplies these so the admin roundness dial keeps working.
 */
export const RADII = { ...WEB_RADII, pill: 999 } as const;

/**
 * Spacing. The web is on Tailwind's 4px scale, half steps included (`gap-1.5`,
 * `px-2.5`, `px-3.5`, `px-5`), so the Tailwind step is a key here too:
 * `px-3.5` on the web is `theme.spacing[3.5]` on the phone. The names are the
 * same values, for code that reads as intent rather than arithmetic.
 */
export const SPACING = {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
    xxxl: 48,
    0.5: 2,
    1: 4,
    1.5: 6,
    2: 8,
    2.5: 10,
    3: 12,
    3.5: 14,
    4: 16,
    5: 20,
    6: 24,
    8: 32,
    12: 48,
} as const;

/**
 * The type scale on the web's default face (the platform's). Screens read
 * `theme.type`, which is the same scale on the org's font choice; this one
 * names the variants.
 */
export const TYPE = typeScale(resolveFonts(DEFAULT_FONT, () => false));

/**
 * Minimum touch target. Android's guidance is 48dp; several web controls in
 * Bee Flow are 32px, and every one of them has to grow here.
 */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TOUCH = 48;

/** Motion. Kept short: a phone that feels slow is a phone that feels broken. */
export const MOTION = {
    fast: 120,
    base: 200,
    slow: 320,
} as const;
