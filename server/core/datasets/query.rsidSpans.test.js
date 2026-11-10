/**
 * core/datasets — an rsID carried by several lines at ONE position (a
 * multi-allelic split). Needs no gene catalog, unlike query.test.js.
 *
 * Run: cd server && node --test core/datasets/query.rsidSpans.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { ingestVcf } = require('./ingest');
const blockIndex = require('./blockIndex');
const rsidIdx = require('./rsidIndex');
const { queryRegion, DatasetQueryError } = require('./query');

test('rsid query: an rsID on several lines at one position returns each row once, also across a block boundary', async () => {
    const lines = [
        '##fileformat=VCFv4.2',
        '##reference=GRCh38',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    ];
    const pad = 'X'.repeat(200);
    // Enough rows before the pair that the two rs42 lines straddle a 65,280-byte block.
    let bytes = 0;
    let i = 0;
    const rowOf = (pos, id, alt) => `1\t${pos}\t${id}\tA\t${alt}\t50\tPASS\tP=${pad}`;
    while (bytes + rowOf(1000 + i, '.', 'G').length + 1 + rowOf(900000, 'rs42', 'G').length + 1 <= 65_280) {
        const l = rowOf(1000 + i, '.', 'G'); lines.push(l); bytes += l.length + 1; i++;
    }
    lines.push(rowOf(900000, 'rs42', 'G'));   // last row of block 0
    lines.push(rowOf(900000, 'rs42', 'T'));   // first row of block 1
    lines.push(rowOf(900010, '.', 'C'));
    const sink = {
        chunks: [], offset: 0, rsidByShard: new Map(),
        async write(buf) { const o = sink.offset; sink.chunks.push(Buffer.from(buf)); sink.offset += buf.length; return o; },
        async writeRsid(shard, rec) {
            if (!sink.rsidByShard.has(shard)) sink.rsidByShard.set(shard, []);
            sink.rsidByShard.get(shard).push(rec);
        },
    };
    const result = await ingestVcf({ input: Readable.from([Buffer.from(lines.join('\n') + '\n')]), gzip: false, sink });
    assert.strictEqual(result.perContig[0].entries.length, 2, 'fixture: the pair straddles two blocks');
    assert.strictEqual(result.perContig[0].entries[1].firstPos, 900000);
    const data = Buffer.concat(sink.chunks);
    const index = blockIndex.deserialize(blockIndex.serialize(result.perContig, result.contentEnd));
    const dataset = {
        build: 'GRCh38', samples: [],
        loadIndex: async () => index,
        readRange: async (s, e) => data.subarray(s, e),
        readRsidShard: async (shard) => rsidIdx.serializeShard(sink.rsidByShard.get(shard) || []),
    };
    const r = await queryRegion(dataset, { rsid: 'rs42' });
    assert.deepStrictEqual(r.rows.map((row) => row.alt), ['G', 'T']);
    assert.strictEqual(r.rowCount, 2);
    assert.strictEqual(r.truncated, false);
});

test('rsid query: a numeric rsid that is not a non-negative integer is a query error, like an unreadable string', async () => {
    const dataset = {
        build: 'GRCh38', samples: [],
        loadIndex: async () => blockIndex.deserialize(blockIndex.serialize([], 0)),
        readRange: async () => Buffer.alloc(0),
        readRsidShard: async () => rsidIdx.serializeShard([]),
    };
    for (const rsid of [-5, 12.5, NaN, Infinity, 2 ** 60]) {
        await assert.rejects(queryRegion(dataset, { rsid }), (e) => e instanceof DatasetQueryError && /unreadable rsID/.test(e.message), `rsid ${rsid}`);
    }
    const miss = await queryRegion(dataset, { rsid: 777 });
    assert.strictEqual(miss.rsid, 'rs777');
    assert.strictEqual(miss.rowCount, 0);
});
