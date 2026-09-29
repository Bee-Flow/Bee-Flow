/**
 * A minimal QR encoder — byte mode, error-correction level M, versions 1–10.
 *
 * Why write one at all: the only thing this app ever encodes is the
 * `otpauth://totp/...` URI from POST /auth/mfa/setup, and the alternative is
 * to render the PNG data URL the server also returns. That PNG is fixed at
 * whatever pixel size the server chose and is a black-on-white bitmap, which
 * on a dark theme is either a bright rectangle or, if tinted, an unscannable
 * one. Vector modules scale to the screen and can be painted in the theme's
 * own ink, so the QR looks like part of the app instead of a pasted image.
 *
 * Why only versions 1–10 and level M: an otpauth URI is 70–130 bytes, and
 * version 10 at level M holds 213. Anything longer is not a TOTP URI and is
 * handled by returning null — the screen then falls back to the server's PNG
 * and, failing that, to the manual key, which is the honest outcome. A QR that
 * is drawn but wrong is far worse than no QR, so every step here follows
 * ISO/IEC 18004 exactly rather than approximating.
 *
 * The structure (function-pattern drawing, the zigzag codeword walk, the eight
 * masks and their penalty scores) follows Project Nayuki's reference QR
 * implementation, which is the clearest published statement of the spec's
 * intent; the tables below are the spec's own.
 */

/** Error-correction level M: 2 bits `00` in the format information. */
const EC_LEVEL_FORMAT_BITS = 0b00;

/**
 * Per version: [EC codewords per block, [block count, data codewords per block][]].
 * Level M only — ISO/IEC 18004 table 9.
 */
const EC_BLOCKS_M: Record<number, [number, [number, number][]]> = {
    1: [10, [[1, 16]]],
    2: [16, [[1, 28]]],
    3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],
    5: [24, [[2, 43]]],
    6: [16, [[4, 27]]],
    7: [18, [[4, 31]]],
    8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]],
    10: [26, [[4, 43], [1, 44]]],
};

const MAX_VERSION = 10;

export interface QrMatrix {
    /** Modules per side, excluding the quiet zone. */
    size: number;
    /** Row-major; true is a dark module. */
    modules: boolean[][];
}

/**
 * Encode `text` as UTF-8 in byte mode. Returns null when the payload does not
 * fit in version 10 at level M — the caller must then show something else.
 */
export function encodeQr(text: string): QrMatrix | null {
    const data = utf8Bytes(text);

    const version = pickVersion(data.length);
    if (version === null) return null;

    const codewords = buildCodewords(data, version);
    const size = version * 4 + 17;

    const modules: boolean[] = new Array<boolean>(size * size).fill(false);
    const isFunction: boolean[] = new Array<boolean>(size * size).fill(false);

    drawFunctionPatterns(modules, isFunction, size, version);
    drawCodewords(modules, isFunction, size, codewords);

    // Every mask is legal — the format information records which one was used
    // — so this is purely about picking the one a camera reads most reliably.
    let bestMask = 0;
    let bestPenalty = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask++) {
        applyMask(modules, isFunction, size, mask);
        drawFormatBits(modules, isFunction, size, mask);
        const penalty = penaltyScore(modules, size);
        if (penalty < bestPenalty) {
            bestPenalty = penalty;
            bestMask = mask;
        }
        // XOR is its own inverse, so re-applying restores the unmasked grid.
        applyMask(modules, isFunction, size, mask);
    }
    applyMask(modules, isFunction, size, bestMask);
    drawFormatBits(modules, isFunction, size, bestMask);

    const rows: boolean[][] = [];
    for (let y = 0; y < size; y++) {
        const row: boolean[] = [];
        for (let x = 0; x < size; x++) row.push(modules[y * size + x] === true);
        rows.push(row);
    }
    return { size, modules: rows };
}

// ---------------------------------------------------------------------------
// Data encoding
// ---------------------------------------------------------------------------

/**
 * TextEncoder exists on Hermes (it is used elsewhere in src/crypto), but this
 * keeps the encoder self-contained and dependency-free for the one thing it
 * has to get right: an otpauth URI is percent-encoded ASCII in practice, and
 * anything wider must still round-trip as UTF-8.
 */
