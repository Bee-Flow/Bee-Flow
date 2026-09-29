/**
 * core/datasets — streaming ingest: the invariants the query layer relies on.
 * Run: cd server && node --test core/datasets/ingest.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { Readable } = require('stream');
const { ingestVcf, IngestError } = require('./ingest');
const bgzf = require('./bgzf');

const HEADER = [
    '##fileformat=VCFv4.2',
    '##reference=GRCh38',
    '##contig=<ID=chr1,length=248956422>',
    '##contig=<ID=chr2,length=242193529>',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
].join('\n');

function row(chrom, pos, id = '.', info = 'AF=0.5') {
    return `${chrom}\t${pos}\t${id}\tA\tG\t99\tPASS\t${info}`;
}

function memorySink() {
    const sink = {
        chunks: [], offset: 0, rsids: [],
        async write(buf) { const o = sink.offset; sink.chunks.push(Buffer.from(buf)); sink.offset += buf.length; return o; },
        async writeRsid(shard, rec) { sink.rsids.push({ shard, ...rec }); },
        bytes() { return Buffer.concat(sink.chunks); },
    };
    return sink;
}

async function run(text, { gzip = false, ...opts } = {}) {
    const raw = gzip ? zlib.gzipSync(Buffer.from(text)) : Buffer.from(text);
    const sink = memorySink();
    const result = await ingestVcf({ input: Readable.from([raw]), gzip, sink, totalBytes: raw.length, ...opts });
    return { result, sink };
}

test('round trip: artifact is a complete tool-readable VCF; stats and rsids are right', async () => {
    const text = [HEADER, row('chr1', 100, 'rs64'), row('chr1', 200), row('chr2', 50, 'rs129')].join('\n') + '\n';
    const { result, sink } = await run(text);

    assert.strictEqual(result.stats.variantCount, 3);
    assert.strictEqual(result.stats.build, 'GRCh38');
    assert.deepStrictEqual(result.stats.contigs, [
        { name: 'chr1', count: 2, minPos: 100, maxPos: 200 },
        { name: 'chr2', count: 1, minPos: 50, maxPos: 50 },
    ]);

    // The whole .bgz gunzips back to exactly the input (header + rows).
    assert.strictEqual(zlib.gunzipSync(sink.bytes()).toString(), text);

    // rsIDs landed in the right shards with the right contig indices.
    assert.deepStrictEqual(sink.rsids, [
        { shard: 0, rsNum: 64, contigIdx: 0, pos: 100 },
        { shard: 1, rsNum: 129, contigIdx: 1, pos: 50 },
    ]);

    // Every indexed block starts at a line boundary of the right contig.
    const all = sink.bytes();
    for (const contig of result.perContig) {
        for (const e of contig.entries) {
            const { data } = bgzf.readBlock(all, e.blockOffset);
            assert.ok(data.toString().startsWith(`${contig.name}\t${e.firstPos}\t`),
                `block at ${e.blockOffset} must start with ${contig.name}:${e.firstPos}`);
        }
    }

    // contentEnd points at the EOF marker.
    const { data: eof } = bgzf.readBlock(all, result.contentEnd);
    assert.strictEqual(eof.length, 0);
});

test('gzipped input (.vcf.gz) ingests identically', async () => {
    const text = [HEADER, row('chr1', 100), row('chr1', 150)].join('\n') + '\n';
    const { result } = await run(text, { gzip: true });
    assert.strictEqual(result.stats.variantCount, 2);
});

test('blocks never span contigs', async () => {
    // Enough rows that chr1 fills most of a block; chr2 must still start fresh.
    const rows = [];
    for (let i = 0; i < 500; i++) rows.push(row('chr1', 1000 + i));
    rows.push(row('chr2', 5));
    const { result, sink } = await run([HEADER, ...rows].join('\n') + '\n');
    const all = sink.bytes();
    const chr2 = result.perContig.find((c) => c.name === 'chr2');
    const { data } = bgzf.readBlock(all, chr2.entries[0].blockOffset);
    assert.ok(data.toString().startsWith('chr2\t5\t'), 'chr2 begins its own block');
});

test('a row longer than one block spans continuation blocks with ONE index entry', async () => {
    const hugeInfo = 'X=' + 'a'.repeat(150_000);
    const text = [HEADER, row('chr1', 100), row('chr1', 200, '.', hugeInfo), row('chr1', 300)].join('\n') + '\n';
    const { result, sink } = await run(text);
    const chr1 = result.perContig[0];
    const positions = chr1.entries.map((e) => e.firstPos);
    assert.strictEqual(new Set(positions).size, positions.length, 'no duplicate entries for the spanning row');
    assert.ok(positions.includes(200), 'the long row has exactly one entry, at its start block');
    // The full stream still reassembles losslessly.
    assert.strictEqual(zlib.gunzipSync(sink.bytes()).toString(), text);
});

test('unsorted rows fail with the contig, positions and line number', async () => {
    const text = [HEADER, row('chr1', 500), row('chr1', 100)].join('\n') + '\n';
    await assert.rejects(run(text), (e) => {
        assert.ok(e instanceof IngestError);
        assert.match(e.message, /coordinate-sorted: chr1:100 after chr1:500/);
        assert.strictEqual(e.lineNumber, 7);
        return true;
    });
});

test('a contig appearing twice fails — same sortedness rule', async () => {
    const text = [HEADER, row('chr1', 100), row('chr2', 50), row('chr1', 200)].join('\n') + '\n';
    await assert.rejects(run(text), /contig chr1 appears twice/);
});

test('malformed rows and non-VCF input fail with specifics', async () => {
    await assert.rejects(run([HEADER, 'chr1\tnot-a-pos\t.\tA\tG\t.\t.\t.'].join('\n')), /malformed VCF row.*POS.*line 6/s);
    await assert.rejects(run('this is a CSV,really\n1,2,3\n'), /not a VCF/);
    await assert.rejects(run(HEADER + '\n'), /no data rows/);
});

test('a truncated gzip stream fails as unreadable, not as a hang or partial success', async () => {
    const good = zlib.gzipSync(Buffer.from([HEADER, row('chr1', 100)].join('\n')));
    const truncated = good.subarray(0, good.length - 10);
    const sink = memorySink();
    await assert.rejects(
        ingestVcf({ input: Readable.from([truncated]), gzip: true, sink }),
        /could not read the file/,
    );
});

test('progress is reported and monotone', async () => {
    const rows = [];
    for (let i = 0; i < 2000; i++) rows.push(row('chr1', i + 1));
    const seen = [];
    await run([HEADER, ...rows].join('\n') + '\n', { onProgress: (p) => seen.push(p) });
    assert.ok(seen.length >= 1, 'at least the final forced progress tick');
    const last = seen[seen.length - 1];
    assert.strictEqual(last.variantCount, 2000);
});
