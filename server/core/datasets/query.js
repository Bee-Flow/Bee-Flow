/**
 * core/datasets — bounded slice queries over an ingested dataset.
 *
 * The contract that makes AI access safe: a query NEVER returns more than
 * `limit` rows or ~`charBudget` characters, no matter how big the file is —
 * the model pulls slices, the platform meters them. Truncation is always
 * SAID (`truncated: true` + a note), never silent: a silently clipped result
 * reads as "that region is empty", which for genome data is a lie with
 * consequences.
 *
 * I/O is injected so this module knows nothing about storage or manifests:
 *   dataset = {
 *     build:        'GRCh37' | 'GRCh38' | null,
 *     samples:      string[],
 *     loadIndex:    async () => deserialized block index (caller caches),
 *     readRange:    async (startOffset, endOffsetExclusive) => Buffer,
 *     readRsidShard:async (shard) => Buffer | null   (null = shard absent)
 *   }
 */

const bgzf = require('./bgzf');
const { findRange } = require('./blockIndex');
const { resolveGene } = require('./geneCatalog');
const { parseDataLine, parseGenotypes, parseInfoFields, rsNumberOf } = require('./vcfParser');
const rsidIndex = require('./rsidIndex');

const MAX_REGION_BP = Number(process.env.DATASET_MAX_REGION_BP) > 0
    ? Number(process.env.DATASET_MAX_REGION_BP) : 5_000_000;
const MAX_BLOCKS_PER_QUERY = 256;   // ×64 KB compressed ≈ 16 MB ceiling per query
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_CHAR_BUDGET = 32_000;

class DatasetQueryError extends Error {
    constructor(message, code = 'dataset_query_invalid') {
        super(message);
        this.name = 'DatasetQueryError';
        this.code = code;
    }
}

/** "chr17:43,044,295-43,125,364" | "17:100-200" | "chrX:1234" → {chrom,start,end} */
function parseRegionString(region) {
    const m = /^\s*([\w.]+)\s*:\s*([\d,]+)\s*(?:-\s*([\d,]+))?\s*$/.exec(String(region || ''));
    if (!m) throw new DatasetQueryError(`unreadable region "${region}" — expected chrom:start-end`);
    const start = Number.parseInt(m[2].replace(/,/g, ''), 10);
    const end = m[3] ? Number.parseInt(m[3].replace(/,/g, ''), 10) : start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        throw new DatasetQueryError(`invalid region span ${start}-${end}`);
    }
    return { chrom: m[1], start, end };
}

/** The file's own spelling of a chromosome ("chr17" vs "17" vs "MT"). */
function normalizeContig(requested, index) {
    const cands = [requested];
    if (requested.startsWith('chr')) cands.push(requested.slice(3));
    else cands.push(`chr${requested}`);
    if (requested === 'chrM' || requested === 'M') cands.push('MT', 'chrMT');
    if (requested === 'MT') cands.push('chrM', 'M');
    for (const c of cands) if (index.byName.has(c)) return c;
    return null;
}

function scanWindow(bytes, contigName, start, end, opts) {
    const { filterPass, minQual, limit, includeGenotypes, charBudget, samples } = opts;
    const payloads = [];
    let off = 0;
    while (off < bytes.length) {
        const { data, compressedSize } = bgzf.readBlock(bytes, off);
        payloads.push(data);
        off += compressedSize;
    }
    const text = Buffer.concat(payloads).toString('utf8');

    const rows = [];
    let matched = 0;
    let chars = 0;
    let budgetHit = false;
    let lineStart = 0;
    while (lineStart < text.length) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1) lineEnd = text.length;
        const line = text.slice(lineStart, lineEnd);
        lineStart = lineEnd + 1;
        if (!line || line[0] === '#') continue;

        let parsed;
        try { parsed = parseDataLine(line); } catch { continue; } // validated at ingest; tolerate here
        if (parsed.chrom !== contigName) continue;
        if (parsed.pos < start) continue;
        if (parsed.pos > end) break; // rows are sorted — nothing further can match
        if (filterPass && parsed.filter !== 'PASS') continue;
        if (minQual != null && !(parsed.qual !== null && parsed.qual >= minQual)) continue;

        matched++;
        if (rows.length >= limit || budgetHit) continue; // keep counting, stop collecting

        const row = {
            chrom: parsed.chrom,
            pos: parsed.pos,
            id: parsed.id === '.' ? null : parsed.id,
            ref: parsed.ref,
            alt: parsed.alt,
            qual: parsed.qual,
            filter: parsed.filter,
            info: parseInfoFields(parsed.info, null),
        };
        if (includeGenotypes) {
            const g = parseGenotypes(parsed, samples);
            if (g.format) row.gt = { format: g.format, samples: g.samples };
        }
        const cost = JSON.stringify(row).length;
        if (chars + cost > charBudget && rows.length > 0) {
            budgetHit = true;
            continue;
        }
        chars += cost;
        rows.push(row);
    }
    return { rows, matched, budgetHit };
}

/**
 * @param {object} dataset — see module header
 * @param {object} params — { gene | region | rsid | (chrom,start,end), filterPass,
 *   minQual, limit, includeGenotypes, charBudget }
 * @returns {Promise<{rows, rowCount, truncated, notes, region, gene, rsid, build, scannedBlocks}>}
 */
