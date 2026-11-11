/**
 * App Studio canonicalizer: a theme override for one screen or one section (package LK16).
 *
 * The same closed set of keys as the app theme (THEME_SPEC in core/cms/themeSpec.js: primary,
 * accent, canvas, radius, density, fontScale, appearance), each with the same values, but
 * PARTIAL: only the keys the override names are written, and only with a legal value. A section
 * has no ground of its own to paint, so it takes every key but `canvas`. The runtime applies the
 * override as the theme's CSS variables on that screen's or section's element
 * (agent-hub/.../runtime/themeScope.ts), so everything inside follows it and nothing outside does.
 *
 * An override that names no usable key is left out, so a screen or section without one keeps its
 * bytes. screen.theme is cleaned by canonicalize/screens.js, section.theme through
 * SECTION_KEY_CLEANERS (canonicalize/sectionKeys.mts).
 */

import { createRequire } from 'node:module';

type Push = (code: string, path: string, message: string) => void;
type ThemeField = { type: string; values?: readonly unknown[] };

const nodeRequire = createRequire(import.meta.url);
const { THEME_SPEC } = nodeRequire('../../core/cms/themeSpec.js') as { THEME_SPEC: Record<string, ThemeField> };
const { isHexColor } = nodeRequire('../componentSpecs/colorValue.js') as { isHexColor: (v: unknown) => v is string };

/** The keys a section's override may not set: a section paints no page ground. */
export const SECTION_THEME_SKIP: readonly string[] = Object.freeze(['canvas']);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Is `v` a legal value of theme key `key`? */
export function isScopeThemeValue(key: string, v: unknown): boolean {
    const spec = THEME_SPEC[key];
    if (!spec) return false;
    return spec.type === 'color' ? isHexColor(v) : !!spec.values && spec.values.includes(v);
}

/** The override as stored, in THEME_SPEC order, or undefined when nothing in it is usable. */
export function cleanScopeTheme(raw: unknown, path: string, push: Push, skip: readonly string[] = []): Record<string, unknown> | undefined {
    if (!isObject(raw)) {
        push('theme_override.invalid', path, 'A theme override must be an object of theme keys — dropped.');
        return undefined;
    }
    const legal = Object.keys(THEME_SPEC).filter((k) => !skip.includes(k));
    const unknown = Object.keys(raw).filter((k) => !legal.includes(k));
    if (unknown.length) push('theme_override.unknown_key', path, `Dropped keys a theme override cannot set: ${unknown.join(', ')}. Legal: ${legal.join(', ')}.`);
    const out: Record<string, unknown> = {};
    for (const key of legal) {
        const v = raw[key];
        if (v === undefined || v === null) continue;
        if (isScopeThemeValue(key, v)) out[key] = v;
        else push('theme_override.value_invalid', `${path}.${key}`, `${key} ${JSON.stringify(v)} is invalid — dropped.${THEME_SPEC[key].type === 'color' ? ' Use #rrggbb.' : ` Legal: ${(THEME_SPEC[key].values || []).join(', ')}.`}`);
    }
    return Object.keys(out).length ? out : undefined;
}

/** screen.theme: every theme key. */
export const cleanScreenTheme = (raw: unknown, path: string, push: Push) => cleanScopeTheme(raw, path, push);

/** section.theme: every theme key but canvas. */
export const cleanSectionTheme = (raw: unknown, path: string, push: Push) => cleanScopeTheme(raw, path, push, SECTION_THEME_SKIP);