function utf8Bytes(text: string): number[] {
    const encoded = new TextEncoder().encode(text);
    return Array.from(encoded);
}

function dataCapacityBytes(version: number): number {
    const entry = EC_BLOCKS_M[version];
    if (!entry) return 0;
    const totalDataCodewords = entry[1].reduce((sum, [count, dataCw]) => sum + count * dataCw, 0);
    // Mode indicator (4 bits) + character count (8 bits below version 10, else 16).
    const headerBits = 4 + (version < 10 ? 8 : 16);
    return Math.floor((totalDataCodewords * 8 - headerBits) / 8);
}

function pickVersion(byteLength: number): number | null {
    for (let version = 1; version <= MAX_VERSION; version++) {
        if (byteLength <= dataCapacityBytes(version)) return version;
    }
    return null;
}

/** Bit stream → data codewords → per-block Reed–Solomon → interleaved output. */
function buildCodewords(data: number[], version: number): number[] {
    const entry = EC_BLOCKS_M[version];
    if (!entry) throw new Error(`Unsupported QR version ${version}`);
    const [ecPerBlock, groups] = entry;

    const totalDataCodewords = groups.reduce((sum, [count, dataCw]) => sum + count * dataCw, 0);

    const bits: number[] = [];
    const push = (value: number, length: number) => {
        for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };

    push(0b0100, 4); // byte mode
    push(data.length, version < 10 ? 8 : 16);
    for (const byte of data) push(byte, 8);

    // Terminator, then pad to a byte boundary, then the spec's alternating
    // pad bytes. All three are required: a decoder reads the length field, but
    // the codeword stream still has to be exactly `totalDataCodewords` long.
    const capacityBits = totalDataCodewords * 8;
    for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const dataCodewords: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
        dataCodewords.push(byte);
    }
    for (let pad = 0xec; dataCodewords.length < totalDataCodewords; pad ^= 0xec ^ 0x11) {
        dataCodewords.push(pad);
    }

    // Split into blocks, in the order the spec interleaves them.
    const blocks: number[][] = [];
    const ecBlocks: number[][] = [];
    let offset = 0;
    for (const [count, dataCw] of groups) {
        for (let i = 0; i < count; i++) {
            const block = dataCodewords.slice(offset, offset + dataCw);
            offset += dataCw;
            blocks.push(block);
            ecBlocks.push(reedSolomon(block, ecPerBlock));
        }
    }

    const maxBlockLength = Math.max(...blocks.map((b) => b.length));
    const out: number[] = [];
    for (let i = 0; i < maxBlockLength; i++) {
        for (const block of blocks) {
            const cw = block[i];
            if (cw !== undefined) out.push(cw);
        }
    }
    for (let i = 0; i < ecPerBlock; i++) {
        for (const block of ecBlocks) out.push(block[i] ?? 0);
    }
    return out;
}

// ---------------------------------------------------------------------------
// GF(2^8) and Reed–Solomon
// ---------------------------------------------------------------------------

/** Multiplication in GF(256) with the QR primitive polynomial 0x11d. */
function gfMultiply(a: number, b: number): number {
    let result = 0;
    for (let i = 7; i >= 0; i--) {
        result = (result << 1) ^ ((result >>> 7) * 0x11d);
        result ^= ((b >>> i) & 1) * a;
    }
    return result & 0xff;
}

