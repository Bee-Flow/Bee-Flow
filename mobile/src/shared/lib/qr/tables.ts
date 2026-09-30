/**
 * The ISO/IEC 18004 constants this encoder needs, for level M and versions
 * 1–10 only (an otpauth URI is 70–130 bytes; version 10 at M holds 213).
 */

/** Error-correction level M: 2 bits `00` in the format information. */
export const EC_LEVEL_FORMAT_BITS = 0b00;

/**
 * Per version: [EC codewords per block, [block count, data codewords per block][]].
 * Level M only — ISO/IEC 18004 table 9.
 */
export const EC_BLOCKS_M: Record<number, [number, [number, number][]]> = {
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

export const MAX_VERSION = 10;
