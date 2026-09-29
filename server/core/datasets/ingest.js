/**
 * core/datasets — streaming VCF ingest: raw upload → data.bgz + block index
 * entries + rsID records. Constant memory regardless of file size; a 30 GB
 * WGS file flows through here without ever being whole in RAM.
 *
 * Invariants this module owes the query layer:
 *   1. Every INDEXED block starts at a line boundary — so inflating any
 *      indexed range yields complete lines.
 *   2. A block never spans two contigs — so one index entry's contig is
 *      unambiguous.
 *   3. A line longer than one block (deep multi-sample rows) spans
 *      CONTINUATION blocks that get NO index entry; the read window formula
 *      (next indexed entry's offset) therefore always covers them.
 *   4. Rows are coordinate-sorted per contig and contigs never repeat —
 *      validated here, at ingest, with a line number. Unsorted input is a
 *      hard failure: the whole index design assumes sorted rows, and
 *      "accepted but queries lie" is the one outcome that must never happen.
 *
 * The sink owns ALL I/O (the job wires it to multipart storage uploads):
 *   sink.write(buffer)            → Promise<number> byte offset it landed at
 *   sink.writeRsid(shard, record) → void|Promise  ({rsNum, contigIdx, pos})
 */

const zlib = require('zlib');
const { Transform } = require('stream');
const bgzf = require('./bgzf');
const { parseHeader, parseDataLine, rsNumberOf } = require('./vcfParser');
const { shardOf } = require('./rsidIndex');

// A data line larger than this is not a VCF row, it is a malfunction (even
// dense multi-sample WGS rows sit far below 4 MB) — refuse instead of
// buffering without bound.
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 2_000;

class IngestError extends Error {
    constructor(message, lineNumber = null) {
        super(lineNumber ? `${message} (line ${lineNumber})` : message);
        this.name = 'IngestError';
        this.lineNumber = lineNumber;
    }
}

/**
 * @param {object} opts
 * @param {import('stream').Readable} opts.input — the raw upload bytes
 * @param {boolean} opts.gzip — input is gzip-compressed (.vcf.gz; bgzf included)
 * @param {object} opts.sink — see module header
 * @param {number} [opts.totalBytes] — declared raw size, for progress pct
 * @param {function} [opts.onProgress] — ({pct, variantCount, bytesRead}), ≤1/2 s
 * @returns {Promise<{ stats: {variantCount:number, blockCount:number, samples:string[],
 *   build:string|null, contigs:Array<{name:string,count:number,minPos:number,maxPos:number}>},
 *   headerText: string, perContig: Array, contentEnd: number }>}
 */
