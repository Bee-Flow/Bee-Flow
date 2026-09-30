/**
 * `color-mix(in srgb, X n%, transparent)` for React Native, which has no
 * colour arithmetic in styles.
 *
 * The web tints nearly everything it paints with a status or kind colour this
 * way (a chip is its tone at 15%, a danger button at 10% with a 30% border, a
 * kind tile at 16–18%), and it mixes at paint time so the tint follows the
 * theme. The phone mixes when the themed style sheet is built, which is the
 * same moment: the theme is known and the result is a literal rgba().
 *
 * Mixing with `transparent` in sRGB is exactly "the same colour at n% of its
 * alpha", so a colour that is already translucent (a border token, an rgba
 * item background) keeps its own alpha multiplied rather than replaced.
 */

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGBA = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

function round(n: number): number {
    return Math.round(n * 1000) / 1000;
}

/** [r, g, b, a] for `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; null otherwise. */
export function parseColor(color: string): [number, number, number, number] | null {
    const value = color.trim();
    const hex = HEX.exec(value)?.[1];
    if (hex) {
        const full = hex.length <= 4 ? hex.split('').map((c) => c + c).join('') : hex;
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
        const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
        return [r, g, b, a];
    }
    const m = RGBA.exec(value);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/**
 * The colour at `percent` of its own strength over transparent, as `rgba()`.
 * Anything that is not a colour this can read (a named colour, `transparent`
 * itself) comes back unchanged rather than guessed at.
 */
export function tint(color: string, percent: number): string {
    const parsed = parseColor(color);
    if (!parsed) return color;
    const [r, g, b, a] = parsed;
    const alpha = round(a * Math.min(100, Math.max(0, percent)) / 100);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
