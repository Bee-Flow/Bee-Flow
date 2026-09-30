/**
 * The eight data masks and the penalty score (ISO/IEC 18004 §8.8.2) used to
 * pick the one a camera reads most reliably.
 */

export function applyMask(modules: boolean[], isFunction: boolean[], size: number, mask: number): void {
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

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export function penaltyScore(modules: boolean[], size: number): number {
    const at = (x: number, y: number) => modules[y * size + x] === true;
    let result = 0;
    // Rule 1 (runs) and rule 3 (finder-lookalikes), scanned by row then column.
    for (let a = 0; a < size; a++) {
        result += linePenalty((b) => at(b, a), size);
        result += linePenalty((b) => at(a, b), size);
    }
    return result + blockPenalty(at, size) + balancePenalty(modules, size);
}

/** Rules 1 and 3 along one row or column; `dark(b)` reads its b-th module. */
function linePenalty(dark: (b: number) => boolean, size: number): number {
    let result = 0;
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let b = 0; b < size; b++) {
        const d = dark(b);
        if (d === runColor) {
            runLength++;
            if (runLength === 5) result += PENALTY_N1;
            else if (runLength > 5) result++;
            continue;
        }
        addRunToHistory(runLength, history, size);
        if (!runColor) result += countFinderPatterns(history) * PENALTY_N3;
        runColor = d;
        runLength = 1;
    }
    return result + terminateRun(runColor, runLength, history, size) * PENALTY_N3;
}

/** Rule 2: solid 2×2 blocks. */
function blockPenalty(at: (x: number, y: number) => boolean, size: number): number {
    let result = 0;
    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const c = at(x, y);
            if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) result += PENALTY_N2;
        }
    }
    return result;
}

/** Rule 4: how far the dark/light balance strays from 50%. */
function balancePenalty(modules: boolean[], size: number): number {
    let dark = 0;
    for (let i = 0; i < size * size; i++) if (modules[i] === true) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return k * PENALTY_N4;
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
    const h = (i: number) => history[i] ?? 0;
    const n = h(1);
    const core = n > 0 && h(2) === n && h(3) === n * 3 && h(4) === n && h(5) === n;
    if (!core) return 0;
    return (h(0) >= n * 4 && h(6) >= n ? 1 : 0) + (h(6) >= n * 4 && h(0) >= n ? 1 : 0);
}
