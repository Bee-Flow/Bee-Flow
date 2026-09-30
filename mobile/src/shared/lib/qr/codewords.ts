/**
 * Payload to codewords: UTF-8 bytes in byte mode, the smallest version that
 * fits, padding, then per-block Reed–Solomon and the spec's interleaving.
 */

import { reedSolomon } from './reedSolomon';
import { EC_BLOCKS_M, MAX_VERSION } from './tables';

/**
 * TextEncoder exists on Hermes (it is used elsewhere in src/crypto), but this
 * keeps the encoder self-contained and dependency-free for the one thing it
 * has to get right: an otpauth URI is percent-encoded ASCII in practice, and
 * anything wider must still round-trip as UTF-8.
 */
export function utf8Bytes(text: string): number[] {
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

export function pickVersion(byteLength: number): number | null {
    for (let version = 1; version <= MAX_VERSION; version++) {
        if (byteLength <= dataCapacityBytes(version)) return version;
    }
    return null;
}

/** Bit stream → data codewords → per-block Reed–Solomon → interleaved output. */
export function buildCodewords(data: number[], version: number): number[] {
    const entry = EC_BLOCKS_M[version];
    if (!entry) throw new Error(`Unsupported QR version ${version}`);
    const [ecPerBlock, groups] = entry;
    const totalDataCodewords = groups.reduce((sum, [count, dataCw]) => sum + count * dataCw, 0);
    const dataCodewords = dataCodewordsFor(data, version, totalDataCodewords);

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
    return interleave(blocks, ecBlocks, ecPerBlock);
}

/** Mode, length and payload bits, terminated and padded to the data capacity. */
function dataCodewordsFor(data: number[], version: number, totalDataCodewords: number): number[] {
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
    return dataCodewords;
}

/** Data codewords column by column across blocks, then the EC codewords likewise. */
function interleave(blocks: number[][], ecBlocks: number[][], ecPerBlock: number): number[] {
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
