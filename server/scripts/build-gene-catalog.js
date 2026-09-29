#!/usr/bin/env node
/**
 * Regenerate core/datasets/data/geneCoords.<build>.tsv.gz from UCSC refGene.
 *
 * The gene catalog answers "where is BRCA1" for dataset queries by gene name.
 * The checked-in TSVs are GENERATED artifacts — never hand-edit them; rerun
 * this script instead:
 *
 *   cd server && node scripts/build-gene-catalog.js
 *
 * Source: UCSC refGene (NCBI RefSeq curated transcripts), public download
 * server, one file per assembly. Aggregation: per (symbol, chromosome) the
 * union of all transcript spans; a symbol that appears on several chromosomes
 * keeps the chromosome with the most transcripts (ties → widest span) —
 * pseudoautosomal genes therefore resolve to one primary location, which is
 * the right behaviour for "show my BRCA1 variants". Non-canonical contigs
 * (alt/fix/hap/random) are dropped. Output positions are 1-BASED inclusive
 * (VCF's convention; refGene txStart is 0-based).
 *
 * Output line format:  SYMBOL \t chrom \t start \t end
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SOURCES = {
    GRCh38: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/refGene.txt.gz',
    GRCh37: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg19/database/refGene.txt.gz',
};
const OUT_DIR = path.resolve(__dirname, '..', 'core', 'datasets', 'data');
const CANONICAL = new Set([
    ...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`),
    'chrX', 'chrY', 'chrM',
]);

async function build(buildName, url) {
    console.log(`[gene-catalog] ${buildName}: downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${buildName}: download failed (${res.status})`);
    const gz = Buffer.from(await res.arrayBuffer());
    const text = zlib.gunzipSync(gz).toString('utf8');

    // Aggregate transcript spans per (symbol, chrom).
    const bySymbolChrom = new Map(); // 'SYMBOL\tchrom' -> {chrom, start0, end, transcripts}
    let rows = 0;
    for (const line of text.split('\n')) {
        if (!line) continue;
        const c = line.split('\t');
        // refGene columns: 0 bin, 1 name, 2 chrom, 3 strand, 4 txStart, 5 txEnd, … 12 name2
        const chrom = c[2];
        const symbol = (c[12] || '').trim();
        if (!symbol || !CANONICAL.has(chrom)) continue;
        const txStart = Number.parseInt(c[4], 10);
        const txEnd = Number.parseInt(c[5], 10);
        if (!Number.isFinite(txStart) || !Number.isFinite(txEnd)) continue;
        rows++;
        const key = `${symbol.toUpperCase()}\t${chrom}`;
        const cur = bySymbolChrom.get(key);
        if (cur) {
            cur.start0 = Math.min(cur.start0, txStart);
            cur.end = Math.max(cur.end, txEnd);
            cur.transcripts++;
        } else {
            bySymbolChrom.set(key, { symbol: symbol.toUpperCase(), chrom, start0: txStart, end: txEnd, transcripts: 1 });
        }
    }

    // One location per symbol: most transcripts wins, ties → widest span.
    const bySymbol = new Map();
    for (const e of bySymbolChrom.values()) {
        const cur = bySymbol.get(e.symbol);
        if (!cur
            || e.transcripts > cur.transcripts
            || (e.transcripts === cur.transcripts && (e.end - e.start0) > (cur.end - cur.start0))) {
            bySymbol.set(e.symbol, e);
        }
    }

    const lines = [...bySymbol.values()]
        .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
        .map((e) => `${e.symbol}\t${e.chrom}\t${e.start0 + 1}\t${e.end}`);
    const out = zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), { level: 9 });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, `geneCoords.${buildName}.tsv.gz`);
    fs.writeFileSync(outPath, out);
    console.log(`[gene-catalog] ${buildName}: ${rows} transcripts → ${bySymbol.size} genes → ${outPath} (${(out.length / 1024).toFixed(0)} KB)`);
}

(async () => {
    for (const [buildName, url] of Object.entries(SOURCES)) {
        await build(buildName, url);
    }
})().catch((err) => {
    console.error(`[gene-catalog] failed: ${err.message}`);
    process.exit(1);
});
