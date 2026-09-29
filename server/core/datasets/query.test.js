/**
 * core/datasets — end-to-end slice queries: ingest a synthetic VCF into memory,
 * serialize its index, and query it exactly the way the platform will (ranged
 * reads only — the "file" is never handed to the query whole).
 *
 * Run: cd server && node --test core/datasets/query.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { ingestVcf } = require('./ingest');
const blockIndex = require('./blockIndex');
const rsidIdx = require('./rsidIndex');
const { queryRegion, parseRegionString, DatasetQueryError } = require('./query');
const { resolveGene } = require('./geneCatalog');

// Contigs deliberately WITHOUT the chr prefix — the catalog says "chr17", the
// file says "17"; normalizeContig must bridge them.
function buildFixture({ withRsidIndex = true } = {}) {
    const brca1 = resolveGene('BRCA1', 'GRCh38');
    const lines = [
        '##fileformat=VCFv4.2',
        '##reference=GRCh38',
        '##contig=<ID=1,length=248956422>',
        '##contig=<ID=17,length=83257441>',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tME',
    ];
    // chr1: 3000 rows, every 10 bp from 1000 — spans several blocks.
    for (let i = 0; i < 3000; i++) {
        const pos = 1000 + i * 10;
        const filter = i % 5 === 0 ? 'LowQual' : 'PASS';
        const qual = 10 + (i % 90);
        const id = i === 1500 ? 'rs777' : '.';
        lines.push(`1\t${pos}\t${id}\tA\tG\t${qual}\t${filter}\tAF=0.${i % 10};DP=${i}\tGT\t0/1`);
    }
    // chr17: 50 rows inside BRCA1.
    const bStart = brca1.start + 100;
    for (let i = 0; i < 50; i++) {
        lines.push(`17\t${bStart + i * 20}\trs${1000 + i}\tC\tT\t80\tPASS\tGENE=BRCA1\tGT\t1/1`);
    }
    return (async () => {
        const sink = {
            chunks: [], offset: 0, rsidByShard: new Map(),
            async write(buf) { const o = sink.offset; sink.chunks.push(Buffer.from(buf)); sink.offset += buf.length; return o; },
            async writeRsid(shard, rec) {
                if (!sink.rsidByShard.has(shard)) sink.rsidByShard.set(shard, []);
                sink.rsidByShard.get(shard).push(rec);
            },
        };
        const result = await ingestVcf({ input: Readable.from([Buffer.from(lines.join('\n') + '\n')]), gzip: false, sink });
        const data = Buffer.concat(sink.chunks);
        const indexBuf = blockIndex.serialize(result.perContig, result.contentEnd);
        const shards = new Map([...sink.rsidByShard].map(([s, recs]) => [s, rsidIdx.serializeShard(recs)]));
        const index = blockIndex.deserialize(indexBuf);
        const reads = [];
        const dataset = {
            build: result.stats.build,
            samples: result.stats.samples,
            loadIndex: async () => index,
            readRange: async (s, e) => { reads.push({ s, e }); return data.subarray(s, e); },
            readRsidShard: async (shard) => (withRsidIndex ? (shards.get(shard) || rsidIdx.serializeShard([])) : null),
        };
        return { dataset, reads, data, brca1, bStart, stats: result.stats };
    })();
}

test('region query: exact bounds, sorted rows, and only a slice of the file is read', async () => {
    const { dataset, reads, data } = await buildFixture();
    const r = await queryRegion(dataset, { region: '1:10,000-11,000', limit: 200 });
    assert.strictEqual(r.rowCount, 101, 'every 10 bp inclusive');
    assert.strictEqual(r.rows.length, 101);
    assert.ok(r.rows.every((row) => row.pos >= 10_000 && row.pos <= 11_000));
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.build, 'GRCh38');
    const bytesRead = reads.reduce((n, x) => n + (x.e - x.s), 0);
    assert.ok(bytesRead < data.length / 2, `ranged read (${bytesRead}) must be a fraction of the file (${data.length})`);
});

test('gene query: BRCA1 resolves via the catalog and bridges chr17 → 17', async () => {
    const { dataset, bStart } = await buildFixture();
    const r = await queryRegion(dataset, { gene: 'brca1', limit: 200 });
    assert.strictEqual(r.gene, 'BRCA1');
    assert.strictEqual(r.rowCount, 50);
    assert.strictEqual(r.rows[0].pos, bStart);
    assert.deepStrictEqual(r.rows[0].info, { GENE: 'BRCA1' });
});

test('rsid query: hit, miss, and index-absent are three different answers', async () => {
    const { dataset } = await buildFixture();
    const hit = await queryRegion(dataset, { rsid: 'rs777' });
    assert.strictEqual(hit.rowCount, 1);
    assert.strictEqual(hit.rows[0].pos, 1000 + 1500 * 10);
    assert.strictEqual(hit.rsid, 'rs777');

    const miss = await queryRegion(dataset, { rsid: 'rs99999999' });
    assert.strictEqual(miss.rowCount, 0);
    assert.match(miss.notes[0], /not present/);

    const { dataset: noIdx } = await buildFixture({ withRsidIndex: false });
    await assert.rejects(queryRegion(noIdx, { rsid: 'rs777' }), (e) => e.code === 'dataset_rsid_index_missing');
});

test('limit clamps and SAYS so; counting continues past the clamp', async () => {
    const { dataset } = await buildFixture();
    const r = await queryRegion(dataset, { region: '1:1000-31000', limit: 10 });
    assert.strictEqual(r.rows.length, 10);
    assert.strictEqual(r.rowCount, 3000);
    assert.strictEqual(r.truncated, true);
    assert.ok(r.notes.some((n) => /3,000 rows matched.*first 10/.test(n)), r.notes.join(' | '));
});

test('filterPass and minQual narrow rows', async () => {
    const { dataset } = await buildFixture();
    const all = await queryRegion(dataset, { region: '1:1000-1490', limit: 200 });
    assert.strictEqual(all.rowCount, 50);
    const pass = await queryRegion(dataset, { region: '1:1000-1490', limit: 200, filterPass: true });
    assert.strictEqual(pass.rowCount, 40, 'every 5th row is LowQual');
    const qual = await queryRegion(dataset, { region: '1:1000-1490', limit: 200, minQual: 50 });
    assert.ok(qual.rowCount < 50 && qual.rows.every((x) => x.qual >= 50));
});

test('genotypes come only when asked', async () => {
    const { dataset } = await buildFixture();
    const bare = await queryRegion(dataset, { region: '1:1000-1000' });
    assert.strictEqual(bare.rows[0].gt, undefined);
    const withGt = await queryRegion(dataset, { region: '1:1000-1000', includeGenotypes: true });
    assert.deepStrictEqual(withGt.rows[0].gt, { format: 'GT', samples: [{ sample: 'ME', value: '0/1' }] });
});

test('refusals: selector arity, span ceiling, unknown gene, unknown build', async () => {
    const { dataset } = await buildFixture();
    await assert.rejects(queryRegion(dataset, { gene: 'BRCA1', rsid: 'rs1' }), /exactly one of/);
    await assert.rejects(queryRegion(dataset, {}), /exactly one of/);
    await assert.rejects(queryRegion(dataset, { region: '1:1-999999999' }), (e) => e.code === 'dataset_region_too_large');
    await assert.rejects(queryRegion(dataset, { gene: 'NOT_A_GENE_XYZ' }), (e) => e.code === 'dataset_gene_unknown');
    await assert.rejects(queryRegion(dataset, { region: 'nonsense' }), /unreadable region/);

    const noBuild = { ...dataset, build: null };
    await assert.rejects(queryRegion(noBuild, { gene: 'BRCA1' }), (e) => e.code === 'dataset_build_unknown');
});

test('a chromosome the file does not carry answers empty, with a note', async () => {
    const { dataset } = await buildFixture();
    const r = await queryRegion(dataset, { region: 'chrX:1-1000' });
    assert.strictEqual(r.rowCount, 0);
    assert.match(r.notes[0], /chrX is not present/);
});

test('parseRegionString tolerates commas, whitespace and single positions', () => {
    assert.deepStrictEqual(parseRegionString('chr17:43,044,295-43,125,364'), { chrom: 'chr17', start: 43_044_295, end: 43_125_364 });
    assert.deepStrictEqual(parseRegionString(' 17 : 100 '), { chrom: '17', start: 100, end: 100 });
    assert.throws(() => parseRegionString('17:200-100'), DatasetQueryError);
});
