/**
 * Hex colour arithmetic for the theme: WCAG luminance and contrast, HSL
 * saturation, and a lighten/darken step. Pure and dependency-free; only
 * `#rgb` and `#rrggbb` are understood, and anything else is treated as
 * "not a colour" rather than guessed at.
 */

export function isHexColor(value: unknown): value is string {
    return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/** `#abc` → `aabbcc`, `#aabbcc` → `aabbcc`. */
function expand(hex: string): string {
    const h = hex.replace('#', '');
    return h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
}

/** The three 0..255 channels of a hex colour. */
export function rgbChannels(hex: string): [number, number, number] {
    const full = expand(hex);
    return [0, 1, 2].map((i) => parseInt(full.slice(i * 2, i * 2 + 2), 16)) as [number, number, number];
}

/** Relative luminance per WCAG 2.1, for the accent-foreground derivation. */
export function luminance(hex: string): number {
    const channel = (v255: number) => {
        const v = v255 / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = rgbChannels(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two hex colours. 1 for anything not hex. */
export function contrast(a: string, b: string): number {
    if (!isHexColor(a) || !isHexColor(b)) return 1;
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
}

/** HSL saturation, 0..1. Zero for anything not hex. */
export function saturation(hex: string): number {
    if (!isHexColor(hex)) return 0;
    const [r, g, b] = rgbChannels(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const l = (max + min) / 2 / 255;
    return (max - min) / 255 / (1 - Math.abs(2 * l - 1));
}

/**
 * The text colour for a background, as the web's applyTheme.readableForeground
 * picks it (ported line for line; derive.test.ts runs the two side by side):
 * black once the luminance passes 0.179, where black starts to out-contrast
 * white, else white. `#rgb`, `#rrggbb` and `#rrggbbaa`; white for anything else.
 */
export function readableForeground(hex: unknown): '#000000' | '#ffffff' {
    if (typeof hex !== 'string' || !hex.startsWith('#')) return '#ffffff';
    const stripped = hex.slice(1);
    let rgb: number[];
    if (stripped.length === 3) {
        rgb = [0, 1, 2].map((i) => parseInt(`${stripped[i]}${stripped[i]}`, 16));
    } else if (stripped.length === 6 || stripped.length === 8) {
        rgb = [0, 2, 4].map((i) => parseInt(stripped.slice(i, i + 2), 16));
    } else {
        return '#ffffff';
    }
    if (rgb.some(Number.isNaN)) return '#ffffff';
    const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = rgb as [number, number, number];
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.179 ? '#000000' : '#ffffff';
}

/** Darken/lighten a hex colour by `amount` (-1..1), for an accent shade. */
export function shift(hex: string, amount: number): string {
    const out = rgbChannels(hex).map((v) => {
        const next = amount >= 0 ? v + (255 - v) * amount : v * (1 + amount);
        return Math.max(0, Math.min(255, Math.round(next)))
            .toString(16)
            .padStart(2, '0');
    });
    return `#${out.join('')}`;
}
