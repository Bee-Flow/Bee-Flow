/**
 * core/datasets — rsID → position index, 64 shards.
 *
 * "Show my rs548049170" cannot ride the block index: rs numbers have no
 * relation to coordinates. A full rsID→pos map for a WGS file is ~5 M records;
 * as ONE object it would be an ~80 MB download per lookup. Sharded by
 * rsNum % 64 a lookup fetches one shard (~1.25 MB average) and binary-searches
 * it — cheap enough to do per query without a cache.
 *
 * Shard format: records of 16 bytes, sorted by rsNum ascending:
 *   uint64 rsNum | uint32 contigIdx | uint32 pos
 * `contigIdx` indexes the manifest's contig list (names vary per file — "chr1"
 * vs "1" — so records store the index, and the caller resolves the name).
 * Duplicate rsNums are legal (multi-allelic sites split across lines); lookup
 * returns every match.
 */

const SHARD_COUNT = 64;
const RECORD_BYTES = 16;

function shardOf(rsNum) {
    if (!Number.isSafeInteger(rsNum) || rsNum < 0) throw new Error('rsidIndex.shardOf: non-negative integer required');
    return rsNum % SHARD_COUNT;
}

/** Two-digit shard label — matches the 'rsid/NN.bin' storage artifact names. */
function shardName(shard) {
    if (!Number.isInteger(shard) || shard < 0 || shard >= SHARD_COUNT) throw new Error(`rsidIndex.shardName: 0..${SHARD_COUNT - 1}`);
    return String(shard).padStart(2, '0');
}

/**
 * @param {Array<{rsNum:number, contigIdx:number, pos:number}>} records — any order.
 * @returns {Buffer}
 */
function serializeShard(records) {
    const sorted = [...records].sort((a, b) => a.rsNum - b.rsNum);
    const buf = Buffer.alloc(sorted.length * RECORD_BYTES);
    let p = 0;
    for (const r of sorted) {
        buf.writeBigUInt64LE(BigInt(r.rsNum), p);
        buf.writeUInt32LE(r.contigIdx >>> 0, p + 8);
        buf.writeUInt32LE(r.pos >>> 0, p + 12);
        p += RECORD_BYTES;
    }
    return buf;
}

/**
 * Every record for one rs number. @returns {Array<{contigIdx:number, pos:number}>}
 */
function lookupShard(shardBuf, rsNum) {
    if (!Buffer.isBuffer(shardBuf) || shardBuf.length % RECORD_BYTES !== 0) {
        throw new Error('rsidIndex.lookupShard: malformed shard');
    }
    const n = shardBuf.length / RECORD_BYTES;
    const target = BigInt(rsNum);
    const at = (i) => shardBuf.readBigUInt64LE(i * RECORD_BYTES);
    // Binary search for ANY match, then widen to neighbours with the same rsNum.
    let lo = 0, hi = n - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = at(mid);
        if (v === target) { found = mid; break; }
        if (v < target) lo = mid + 1;
        else hi = mid - 1;
    }
    if (found === -1) return [];
    let first = found;
    while (first > 0 && at(first - 1) === target) first--;
    const out = [];
    for (let i = first; i < n && at(i) === target; i++) {
        out.push({
            contigIdx: shardBuf.readUInt32LE(i * RECORD_BYTES + 8),
            pos: shardBuf.readUInt32LE(i * RECORD_BYTES + 12),
        });
    }
    return out;
}

module.exports = { SHARD_COUNT, RECORD_BYTES, shardOf, shardName, serializeShard, lookupShard };
