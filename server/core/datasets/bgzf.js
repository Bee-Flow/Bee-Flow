/**
 * core/datasets — BGZF blocks on plain zlib. No native deps, deliberately.
 *
 * BGZF (the blocked-gzip framing used by the bioinformatics toolchain) is
 * nothing more than a series of complete gzip members, each at most 64 KB
 * TOTAL size, each carrying its own compressed size in a gzip "extra" field
 * (subfield 'BC', value BSIZE = total block length − 1). Because every block
 * is self-contained, a reader that knows a block's byte offset can inflate
 * just that block from a ranged read — which is the entire trick the dataset
 * query path is built on (stores/storageStore.streamFile({range})).
 *
 * We WRITE our own blocks during ingest (so we control every block boundary
 * and can index them) and READ them back during queries. Output is valid
 * .bgz — bgzip/tabix/samtools can open what we produce; we never need to
 * parse anyone else's .tbi.
 */

const zlib = require('zlib');

// A gzip member is capped at 65536 bytes TOTAL (header 18 + deflate + trailer 8,
// BSIZE is a uint16). Deflate can expand incompressible input by ~5 bytes per
// 16 KB window plus a few constants, so the raw payload gets 65,280 bytes of
// headroom — the same margin htslib uses.
const MAX_BLOCK_INPUT = 65_280;

// The canonical 28-byte BGZF EOF marker (an empty block). Readers in the wild
// use it to distinguish "end of file" from "file was truncated mid-block".
const EOF_BLOCK = Buffer.from([
    0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff,
    0x06, 0x00, 0x42, 0x43, 0x02, 0x00, 0x1b, 0x00,
    0x03, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * Compress one payload into one complete BGZF block.
 * @param {Buffer} uncompressed — at most MAX_BLOCK_INPUT bytes, at least 1.
 * @returns {Buffer} the full gzip member (header + deflate + CRC32 + ISIZE)
 */
function writeBlock(uncompressed) {
    if (!Buffer.isBuffer(uncompressed) || uncompressed.length === 0) {
        throw new Error('bgzf.writeBlock: non-empty Buffer required');
    }
    if (uncompressed.length > MAX_BLOCK_INPUT) {
        throw new Error(`bgzf.writeBlock: payload ${uncompressed.length} exceeds ${MAX_BLOCK_INPUT}`);
    }
    const deflated = zlib.deflateRawSync(uncompressed, { level: 6 });
    const total = 18 + deflated.length + 8;
    if (total > 65_536) {
        // Unreachable with the input cap above; kept as an invariant so a future
        // cap change cannot silently emit blocks no BGZF reader will accept.
        throw new Error(`bgzf.writeBlock: block would be ${total} bytes (max 65536)`);
    }
    const block = Buffer.alloc(total);
    // gzip header: magic, CM=deflate, FLG=FEXTRA, MTIME=0, XFL=0, OS=255
    block[0] = 0x1f; block[1] = 0x8b; block[2] = 0x08; block[3] = 0x04;
    block.writeUInt32LE(0, 4);
    block[8] = 0x00; block[9] = 0xff;
    block.writeUInt16LE(6, 10);            // XLEN
    block[12] = 0x42; block[13] = 0x43;    // 'B' 'C'
    block.writeUInt16LE(2, 14);            // SLEN
    block.writeUInt16LE(total - 1, 16);    // BSIZE
    deflated.copy(block, 18);
    block.writeUInt32LE(zlib.crc32(uncompressed) >>> 0, 18 + deflated.length);
    block.writeUInt32LE(uncompressed.length >>> 0, 18 + deflated.length + 4);
    return block;
}

/**
 * Inflate the BGZF block that starts at `offset` in `buf`.
 * @returns {{ data: Buffer, compressedSize: number }} — `compressedSize` is the
 *   full member length, i.e. the next block starts at offset + compressedSize.
 */
function readBlock(buf, offset = 0) {
    if (!Buffer.isBuffer(buf) || buf.length < offset + 18) {
        throw new Error('bgzf.readBlock: truncated block header');
    }
    if (buf[offset] !== 0x1f || buf[offset + 1] !== 0x8b || buf[offset + 2] !== 0x08) {
        throw new Error('bgzf.readBlock: not a gzip member');
    }
    if ((buf[offset + 3] & 0x04) === 0) {
        throw new Error('bgzf.readBlock: gzip member without FEXTRA is not BGZF');
    }
    const xlen = buf.readUInt16LE(offset + 10);
    if (buf.length < offset + 12 + xlen) throw new Error('bgzf.readBlock: truncated extra field');
    // Scan the extra subfields for BC/2 — BGZF requires it but tolerates others.
    let bsize = null;
    let p = offset + 12;
    const extraEnd = offset + 12 + xlen;
    while (p + 4 <= extraEnd) {
        const si1 = buf[p], si2 = buf[p + 1];
        const slen = buf.readUInt16LE(p + 2);
        if (si1 === 0x42 && si2 === 0x43 && slen === 2) {
            bsize = buf.readUInt16LE(p + 4);
            break;
        }
        p += 4 + slen;
    }
    if (bsize === null) throw new Error('bgzf.readBlock: no BC subfield — not BGZF');
    const compressedSize = bsize + 1;
    if (buf.length < offset + compressedSize) throw new Error('bgzf.readBlock: truncated block body');
    const deflated = buf.subarray(offset + 12 + xlen, offset + compressedSize - 8);
    const isize = buf.readUInt32LE(offset + compressedSize - 4);
    const data = zlib.inflateRawSync(deflated);
    if (data.length !== isize) {
        throw new Error(`bgzf.readBlock: ISIZE mismatch (${data.length} != ${isize})`);
    }
    return { data, compressedSize };
}

module.exports = { writeBlock, readBlock, EOF_BLOCK, MAX_BLOCK_INPUT };
