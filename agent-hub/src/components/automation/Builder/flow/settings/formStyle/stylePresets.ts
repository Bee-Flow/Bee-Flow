/**
 * The no-code look of a hosted form: the theme presets (one click sets all five
 * theme keys; THIS is the "styling without code" story) and the colour swatches.
 * The theme keys are App Studio's shared THEME_SPEC (server/core/cms/themeSpec.js);
 * the form-only knobs live in `form.style` (components/forms/formStyleVars.ts).
 */

export type Theme = Record<string, unknown>;
export type Style = Record<string, unknown>;

export const THEME_PRESETS = [
    { id: 'clean', label: 'Clean', theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' } },
    { id: 'corporate', label: 'Corporate', theme: { primary: '#1D4ED8', radius: 'sm', density: 'compact', fontScale: 'sm', appearance: 'light' } },
    { id: 'friendly', label: 'Friendly', theme: { primary: '#C2410C', radius: 'xl', density: 'spacious', fontScale: 'lg', appearance: 'light' } },
    { id: 'night', label: 'Night', theme: { primary: '#0891B2', radius: 'lg', density: 'comfortable', fontScale: 'md', appearance: 'dark' } },
    { id: 'system', label: 'Match visitor', theme: { primary: '#047857', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' } },
];

export const COLOR_PRESETS = [
    '#0F766E', '#0369A1', '#1D4ED8', '#0891B2', '#047857', '#4D7C0F',
    '#B45309', '#C2410C', '#B91C1C', '#BE185D', '#334155', '#57534E',
];

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '';

/** The theme with one key set, or removed when `value` is empty (accent and canvas are optional). */
export function withThemeValue(theme: Theme, key: string, value: unknown): Theme {
    const next = { ...theme };
    if (isEmpty(value)) delete next[key];
    else next[key] = value;
    return next;
}

/**
 * The style with one key set, or without it when `value` is empty. Never a key
 * that was not set (the server canonicalises the same way); an empty style is
 * no style at all.
 */
export function withStyleValue(style: Style | null | undefined, key: string, value: unknown): Style | undefined {
    const next: Style = { ...(style || {}) };
    if (isEmpty(value)) delete next[key];
    else next[key] = value;
    return Object.keys(next).length ? next : undefined;
}

/** The style with one `button` key set or removed; an empty `button` goes too. */
export function withButtonValue(style: Style | null | undefined, key: string, value: unknown): Style | undefined {
    const current = style?.button && typeof style.button === 'object' ? style.button as Style : {};
    return withStyleValue(style, 'button', withStyleValue(current, key, value));
}

/** The preset whose five keys the theme matches exactly, if any. */
export function activePresetId(theme: Theme | null | undefined): string | null {
    const hit = THEME_PRESETS.find(p => Object.entries(p.theme).every(([k, v]) => theme?.[k] === v));
    return hit ? hit.id : null;
}
