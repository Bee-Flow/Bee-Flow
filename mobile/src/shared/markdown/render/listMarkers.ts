/**
 * List markers by nesting, from the web's `.markdown-content` list rules:
 * `ul` disc and `ul ul` circle (at any deeper level); `ol` decimal, `ol ol`
 * lower-alpha, `ol ol ol` lower-roman. The two kinds nest independently —
 * CSS has no `ul ol` rule, so a numbered list inside bullets is decimal.
 */

/** `depth` is how many bullet lists enclose the item, itself included. */
export function bulletMarker(depth: number): string {
    return depth <= 1 ? '•' : '◦';
}

function alpha(n: number): string {
    let out = '';
    for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
        out = String.fromCharCode(97 + ((rest - 1) % 26)) + out;
    }
    return out;
}

const ROMAN: readonly [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

function roman(n: number): string {
    let rest = n;
    let out = '';
    for (const [value, glyph] of ROMAN) {
        while (rest >= value) {
            out += glyph;
            rest -= value;
        }
    }
    return out;
}

/** `depth` is how many numbered lists enclose the item, itself included. */
export function numberMarker(n: number, depth: number): string {
    if (n < 1 || depth <= 1) return `${n}.`;
    return depth === 2 ? `${alpha(n)}.` : `${roman(n)}.`;
}

/** The marker column's width: room for the widest marker in the list. */
export function markerWidth(markers: readonly string[], bullets: boolean): number {
    if (bullets) return 20;
    const widest = markers.reduce((max, m) => Math.max(max, m.length), 0);
    return Math.max(24, widest * 8 + 8);
}
