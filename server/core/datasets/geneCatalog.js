/**
 * core/datasets — gene symbol → genomic span, per reference build.
 *
 * Answers "where is BRCA1" so a dataset query can be asked by gene name. The
 * data files are GENERATED from UCSC refGene by server/scripts/
 * build-gene-catalog.js (regenerate there, never hand-edit); one gzipped TSV
 * per build, ~28 K genes each, lazy-loaded on first use and kept for the
 * process lifetime (~a few MB per build — cheap next to one query's blocks).
 *
 * Coordinates are 1-based inclusive, chromosome names UCSC-style ("chr17").
 * The QUERY layer normalizes against the dataset's own contig spelling
 * ("17" vs "chr17") — this module stays file-agnostic.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, 'data');
const BUILDS = ['GRCh37', 'GRCh38'];

const catalogs = new Map(); // build -> Map<SYMBOL, {chrom, start, end}>

function loadBuild(build) {
    const file = path.join(DATA_DIR, `geneCoords.${build}.tsv.gz`);
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const map = new Map();
    for (const line of text.split('\n')) {
        if (!line) continue;
        const [symbol, chrom, start, end] = line.split('\t');
        map.set(symbol, { chrom, start: Number(start), end: Number(end) });
    }
    return map;
}

/** @returns {'GRCh37'|'GRCh38'|null} normalized build name, or null. */
function normalizeBuild(build) {
    const b = String(build || '').toLowerCase();
    if (b === 'grch38' || b === 'hg38') return 'GRCh38';
    if (b === 'grch37' || b === 'hg19' || b === 'b37') return 'GRCh37';
    return null;
}

/**
 * @param {string} symbol — case-insensitive gene symbol ("brca1")
 * @param {string} build — 'GRCh37' | 'GRCh38' (or an alias normalizeBuild takes)
 * @returns {{chrom:string, start:number, end:number}|null}
 */
function resolveGene(symbol, build) {
    const b = normalizeBuild(build);
    if (!b || !symbol) return null;
    if (!catalogs.has(b)) catalogs.set(b, loadBuild(b));
    return catalogs.get(b).get(String(symbol).trim().toUpperCase()) || null;
}

module.exports = { resolveGene, normalizeBuild, BUILDS };
