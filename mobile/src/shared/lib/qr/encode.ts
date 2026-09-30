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
 * intent; the tables (tables.ts) are the spec's own.
 */

import { buildCodewords, pickVersion, utf8Bytes } from './codewords';
import { applyMask, penaltyScore } from './mask';
import { drawCodewords, drawFormatBits, drawFunctionPatterns } from './matrix';

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
