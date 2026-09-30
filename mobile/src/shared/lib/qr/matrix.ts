/**
 * Drawing into the module grid: the function patterns (finders, timing,
 * alignment, format and version information) and the zigzag codeword walk.
 * Grids are flat row-major arrays; `isFunction` marks modules masks skip.
 */

import { EC_LEVEL_FORMAT_BITS } from './tables';

type SetModule = (x: number, y: number, dark: boolean) => void;

export function drawFunctionPatterns(
    modules: boolean[],
    isFunction: boolean[],
    size: number,
    version: number,
): void {
    const set: SetModule = (x, y, dark) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        modules[y * size + x] = dark;
        isFunction[y * size + x] = true;
    };

    // Timing patterns: the alternating row and column at index 6.
    for (let i = 0; i < size; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }
    drawFinders(set, size);
    drawAlignments(set, version);

    // Reserve the format area with a placeholder; the real bits are written
    // once a mask has been chosen.
    drawFormatBits(modules, isFunction, size, 0);
    drawVersionBits(modules, isFunction, size, version);
}

/**
 * Finder patterns, plus their light separators (the `dist` test paints a 9×9
 * neighbourhood, so the separator falls out of the same loop).
 */
function drawFinders(set: SetModule, size: number): void {
    for (const [cx, cy] of [
        [3, 3],
        [size - 4, 3],
        [3, size - 4],
    ] as const) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
            }
        }
    }
}

/** Alignment patterns on the spec's grid, except the three finder corners. */
function drawAlignments(set: SetModule, version: number): void {
    const positions = alignmentPositions(version);
    const last = positions.length - 1;
    for (let i = 0; i < positions.length; i++) {
        for (let j = 0; j < positions.length; j++) {
            const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
            if (!corner) drawAlignment(set, positions[i] ?? 0, positions[j] ?? 0);
        }
    }
}

function drawAlignment(set: SetModule, cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }
}

/** Alignment-pattern centres. Version 1 has none; the rest follow the spec's rule. */
function alignmentPositions(version: number): number[] {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const size = version * 4 + 17;
    const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
}

/** The 15-bit format information (level M + mask), BCH-coded, drawn twice. */
export function drawFormatBits(
    modules: boolean[],
    isFunction: boolean[],
    size: number,
    mask: number,
): void {
    const data = (EC_LEVEL_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const set = (x: number, y: number, dark: boolean) => {
        modules[y * size + x] = dark;
        isFunction[y * size + x] = true;
    };

    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    // The one module that is dark in every symbol ever made.
    set(8, size - 8, true);
}

/** The 18-bit version information, present only from version 7 up. */
function drawVersionBits(
    modules: boolean[],
    isFunction: boolean[],
    size: number,
    version: number,
): void {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;

    for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        modules[b * size + a] = dark;
        isFunction[b * size + a] = true;
        modules[a * size + b] = dark;
        isFunction[a * size + b] = true;
    }
}

/** The two-module-wide zigzag from the bottom-right corner upwards. */
export function drawCodewords(
    modules: boolean[],
    isFunction: boolean[],
    size: number,
    codewords: number[],
): void {
    // The spec's "remainder bits" (7 of them on versions 2-6) need no handling:
    // they are the modules left over after the last codeword, they are defined
    // to be light, and the grid starts out light.
    let i = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
        // Column 6 is the vertical timing pattern and is skipped entirely.
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (isFunction[y * size + x] === true || i >= totalBits) continue;
                const byte = codewords[i >>> 3] ?? 0;
                modules[y * size + x] = ((byte >>> (7 - (i & 7))) & 1) !== 0;
                i++;
            }
        }
    }
}
