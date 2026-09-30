/** GF(2^8) arithmetic and the Reed–Solomon error-correction codewords. */

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

export function reedSolomon(data: number[], degree: number): number[] {
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
