/**
 * core/datasets — VCF parsing.
 * Run: cd server && node --test core/datasets/vcfParser.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseHeader, parseDataLine, parseGenotypes, parseInfoFields, rsNumberOf } = require('./vcfParser');

const HEADER_38 = [
    '##fileformat=VCFv4.2',
    '##reference=file:///refs/GRCh38.fa',
    '##contig=<ID=chr1,length=248956422,assembly=GRCh38>',
    '##contig=<ID=chr17,length=83257441>',
    '##INFO=<ID=AF,Number=A,Type=Float,Description="Allele frequency, comma-separated">',
    '##INFO=<ID=DB,Number=0,Type=Flag,Description="dbSNP membership">',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878\tNA12891',
].join('\n');

test('parseHeader: contigs, samples, INFO keys, explicit build', () => {
    const h = parseHeader(HEADER_38);
    assert.deepStrictEqual(h.contigs, [
        { id: 'chr1', length: 248956422 },
        { id: 'chr17', length: 83257441 },
    ]);
    assert.deepStrictEqual(h.samples, ['NA12878', 'NA12891']);
    assert.deepStrictEqual(h.infoKeys, ['AF', 'DB']);
    assert.strictEqual(h.build, 'GRCh38');
});

test('parseHeader: build from chr1 length when ##reference is silent', () => {
    const h = parseHeader([
        '##fileformat=VCFv4.2',
        '##contig=<ID=1,length=249250621>',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    ].join('\n'));
    assert.strictEqual(h.build, 'GRCh37');
    assert.deepStrictEqual(h.samples, [], 'no FORMAT column = no samples');
});

test('parseHeader: unknown build stays null — never guessed', () => {
    const h = parseHeader([
        '##fileformat=VCFv4.2',
        '##contig=<ID=ctgA,length=5000>',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    ].join('\n'));
    assert.strictEqual(h.build, null);
});

test('parseHeader: refusals carry the reason', () => {
    assert.throws(() => parseHeader('not a vcf at all'), /##fileformat=VCF/);
    assert.throws(() => parseHeader('##fileformat=VCFv4.2\n##contig=<ID=1>'), /#CHROM/);
    assert.throws(
        () => parseHeader('##fileformat=VCFv4.2\n#CHROM\tPOS\tREF'),
        /expected column ID/,
    );
});

test('parseHeader: quoted commas inside meta values do not split fields', () => {
    const h = parseHeader([
        '##fileformat=VCFv4.2',
        '##INFO=<ID=CSQ,Number=.,Type=String,Description="Consequence, from VEP">',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    ].join('\n'));
    assert.deepStrictEqual(h.infoKeys, ['CSQ']);
});

test('parseDataLine: fixed columns, "." QUAL → null', () => {
    const p = parseDataLine('chr17\t43044295\trs80357713\tA\tG\t312.5\tPASS\tAF=0.02;DB\tGT\t0/1\t0/0');
    assert.strictEqual(p.chrom, 'chr17');
    assert.strictEqual(p.pos, 43044295);
    assert.strictEqual(p.id, 'rs80357713');
    assert.strictEqual(p.qual, 312.5);
    assert.strictEqual(p.filter, 'PASS');
    const q = parseDataLine('1\t100\t.\tT\tC\t.\t.\t.');
    assert.strictEqual(q.qual, null);
});

test('parseDataLine: malformed lines are refused with specifics', () => {
    assert.throws(() => parseDataLine('chr1\t100\tonly-three'), /3 columns/);
    assert.throws(() => parseDataLine('chr1\tnotanumber\t.\tA\tG\t.\t.\t.'), /POS/);
    assert.throws(() => parseDataLine('\t100\t.\tA\tG\t.\t.\t.'), /CHROM is empty/);
});

test('parseGenotypes: lazy, keyed to the header sample list', () => {
    const p = parseDataLine('chr1\t100\t.\tA\tG\t50\tPASS\t.\tGT:DP\t0/1:30\t1/1:12');
    const g = parseGenotypes(p, ['S1', 'S2']);
    assert.strictEqual(g.format, 'GT:DP');
    assert.deepStrictEqual(g.samples, [
        { sample: 'S1', value: '0/1:30' },
        { sample: 'S2', value: '1/1:12' },
    ]);
    const noSamples = parseDataLine('chr1\t100\t.\tA\tG\t50\tPASS\t.');
    assert.deepStrictEqual(parseGenotypes(noSamples, []), { format: null, samples: [] });
});

test('parseInfoFields: projection and flags', () => {
    assert.deepStrictEqual(parseInfoFields('AF=0.01;DP=30;DB', ['AF', 'DB']), { AF: '0.01', DB: true });
    assert.deepStrictEqual(parseInfoFields('AF=0.01;DP=30', null), { AF: '0.01', DP: '30' });
    assert.deepStrictEqual(parseInfoFields('.', null), {});
});

test('rsNumberOf: strict rs ids only', () => {
    assert.strictEqual(rsNumberOf('rs548049170'), 548049170);
    assert.strictEqual(rsNumberOf('rs0'), 0);
    assert.strictEqual(rsNumberOf('.'), null);
    assert.strictEqual(rsNumberOf('rs12;rs13'), null, 'multi-id fields are not indexable');
    assert.strictEqual(rsNumberOf('RS42'), null, 'case-sensitive by the dbSNP convention');
});
