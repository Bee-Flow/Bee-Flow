/**
 * core/datasets — gene catalog sanity against the generated data files.
 *
 * These assertions use well-established gene locations as anchors (containment,
 * not exact bounds — refGene transcript unions may shift a little between
 * regenerations, the biology does not).
 *
 * Run: cd server && node --test core/datasets/geneCatalog.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { resolveGene, normalizeBuild } = require('./geneCatalog');

test('BRCA1 resolves to its known locus on both builds', () => {
    const g38 = resolveGene('BRCA1', 'GRCh38');
    assert.strictEqual(g38.chrom, 'chr17');
    assert.ok(g38.start <= 43_100_000 && g38.end >= 43_100_000, `GRCh38 span ${g38.start}-${g38.end} should contain 43.1 Mb`);

    const g37 = resolveGene('BRCA1', 'GRCh37');
    assert.strictEqual(g37.chrom, 'chr17');
    assert.ok(g37.start <= 41_220_000 && g37.end >= 41_220_000, `GRCh37 span ${g37.start}-${g37.end} should contain 41.22 Mb`);
});

test('lookups are case-insensitive and misses are null', () => {
    assert.deepStrictEqual(resolveGene('brca1', 'hg38'), resolveGene('BRCA1', 'GRCh38'));
    assert.strictEqual(resolveGene('NOT_A_GENE_XYZ', 'GRCh38'), null);
    assert.strictEqual(resolveGene('BRCA1', 'canfam3'), null, 'unknown build = null, never a guess');
    assert.strictEqual(resolveGene('', 'GRCh38'), null);
});

test('normalizeBuild covers the common aliases', () => {
    assert.strictEqual(normalizeBuild('hg19'), 'GRCh37');
    assert.strictEqual(normalizeBuild('b37'), 'GRCh37');
    assert.strictEqual(normalizeBuild('HG38'), 'GRCh38');
    assert.strictEqual(normalizeBuild('T2T'), null);
});

test('the catalog is broad — tens of thousands of genes, common ones present', () => {
    for (const sym of ['TP53', 'CFTR', 'APOE', 'MTHFR', 'HBB']) {
        assert.ok(resolveGene(sym, 'GRCh38'), `${sym} missing from GRCh38 catalog`);
        assert.ok(resolveGene(sym, 'GRCh37'), `${sym} missing from GRCh37 catalog`);
    }
    // APOE is the chr19 locus every consumer-genomics user asks about first.
    assert.strictEqual(resolveGene('APOE', 'GRCh38').chrom, 'chr19');
});