/** The divisor polynomial for `degree` error-correction codewords. */
function rsDivisor(degree: number): number[] {
    const result = new Array<number>(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMultiply(result[j] ?? 0, root);
            const next = result[j + 1];
            if (next !== undefined) result[j] = (result[j] ?? 0) ^ next;
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function reedSolomon(data: number[], degree: number): number[] {
    const divisor = rsDivisor(degree);
    const result = new Array<number>(degree).fill(0);
    for (const byte of data) {
        const factor = byte ^ (result.shift() ?? 0);
        result.push(0);
        for (let i = 0; i < result.length; i++) {
            result[i] = (result[i] ?? 0) ^ gfMultiply(divisor[i] ?? 0, factor);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

function drawFunctionPatterns(
    modules: boolean[],
    isFunction: boolean[],
    size: number,
    version: number,
): void {
    const set = (x: number, y: number, dark: boolean) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        modules[y * size + x] = dark;
        isFunction[y * size + x] = true;
    };

    // Timing patterns: the alternating row and column at index 6.
    for (let i = 0; i < size; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }

    // Finder patterns, plus their light separators (the `dist` test paints a
    // 9×9 neighbourhood, so the separator falls out of the same loop).
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

    const positions = alignmentPositions(version);
    for (let i = 0; i < positions.length; i++) {
        for (let j = 0; j < positions.length; j++) {
            // The three corners already carry finder patterns.
            const corner =
                (i === 0 && j === 0) ||
                (i === 0 && j === positions.length - 1) ||
                (i === positions.length - 1 && j === 0);
            if (corner) continue;
            const cx = positions[i] ?? 0;
            const cy = positions[j] ?? 0;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        }
    }

    // Reserve the format area with a placeholder; the real bits are written
    // once a mask has been chosen.
    drawFormatBits(modules, isFunction, size, 0);
    drawVersionBits(modules, isFunction, size, version);
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
function drawFormatBits(
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
function drawCodewords(
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

function applyMask(modules: boolean[], isFunction: boolean[], size: number, mask: number): void {
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (isFunction[y * size + x] === true) continue;
            let invert: boolean;
            switch (mask) {
                case 0: invert = (x + y) % 2 === 0; break;
                case 1: invert = y % 2 === 0; break;
                case 2: invert = x % 3 === 0; break;
                case 3: invert = (x + y) % 3 === 0; break;
                case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            }
            if (invert) modules[y * size + x] = modules[y * size + x] !== true;
        }
    }
}

// ---------------------------------------------------------------------------
// Mask penalty scoring (ISO/IEC 18004 §8.8.2)
// ---------------------------------------------------------------------------

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function penaltyScore(modules: boolean[], size: number): number {
    const at = (x: number, y: number) => modules[y * size + x] === true;
    let result = 0;

    // Rule 1 (runs) and rule 3 (finder-lookalikes), scanned by row then column.
    for (let axis = 0; axis < 2; axis++) {
        for (let a = 0; a < size; a++) {
            let runColor = false;
            let runLength = 0;
            const history = [0, 0, 0, 0, 0, 0, 0];
            for (let b = 0; b < size; b++) {
                const dark = axis === 0 ? at(b, a) : at(a, b);
                if (dark === runColor) {
                    runLength++;
                    if (runLength === 5) result += PENALTY_N1;
                    else if (runLength > 5) result++;
                } else {
                    addRunToHistory(runLength, history, size);
                    if (!runColor) result += countFinderPatterns(history) * PENALTY_N3;
                    runColor = dark;
                    runLength = 1;
                }
            }
            result += terminateRun(runColor, runLength, history, size) * PENALTY_N3;
        }
    }

    // Rule 2: solid 2×2 blocks.
    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const c = at(x, y);
            if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) {
                result += PENALTY_N2;
            }
        }
    }

    // Rule 4: how far the dark/light balance strays from 50%.
    let dark = 0;
    for (let i = 0; i < size * size; i++) if (modules[i] === true) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
}

function addRunToHistory(runLength: number, history: number[], size: number): void {
    // A symbol's edge counts as an infinitely wide light border, which is what
    // makes the 1:1:3:1:1 test work at the very start of a line.
    const length = history[0] === 0 ? runLength + size : runLength;
    history.pop();
    history.unshift(length);
}

function terminateRun(
    runColor: boolean,
    runLength: number,
    history: number[],
    size: number,
): number {
    let length = runLength;
    if (runColor) {
        addRunToHistory(length, history, size);
        length = 0;
    }
    length += size;
    addRunToHistory(length, history, size);
    return countFinderPatterns(history);
}

/** The 1:1:3:1:1 ratio with four light modules on one side of it. */
function countFinderPatterns(history: number[]): number {
    const n = history[1] ?? 0;
    const core =
        n > 0 &&
        history[2] === n &&
        history[3] === n * 3 &&
        history[4] === n &&
        history[5] === n;
    return (
        (core && (history[0] ?? 0) >= n * 4 && (history[6] ?? 0) >= n ? 1 : 0) +
        (core && (history[6] ?? 0) >= n * 4 && (history[0] ?? 0) >= n ? 1 : 0)
    );
}
