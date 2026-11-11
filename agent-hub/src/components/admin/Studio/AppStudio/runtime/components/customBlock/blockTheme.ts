/**
 * App Studio runtime: the app's look as a `custom_block` receives it.
 *
 * A frame cannot read the page's CSS variables, so the host resolves them where the block
 * sits (the app's theme and design, light or dark, are all in effect there) and writes plain
 * values into the frame document. A token the page does not define falls back to a neutral
 * light value.
 */

/** The app's look, resolved to plain CSS values (a frame cannot read the app's variables). */
export interface BlockTheme {
    appearance: 'light' | 'dark';
    primary: string;
    primaryContrast: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    border: string;
    radius: string;
    font: string;
}

export const FALLBACK_THEME: BlockTheme = {
    appearance: 'light',
    primary: '#0F766E',
    primaryContrast: '#ffffff',
    accent: '#0F766E',
    background: '#ffffff',
    surface: '#ffffff',
    text: '#111827',
    textMuted: '#6b7280',
    border: '#e5e7eb',
    radius: '8px',
    font: 'system-ui, sans-serif',
};

type ColorKey = 'primary' | 'primaryContrast' | 'accent' | 'background' | 'surface' | 'text' | 'textMuted' | 'border';

/** Per colour, the page variables that hold it, first one defined wins. */
const COLOR_SOURCES: ReadonlyArray<[ColorKey, readonly string[]]> = [
    ['primary', ['--app-primary']],
    ['primaryContrast', ['--app-primary-contrast']],
    ['accent', ['--app-accent', '--app-primary']],
    ['background', ['--app-canvas', '--bg-primary']],
    ['surface', ['--bg-card', '--bg-primary']],
    ['text', ['--text-primary']],
    ['textMuted', ['--text-muted', '--text-secondary']],
    ['border', ['--border-default']],
];

/** The channels of an `rgb(r, g, b)` / `rgba(r, g, b, a)` value, or null for any other notation. */
function rgbChannels(color: string): [number, number, number] | null {
    const open = color.indexOf('(');
    if (!color.startsWith('rgb') || open === -1 || !color.endsWith(')')) return null;
    const parts = color.slice(open + 1, -1).split(',').map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    return [parts[0], parts[1], parts[2]];
}

/** Dark when the ground is: an explicit app appearance wins, else the ground's own brightness. */
function appearanceOf(host: HTMLElement, background: string): 'light' | 'dark' {
    const stamped = host.closest('[data-app-appearance]')?.getAttribute('data-app-appearance');
    if (stamped === 'light' || stamped === 'dark') return stamped;
    const rgb = rgbChannels(background);
    if (!rgb) return 'light';
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 < 0.5 ? 'dark' : 'light';
}

/** The first of `names` the page defines where the probe sits, as the browser resolves it (a plain colour). */
function resolveColor(probe: HTMLElement, names: readonly string[], styles: CSSStyleDeclaration): string | null {
    for (const name of names) {
        const raw = styles.getPropertyValue(name).trim();
        if (!raw) continue;
        probe.style.color = `var(${name})`;
        const resolved = window.getComputedStyle(probe).color || raw;
        // A value that is still a reference means nothing inside the frame: the fallback stands in.
        return resolved.includes('var(') ? null : resolved;
    }
    return null;
}

/** The look at `host`. Total: never throws, and every key holds a usable CSS value. */
export function resolveBlockTheme(host: HTMLElement | null): BlockTheme {
    if (!host || typeof window === 'undefined') return FALLBACK_THEME;
    try {
        const styles = window.getComputedStyle(host);
        const probe = document.createElement('span');
        probe.hidden = true;
        host.appendChild(probe);
        const theme: BlockTheme = { ...FALLBACK_THEME };
        for (const [key, names] of COLOR_SOURCES) theme[key] = resolveColor(probe, names, styles) || FALLBACK_THEME[key];
        probe.remove();
        const radius = styles.getPropertyValue('--app-radius').trim();
        theme.radius = radius && !radius.includes('var(') ? radius : FALLBACK_THEME.radius;
        theme.font = styles.fontFamily || FALLBACK_THEME.font;
        theme.appearance = appearanceOf(host, theme.background);
        return theme;
    } catch {
        return FALLBACK_THEME;
    }
}

const FRAME_PREFIX = '--bf-';

/**
 * The custom properties the frame document sets from the look (shared/blockTemplate/frame.mjs
 * writes them into the frame's `:root`), each with the key of the look it holds. A block's
 * stylesheet reads these; the page's own variables do not reach the frame.
 */
export const FRAME_VARIABLES: ReadonlyArray<[Exclude<keyof BlockTheme, 'appearance'>, string]> = [
    ['primary', '--bf-primary'],
    ['primaryContrast', '--bf-primary-contrast'],
    ['accent', '--bf-accent'],
    ['background', '--bf-background'],
    ['surface', '--bf-surface'],
    ['text', '--bf-text'],
    ['textMuted', '--bf-text-muted'],
    ['border', '--bf-border'],
    ['radius', '--bf-radius'],
    ['font', '--bf-font'],
];

/** The look as the frame's `--bf-<name>` variables, by `<name>` (shared/blockTemplate/frame.mjs writes and filters them). */
export function themeVariablesOf(theme: BlockTheme): Record<string, string> {
    return Object.fromEntries(FRAME_VARIABLES.map(([key, name]) => [name.slice(FRAME_PREFIX.length), theme[key]]));
}