async function queryRegion(dataset, params = {}) {
    const { gene, rsid } = params;
    const hasRegion = params.region != null || (params.chrom != null && params.start != null && params.end != null);
    const selectors = [gene != null, hasRegion, rsid != null].filter(Boolean).length;
    if (selectors !== 1) {
        throw new DatasetQueryError('exactly one of gene, region or rsid must be given');
    }

    const limit = Math.max(1, Math.min(MAX_LIMIT, Number(params.limit) || DEFAULT_LIMIT));
    const charBudget = Math.max(1_000, Math.min(200_000, Number(params.charBudget) || DEFAULT_CHAR_BUDGET));
    const scanOpts = {
        filterPass: params.filterPass === true,
        minQual: params.minQual != null ? Number(params.minQual) : null,
        limit,
        includeGenotypes: params.includeGenotypes === true,
        charBudget,
        samples: dataset.samples || [],
    };

    const index = await dataset.loadIndex();
    const notes = [];

    // ── Resolve the selector to one or more spans ─────────────────────────────
    let spans; // [{chrom (requested spelling), start, end}]
    let resolvedGene = null;
    let resolvedRsid = null;

    if (gene != null) {
        if (!dataset.build) {
            throw new DatasetQueryError(
                'this file does not declare its reference build, so gene names cannot be located — query by region (chrom:start-end) instead',
                'dataset_build_unknown',
            );
        }
        const loc = resolveGene(gene, dataset.build);
        if (!loc) throw new DatasetQueryError(`unknown gene symbol "${gene}" (build ${dataset.build})`, 'dataset_gene_unknown');
        resolvedGene = { symbol: String(gene).toUpperCase(), ...loc };
        spans = [loc];
    } else if (rsid != null) {
        const rsNum = typeof rsid === 'number' ? rsid : rsNumberOf(String(rsid).trim());
        if (rsNum === null) throw new DatasetQueryError(`unreadable rsID "${rsid}" — expected rs<number>`);
        resolvedRsid = `rs${rsNum}`;
        const shard = await dataset.readRsidShard(rsidIndex.shardOf(rsNum));
        if (shard === null) {
            throw new DatasetQueryError('this dataset has no rsID index — query by gene or region instead', 'dataset_rsid_index_missing');
        }
        const hits = rsidIndex.lookupShard(shard, rsNum);
        if (hits.length === 0) {
            return {
                rows: [], rowCount: 0, truncated: false, notes: [`${resolvedRsid} is not present in this file`],
                region: null, gene: null, rsid: resolvedRsid, build: dataset.build || null, scannedBlocks: 0,
            };
        }
        spans = hits.map((h) => {
            const contig = index.contigs[h.contigIdx];
            if (!contig) throw new DatasetQueryError('rsID index references a contig the block index does not know', 'dataset_index_corrupt');
            return { chrom: contig.name, start: h.pos, end: h.pos };
        });
    } else {
        const r = params.region != null
            ? parseRegionString(params.region)
            : { chrom: String(params.chrom), start: Number(params.start), end: Number(params.end) };
        if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.end < r.start) {
            throw new DatasetQueryError(`invalid region span ${r.start}-${r.end}`);
        }
        spans = [r];
    }

    for (const s of spans) {
        if (s.end - s.start + 1 > MAX_REGION_BP) {
            throw new DatasetQueryError(
                `region spans ${(s.end - s.start + 1).toLocaleString('en-US')} bp — the ceiling is ${MAX_REGION_BP.toLocaleString('en-US')} bp per query; narrow the span`,
                'dataset_region_too_large',
            );
        }
    }

    // ── Read and scan each span (rsid can yield several tiny ones) ────────────
    const rows = [];
    let rowCount = 0;
    let truncated = false;
    let scannedBlocks = 0;
    let firstSpanRegion = null;

    for (const span of spans) {
        const contigName = normalizeContig(span.chrom, index);
        if (!firstSpanRegion) firstSpanRegion = { chrom: span.chrom, start: span.start, end: span.end };
        if (!contigName) {
            notes.push(`chromosome ${span.chrom} is not present in this file`);
            continue;
        }
        const range = findRange(index, contigName, span.start, span.end, { maxBlocks: MAX_BLOCKS_PER_QUERY });
        if (!range || range.empty) continue;
        if (range.truncated) {
            truncated = true;
            notes.push(`the read window was clamped at ${MAX_BLOCKS_PER_QUERY} blocks — results cover only the start of the span`);
        }
        scannedBlocks += range.blockCount;
        const bytes = await dataset.readRange(range.startOffset, range.endOffset);
        const scanned = scanWindow(bytes, contigName, span.start, span.end, {
            ...scanOpts,
            limit: Math.max(0, limit - rows.length) || 0,
        });
        rowCount += scanned.matched;
        rows.push(...scanned.rows);
        if (scanned.budgetHit) truncated = true;
    }

    if (rowCount > rows.length) {
        truncated = true;
        notes.push(`${rowCount.toLocaleString('en-US')} rows matched; the first ${rows.length} are returned — narrow the span or filters for the rest`);
    }

    return {
        rows,
        rowCount,
        truncated,
        notes,
        region: resolvedGene ? { chrom: resolvedGene.chrom, start: resolvedGene.start, end: resolvedGene.end } : firstSpanRegion,
        gene: resolvedGene ? resolvedGene.symbol : null,
        rsid: resolvedRsid,
        build: dataset.build || null,
        scannedBlocks,
    };
}

module.exports = { queryRegion, parseRegionString, normalizeContig, DatasetQueryError, MAX_REGION_BP, MAX_BLOCKS_PER_QUERY, MAX_LIMIT };