async function ingestVcf({ input, gzip, sink, totalBytes = null, onProgress = null }) {
    let bytesRead = 0;
    const counter = new Transform({
        transform(chunk, _enc, cb) { bytesRead += chunk.length; cb(null, chunk); },
    });

    let lineNumber = 0;
    let header = null;
    const headerLines = [];

    // Block assembly state (invariants 1–3).
    const pending = [];          // line buffers waiting to be flushed as one block
    let pendingBytes = 0;
    let pendingFirstPos = null;  // POS of the first row in `pending`
    let blockCount = 0;

    // Per-contig accumulation (invariant 2 & 4).
    const perContig = [];        // [{name, minPos, maxPos, count, entries:[…]}]
    const contigIdxByName = new Map();
    let current = null;          // the contig being written
    let lastPos = -1;

    let variantCount = 0;
    let lastProgressAt = 0;

    const emitProgress = (force = false) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        const pct = totalBytes ? Math.min(99, Math.floor((bytesRead / totalBytes) * 100)) : null;
        try { onProgress({ pct, variantCount, bytesRead }); } catch { /* progress must never kill an ingest */ }
    };

    async function flushPending() {
        if (pendingBytes === 0) return;
        const payload = Buffer.concat(pending, pendingBytes);
        pending.length = 0;
        pendingBytes = 0;
        const block = bgzf.writeBlock(payload);
        const offset = await sink.write(block);
        blockCount++;
        if (pendingFirstPos !== null) {
            current.entries.push({ firstPos: pendingFirstPos, blockOffset: offset, uncompSize: payload.length });
        }
        pendingFirstPos = null;
    }

    // A header chunk or an oversized line: written as blocks WITHOUT entries
    // (header) or with an entry on the FIRST chunk only (long row — invariant 3).
    async function writeSpanning(buf, firstPos = null) {
        await flushPending();
        for (let o = 0; o < buf.length; o += bgzf.MAX_BLOCK_INPUT) {
            const chunk = buf.subarray(o, Math.min(o + bgzf.MAX_BLOCK_INPUT, buf.length));
            const block = bgzf.writeBlock(chunk);
            const offset = await sink.write(block);
            blockCount++;
            if (firstPos !== null && o === 0) {
                current.entries.push({ firstPos, blockOffset: offset, uncompSize: chunk.length });
            }
        }
    }

    async function handleDataLine(lineBuf) {
        if (!header) {
            if (headerLines.length === 0) throw new IngestError('not a VCF: the file starts with a data line', lineNumber);
            throw new IngestError('data line before the #CHROM column line', lineNumber);
        }
        let parsed;
        try {
            parsed = parseDataLine(lineBuf.toString('utf8'));
        } catch (e) {
            throw new IngestError(`malformed VCF row: ${e.message}`, lineNumber);
        }

        // Contig transitions (invariants 2 & 4).
        if (!current || current.name !== parsed.chrom) {
            if (contigIdxByName.has(parsed.chrom)) {
                throw new IngestError(`VCF must be coordinate-sorted: contig ${parsed.chrom} appears twice`, lineNumber);
            }
            await flushPending();
            current = { name: parsed.chrom, minPos: parsed.pos, maxPos: parsed.pos, count: 0, entries: [] };
            contigIdxByName.set(parsed.chrom, perContig.length);
            perContig.push(current);
            lastPos = -1;
        }
        if (parsed.pos < lastPos) {
            throw new IngestError(`VCF must be coordinate-sorted: ${parsed.chrom}:${parsed.pos} after ${parsed.chrom}:${lastPos}`, lineNumber);
        }
        lastPos = parsed.pos;
        current.count++;
        current.minPos = Math.min(current.minPos, parsed.pos);
        current.maxPos = Math.max(current.maxPos, parsed.pos);
        variantCount++;

        const rsNum = rsNumberOf(parsed.id);
        if (rsNum !== null) {
            await sink.writeRsid(shardOf(rsNum), { rsNum, contigIdx: contigIdxByName.get(parsed.chrom), pos: parsed.pos });
        }

        const withNewline = Buffer.concat([lineBuf, Buffer.from('\n')]);
        if (withNewline.length > bgzf.MAX_BLOCK_INPUT) {
            await writeSpanning(withNewline, parsed.pos);
        } else {
            if (pendingBytes + withNewline.length > bgzf.MAX_BLOCK_INPUT) await flushPending();
            if (pendingFirstPos === null) pendingFirstPos = parsed.pos;
            pending.push(withNewline);
            pendingBytes += withNewline.length;
        }
        emitProgress();
    }

    async function handleLine(lineBuf) {
        lineNumber++;
        if (lineBuf.length === 0) return; // tolerate blank lines (trailing newline etc.)
        if (lineBuf[0] === 0x23 /* '#' */) {
            if (header) throw new IngestError('header line after data rows — not a valid VCF', lineNumber);
            headerLines.push(lineBuf.toString('utf8'));
            if (lineBuf.subarray(0, 6).toString('utf8') === '#CHROM') {
                try {
                    header = parseHeader(headerLines.join('\n'));
                } catch (e) {
                    throw new IngestError(e.message, lineNumber);
                }
                // The artifact stays a complete, tool-readable VCF: the header
                // is written as its own (unindexed) blocks before any data.
                await writeSpanning(Buffer.from(header.headerText + '\n', 'utf8'));
            }
            return;
        }
        await handleDataLine(lineBuf);
    }

    // ── Drive the stream: count bytes, optionally gunzip, split lines ─────────
    const stages = [input, counter];
    if (gzip) {
        // Multi-member tolerant: .vcf.gz written by bgzip IS a member sequence.
        stages.push(zlib.createGunzip());
    }
    let carry = Buffer.alloc(0);
    const source = stages.reduce((up, down) => up.pipe(down));

    try {
        for await (const chunk of source) {
            let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
            let start = 0;
            for (;;) {
                const nl = buf.indexOf(0x0a, start);
                if (nl === -1) break;
                let end = nl;
                if (end > start && buf[end - 1] === 0x0d) end--; // \r\n
                await handleLine(buf.subarray(start, end));
                start = nl + 1;
            }
            carry = buf.subarray(start);
            if (carry.length > MAX_LINE_BYTES) {
                throw new IngestError(`a single line exceeds ${MAX_LINE_BYTES} bytes — not a VCF row`, lineNumber + 1);
            }
        }
    } catch (e) {
        if (e instanceof IngestError) throw e;
        // zlib errors on truncated/corrupt gzip land here with a useful code.
        throw new IngestError(`could not read the file: ${e.message}`);
    }
    if (carry.length > 0) {
        let end = carry.length;
        if (carry[end - 1] === 0x0d) end--;
        await handleLine(carry.subarray(0, end));
    }

    if (!header) throw new IngestError('not a VCF: no #CHROM column line found');
    if (variantCount === 0) throw new IngestError('the VCF has a header but no data rows — nothing to index');

    await flushPending();
    // contentEnd = where content blocks stop = where the EOF marker begins.
    const contentEnd = await sink.write(bgzf.EOF_BLOCK);
    emitProgress(true);

    return {
        stats: {
            variantCount,
            blockCount,
            samples: header.samples,
            build: header.build,
            contigs: perContig.map(({ name, count, minPos, maxPos }) => ({ name, count, minPos, maxPos })),
        },
        headerText: header.headerText,
        perContig,
        contentEnd,
    };
}

module.exports = { ingestVcf, IngestError, MAX_LINE_BYTES };
