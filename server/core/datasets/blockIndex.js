/**
 * core/datasets — the block index that makes a 30 GB file queryable.
 *
 * One entry per BGZF block of data.bgz: the block's byte offset, its
 * uncompressed size, and the position of its FIRST row. Rows are coordinate-
 * sorted (ingest enforces it), so "which blocks can contain chr17:43,044,295-
 * 43,125,364" is a binary search plus a short walk — the query layer then
 * range-reads exactly those bytes and inflates ~a dozen blocks instead of
 * thirty gigabytes.
 *
 * Serialized format 'BFDI1' (BeeFlow Dataset Index, v1):
 *   bytes 0-4   magic "BFDI1"
 *   bytes 5-8   uint32 LE — length of the JSON directory
 *   directory   JSON: { version, contentEnd, contigs: [{ name, entryStart,
 *               entryCount, minPos, maxPos, count }] }
 *               `contentEnd` = byte offset in data.bgz where the EOF marker
 *               starts (i.e. where the LAST content block ends). `count` is
 *               the contig's variant count (stats for the manifest/UI).
 *   entries     entryCount × 16 bytes, in FILE ORDER (== blockOffset order):
 *               uint32 firstPos | uint64 blockOffset | uint32 uncompSize
 *
 * Sizing: a 30 GB .bgz is ≤ ~500 K blocks → ≤ 8 MB of entries. Deserialize
 * keeps the raw entry buffer and reads it in place — half a million transient
 * objects per query would be pure GC pressure for nothing.
 */

const MAGIC = Buffer.from('BFDI1', 'ascii');
const ENTRY_BYTES = 16;

/**
 * @param {Array<{name:string, minPos:number, maxPos:number, count:number,
 *                entries: Array<{firstPos:number, blockOffset:number, uncompSize:number}>}>} perContig
 *        — in FILE order; each contig's entries pos-ascending (the ingest order).
 * @param {number} contentEnd — where content blocks end in data.bgz (EOF marker offset).
 * @returns {Buffer}
 */
function serialize(perContig, contentEnd) {
    if (!Array.isArray(perContig)) throw new Error('blockIndex.serialize: perContig array required');
    if (!Number.isSafeInteger(contentEnd) || contentEnd < 0) throw new Error('blockIndex.serialize: contentEnd required');
    const contigs = [];
    let entryStart = 0;
    let total = 0;
    for (const c of perContig) {
        contigs.push({
            name: c.name,
            entryStart,
            entryCount: c.entries.length,
            minPos: c.minPos,
            maxPos: c.maxPos,
            count: c.count,
        });
        entryStart += c.entries.length;
        total += c.entries.length;
    }
    const dir = Buffer.from(JSON.stringify({ version: 1, contentEnd, contigs }), 'utf8');
    const out = Buffer.alloc(MAGIC.length + 4 + dir.length + total * ENTRY_BYTES);
    MAGIC.copy(out, 0);
    out.writeUInt32LE(dir.length, MAGIC.length);
    dir.copy(out, MAGIC.length + 4);
    let p = MAGIC.length + 4 + dir.length;
    for (const c of perContig) {
        let prevPos = -1;
        let prevOffset = -1;
        for (const e of c.entries) {
            if (e.firstPos < prevPos) throw new Error(`blockIndex.serialize: ${c.name} entries not pos-sorted`);
            if (e.blockOffset <= prevOffset) throw new Error(`blockIndex.serialize: ${c.name} entries not offset-sorted`);
            prevPos = e.firstPos; prevOffset = e.blockOffset;
            out.writeUInt32LE(e.firstPos >>> 0, p);
            out.writeBigUInt64LE(BigInt(e.blockOffset), p + 4);
            out.writeUInt32LE(e.uncompSize >>> 0, p + 12);
            p += ENTRY_BYTES;
        }
    }
    return out;
}

/** @returns {{ contentEnd:number, contigs:Array, byName:Map, entryCount:number, ... }} */
function deserialize(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('blockIndex.deserialize: not a BFDI1 index');
    }
    const dirLen = buf.readUInt32LE(MAGIC.length);
    const dirStart = MAGIC.length + 4;
    if (buf.length < dirStart + dirLen) throw new Error('blockIndex.deserialize: truncated directory');
    let dir;
    try { dir = JSON.parse(buf.subarray(dirStart, dirStart + dirLen).toString('utf8')); }
    catch { throw new Error('blockIndex.deserialize: unreadable directory'); }
    if (dir.version !== 1 || !Array.isArray(dir.contigs)) throw new Error('blockIndex.deserialize: unknown directory shape');
    const entriesBuf = buf.subarray(dirStart + dirLen);
    const entryCount = Math.floor(entriesBuf.length / ENTRY_BYTES);
    const declared = dir.contigs.reduce((n, c) => n + c.entryCount, 0);
    if (declared !== entryCount) throw new Error(`blockIndex.deserialize: directory declares ${declared} entries, file has ${entryCount}`);
    const byName = new Map(dir.contigs.map((c) => [c.name, c]));
    const index = {
        contentEnd: dir.contentEnd,
        contigs: dir.contigs,
        byName,
        entryCount,
        firstPosAt: (i) => entriesBuf.readUInt32LE(i * ENTRY_BYTES),
        blockOffsetAt: (i) => Number(entriesBuf.readBigUInt64LE(i * ENTRY_BYTES + 4)),
        uncompSizeAt: (i) => entriesBuf.readUInt32LE(i * ENTRY_BYTES + 12),
    };
    return index;
}

/**
 * The byte window of data.bgz that can contain rows of `chrom` in [start, end].
 *
 * @returns {null | { empty:true } | { startOffset:number, endOffset:number,
 *   blockCount:number, truncated:boolean, startEntry:number }}
 *   null      → the contig is not in this file at all
 *   empty     → contig present, but no block can hold rows in the span
 *   otherwise → read [startOffset, endOffset) and filter rows by position;
 *               `truncated` means the span needed more than maxBlocks blocks
 *               and was clamped (the caller surfaces this — silent truncation
 *               reads as "that region is empty", which is a lie).
 */
function findRange(index, chrom, start, end, { maxBlocks = 256 } = {}) {
    const c = index.byName.get(chrom);
    if (!c) return null;
    if (c.entryCount === 0) return { empty: true };
    const lo0 = c.entryStart;
    const hi0 = c.entryStart + c.entryCount - 1;

    // Binary search: LAST entry with firstPos <= start (clamped to the first).
    let lo = lo0, hi = hi0, sIdx = lo0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (index.firstPosAt(mid) <= start) { sIdx = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    // The block BEFORE the first one whose firstPos exceeds `start` can still
    // hold in-range rows (they start mid-block); blocks whose firstPos exceeds
    // `end` cannot hold any (rows are sorted). Walk forward to the last usable.
    if (index.firstPosAt(sIdx) > end) return { empty: true };
    let lIdx = sIdx;
    while (lIdx + 1 <= hi0 && index.firstPosAt(lIdx + 1) <= end) lIdx++;

    let truncated = false;
    if (lIdx - sIdx + 1 > maxBlocks) {
        lIdx = sIdx + maxBlocks - 1;
        truncated = true;
    }
    const startOffset = index.blockOffsetAt(sIdx);
    const endOffset = lIdx + 1 < index.entryCount ? index.blockOffsetAt(lIdx + 1) : index.contentEnd;
    return { startOffset, endOffset, blockCount: lIdx - sIdx + 1, truncated, startEntry: sIdx };
}

module.exports = { serialize, deserialize, findRange, ENTRY_BYTES };
