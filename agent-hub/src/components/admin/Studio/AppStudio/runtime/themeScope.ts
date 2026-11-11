/**
 * App Studio runtime: theme scope (package LK16).
 *
 *   scopeThemeVars(override, base)   a screen's or section's theme override as the CSS variables
 *                                    of the keys it names, to lay over the inherited ones on that
 *                                    element. Built by themeVars() itself on the merged theme, so
 *                                    a value means exactly what it means on the app root.
 *   darkPaletteVars(dark, theme)     design.dark as --app-dark-* variables; css/themeScope.css
 *                                    swaps them in while the app is dark (never under the
 *                                    high-contrast host theme).
 *
 * Absent keys emit nothing, so a screen, section or design without them renders as before.
 */

import { themeVars } from './themeVars';
import type { CSSProperties } from 'react';

type Theme = Record<string, unknown>;
type Vars = Record<string, string | undefined>;

const isObject = (v: unknown): v is Theme => !!v && typeof v === 'object' && !Array.isArray(v);

const PRIMARY_VARS = ['--app-primary', '--app-primary-soft', '--app-primary-contrast'];
const ACCENT_VARS = ['--app-accent', '--app-accent-soft', '--app-accent-contrast'];

/** Which themeVars() outputs each theme key decides. */
const VARS_OF_KEY: Readonly<Record<string, readonly string[]>> = Object.freeze({
    primary: PRIMARY_VARS,
    accent: ACCENT_VARS,
    canvas: ['--app-canvas'],
    radius: ['--app-radius'],
    density: ['--app-space'],
    fontScale: ['fontSize'],
    appearance: ['colorScheme'],
});

/** The theme an element under `override` sees: the inherited theme with the override's keys on top. */
function mergedTheme(base: unknown, override: unknown): Theme {
    return { ...(isObject(base) ? base : {}), ...(isObject(override) ? override : {}) };
}

/**
 * The CSS variables of the keys `override` names, as themeVars gives them for the merged theme.
 * A new primary also moves the accent when neither the inherited theme nor the override has an
 * accent of its own (the accent then follows the primary, as on the app root).
 */
export function scopeThemeVars(override: unknown, base: unknown): CSSProperties {
    if (!isObject(override)) return {};
    const keys = Object.keys(override).filter((k) => Object.hasOwn(VARS_OF_KEY, k));
    if (!keys.length) return {};
    const full = themeVars(mergedTheme(base, override)) as Vars;
    const names = new Set(keys.flatMap((k) => VARS_OF_KEY[k]));
    if (names.has('--app-primary') && !(isObject(base) && base.accent) && !override.accent) ACCENT_VARS.forEach((n) => names.add(n));
    const out: Vars = {};
    for (const name of names) if (full[name] !== undefined) out[name] = full[name];
    return out as CSSProperties;
}

/** The appearance an override pins, for the element's data-app-appearance, or undefined. */
function scopeAppearance(override: unknown): string | undefined {
    const a = isObject(override) ? override.appearance : undefined;
    return a === 'light' || a === 'dark' || a === 'auto' ? a : undefined;
}

/**
 * design.dark as --app-dark-* variables plus the classes that switch them in: `--on` for an app
 * that is always dark, `--auto` for one that follows the host theme, `--canvas` when a dark canvas
 * is set. Nothing for a design without a dark palette or an app pinned to light.
 */
export function darkPaletteVars(dark: unknown, theme: unknown, own: unknown = null): { className: string; style: CSSProperties } {
    const t = isObject(theme) ? theme : {};
    if (!isObject(dark) || t.appearance === 'light') return { className: '', style: {} };
    // A screen's own colour (its override, `own`) wins over the app's dark palette on that screen.
    const o = isObject(own) ? own : {};
    const pick = (key: string) => o[key] ?? dark[key] ?? t[key];
    const palette: Theme = { primary: pick('primary'), accent: pick('accent') };
    const canvas = pick('canvas');
    const full = themeVars(mergedTheme(t, palette)) as Vars;
    const style: Vars = {};
    for (const name of [...PRIMARY_VARS, ...ACCENT_VARS]) style[name.replace('--app-', '--app-dark-')] = full[name];
    const classes = [t.appearance === 'dark' ? 'app-dark-palette--on' : 'app-dark-palette--auto'];
    if (typeof canvas === 'string' && (typeof dark.canvas === 'string' || typeof o.canvas === 'string')) {
        style['--app-dark-canvas'] = canvas;
        classes.push('app-dark-palette--canvas');
    }
    return { className: classes.join(' '), style: style as CSSProperties };
}

/**
 * What a screen's theme override (screen.theme) gives the AppRenderer root: the theme the screen
 * shows, the variables to lay over the app theme's, the appearance to stamp and the class that
 * paints a canvas of its own. For a screen without an override: the app theme itself and nothing
 * else.
 */
export function screenThemeScope(appTheme: unknown, screen: unknown) {
    const own = isObject(screen) ? screen.theme : undefined;
    const override = isObject(own) ? own : null;
    const appAppearance = isObject(appTheme) && typeof appTheme.appearance === 'string' ? appTheme.appearance : 'auto';
    if (!override) return { theme: appTheme, override: null, style: {} as CSSProperties, className: '', appearance: appAppearance || 'auto' };
    return {
        theme: mergedTheme(appTheme, override) as unknown,
        override: override as unknown,
        style: scopeThemeVars(override, appTheme),
        className: typeof override.canvas === 'string' ? ' app-screen--canvas' : '',
        appearance: scopeAppearance(override) ?? (appAppearance || 'auto'),
    };
}

/**
 * What a section's theme override (section.theme) gives its element: the variables, the
 * appearance it pins (stamped as data-app-appearance, which app-tokens.css re-declares the
 * platform tokens on) and the class that paints a ground of that appearance. Nothing without one.
 */
export function sectionThemeScope(override: unknown, inherited: unknown): { style: CSSProperties; className: string; appearance: string | undefined } {
    if (!isObject(override)) return { style: {}, className: '', appearance: undefined };
    const appearance = scopeAppearance(override);
    const pinned = appearance === 'light' || appearance === 'dark';
    return { style: scopeThemeVars(override, inherited), className: pinned ? ' app-section--themed-ground' : '', appearance: pinned ? appearance : undefined };
}
