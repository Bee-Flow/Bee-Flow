/**
 * dataset_query step — resolution, authorization, slicing and writeTo, over a
 * REAL ingested fixture (core/datasets end to end) with stubbed stores.
 *
 * Run: cd server && node --test appStudio/datasetQueryStep.test.js
 *
 * Requires the GENERATED gene catalog core/datasets/data/geneCoords.GRCh38.tsv.gz:
 * the fixture is built around BRCA1's real locus, so the catalog is the one
 * thing here that cannot be made up in memory. That file is gitignored
 * (server/.gitignore: `data/`) and therefore absent from a fresh clone, so
 * every test SKIPS when it is missing rather than failing — the same contract
 * stores/kbSources.test.js keeps without Postgres. Generate it with
 * `node scripts/build-gene-catalog.js` and the suite runs for real: the
 * assertions below are the same either way. A skip is a skip, never a
 * weakened pass.
 *
 * The two tests at the end, on whose a dataset is, are the exception: their
 * refusal comes before any artifact is read, so they need no catalog and
 * always run.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Build a real dataset artifact set in memory ──────────────────────
const { ingestVcf } = require('../core/datasets/ingest');
const blockIndex = require('../core/datasets/blockIndex');
const rsidIdx = require('../core/datasets/rsidIndex');

const objects = new Map();
const manifests = new Map();

async function buildFixture() {
    const lines = [
        '##fileformat=VCFv4.2',
        '##reference=GRCh38',
        '##contig=<ID=chr17,length=83257441>',
        '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    ];
    const { resolveGene } = require('../core/datasets/geneCatalog');
    const brca1 = resolveGene('BRCA1', 'GRCh38');
    // A catalog that loaded but answers null is just as unusable as a missing
    // one, and it must say so here — `brca1.start` below would otherwise blame
    // the step for a fixture problem.
    if (!brca1) throw new Error('the gene catalog knows no BRCA1 on GRCh38');
    for (let i = 0; i < 20; i++) {
        lines.push(`chr17\t${brca1.start + 50 + i * 10}\trs${9000 + i}\tA\tG\t${40 + i}\t${i % 4 === 0 ? 'LowQual' : 'PASS'}\tAF=0.0${i % 10}`);
    }
    const sink = {
        chunks: [], offset: 0, rsids: new Map(),
        async write(b) { const o = sink.offset; sink.chunks.push(Buffer.from(b)); sink.offset += b.length; return o; },
        async writeRsid(shard, rec) { if (!sink.rsids.has(shard)) sink.rsids.set(shard, []); sink.rsids.get(shard).push(rec); },
    };
    const r = await ingestVcf({ input: Readable.from([Buffer.from(lines.join('\n') + '\n')]), gzip: false, sink });
    const dataKey = 'k/ds-ok/data.bgz';
    const indexKey = 'k/ds-ok/index.bin';
    objects.set(dataKey, Buffer.concat(sink.chunks));
    objects.set(indexKey, blockIndex.serialize(r.perContig, r.contentEnd));
    for (const [shard, recs] of sink.rsids) {
        objects.set(`studio-apps/owner-1/app-1/datasets/ds-ok/rsid/${rsidIdx.shardName(shard)}.bin`, rsidIdx.serializeShard(recs));
    }
    // viewer-1 uploaded both; the tests below query as viewer-1.
    manifests.set('ds-ok', {
        id: 'ds-ok', appId: 'app-1', ownerId: 'owner-1', uploaderId: 'viewer-1', name: 'me.vcf', status: 'ready',
        dataKey, indexKey, rsidPrefix: 'studio-apps/owner-1/app-1/datasets/ds-ok/rsid',
        variantCount: 20, readyAt: new Date(),
        metadata: { build: r.stats.build, samples: r.stats.samples, contigs: r.stats.contigs },
    });
    manifests.set('ds-pending', { id: 'ds-pending', appId: 'app-1', ownerId: 'owner-1', uploaderId: 'viewer-1', name: 'slow.vcf', status: 'ingesting' });
    return brca1;
}

stub('../stores/datasetFileStore', {
    getDataset: async (id, appId, ownerId) => {
        const ds = manifests.get(id);
        return ds && ds.appId === appId && ds.ownerId === ownerId ? ds : null;
    },
});
/** Every key a query read, so a refusal can prove it came before the first byte. */
const streamed = [];
stub('../stores/storageStore', {
    buildStudioAppDatasetKey: (ownerId, appId, dsId, artifact) => `studio-apps/${ownerId}/${appId}/datasets/${dsId}/${artifact}`,
    streamFile: async (key, { range = null } = {}) => {
        streamed.push(key);
        const buf = objects.get(key);
        if (!buf) { const e = new Error(`NoSuchKey: ${key}`); e.name = 'NoSuchKey'; throw e; }
        const slice = range ? buf.subarray(range.start, range.end + 1) : buf;
        return { stream: Readable.from([slice]) };
    },
});
stub('./stepDataSource', {
    resolveDataBinding: async (_app, _model, binding) => {
        // The upsert probe: pretend variant_key 'chr17:…' rows do not exist yet,
        // except one marker the test seeds to prove updates route by id.
        const f = binding.filter?.[0];
        if (f && f.value === global.__existingKey) return { id: 'row-existing' };
        return null;
    },
});

const { datasetQueryStep, resolveReadyDataset } = require('./datasetQueryStep');

const APP = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };
const MODEL = { tables: [{ id: 'tbl_v', key: 'variants', fields: [{ key: 'vkey', type: 'text' }, { key: 'position', type: 'number' }, { key: 'source', type: 'text' }] }] };

// Injected helper fakes — bindings are {kind:'static', value} in these tests.
const helpers = {
    resolveBinding: (b) => (b && typeof b === 'object' && 'value' in b ? b.value : b),
    buildServerScope: () => ({}),
    writeViewer: (ctx) => ({ id: ctx.viewerId }),
    findTable: (model, tableId) => model.tables.find((t) => t.id === tableId) || null,
    writeRecord: async (_app, _model, _table, values, opts) => {
        helpers._writes.push({ values, recordId: opts.recordId });
        return { id: opts.recordId || `row-${helpers._writes.length}` };
    },
    _writes: [],
};

const S = (value) => ({ kind: 'static', value });
let brca1;

// Fixture present → the whole suite runs; fixture absent → every test skips
// carrying the reason. There is deliberately nothing in between: a missing
// catalog must never turn into a green run over a hollowed-out assertion.
//
// ── AND THE GATE IS AS NARROW AS THAT SENTENCE ──────────────────────
// It used to be a bare catch around the WHOLE of buildFixture(), which is not
// just a catalog read: it runs ingestVcf(), blockIndex.serialize() and
// rsidIndex.serializeShard() — the chain under test. Any throw from there
// became four green skips blaming a file that was sitting right there
// ("generate it with build-gene-catalog.js"), and the suite exited 0 on a real
// regression. Measured: a planted `throw` in blockIndex.js gave
// `# pass 0 / # fail 0 / # skipped 4`, exit 0.
//
// Only the catalog may skip, so only the catalog is inside the try. Everything
// after it throws out of `before`, which fails the file — which is the point.
let ready = false;
let skipReason = '';

/** The one dependency that is legitimately absent from a fresh clone. */
function catalogOrNull() {
    try {
        const { resolveGene } = require('../core/datasets/geneCatalog');
        return resolveGene('BRCA1', 'GRCh38') || null;
    } catch (e) {
        // A read error on the gz IS the missing-catalog case; anything else
        // (a broken geneCatalog module) is a regression and must go red.
        if (e && (e.code === 'ENOENT' || e.code === 'MODULE_NOT_FOUND' || e.code === 'Z_DATA_ERROR')) return null;
        throw e;
    }
}

test.before(async () => {
    if (!catalogOrNull()) {
        skipReason = 'gene catalog unavailable (no BRCA1 on GRCh38), skipping';
        console.warn(`[datasetQueryStep.test] ${skipReason} — generate it with: node scripts/build-gene-catalog.js`);
        return;
    }
    // Past this line every failure is the code under test failing.
    brca1 = await buildFixture();
    ready = true;
});
test.beforeEach(() => { helpers._writes.length = 0; global.__existingKey = null; });

/** One test, run only when the fixture is really there. */
function guarded(name, fn) {
    test(name, async (t) => {
        if (!ready) { t.skip(skipReason); return; }
        await fn(t);
    });
}

guarded('gene slice over a ready dataset returns bounded rows and metadata', async (_t) => {
    const r = await datasetQueryStep(APP, MODEL, {
        kind: 'dataset_query', dataset: S({ kind: 'studio_dataset', datasetId: 'ds-ok' }),
        gene: S('brca1'), limit: 5, resultVar: 'v',
    }, { viewerId: 'viewer-1' }, helpers);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.rowCount, 20);
    assert.strictEqual(r.result.returned, 5);
    assert.strictEqual(r.result.truncated, true);
    assert.strictEqual(r.result.gene, 'BRCA1');
    assert.strictEqual(r.result.build, 'GRCh38');
    assert.strictEqual(r.result.datasetName, 'me.vcf');
});

guarded('rsid + filters work; summary drops rows but keeps counts', async () => {
    const hit = await datasetQueryStep(APP, MODEL, {
        kind: 'dataset_query', dataset: S('ds-ok'), rsid: S('rs9003'), resultVar: 'v',
    }, { viewerId: 'viewer-1' }, helpers);
    assert.strictEqual(hit.result.rowCount, 1);
    assert.strictEqual(hit.result.rows[0].pos, brca1.start + 50 + 30);

    const summary = await datasetQueryStep(APP, MODEL, {
        kind: 'dataset_query', dataset: S('ds-ok'), gene: S('BRCA1'), filterPass: true,
        resultDetail: 'summary', limit: 200, resultVar: 'v',
    }, { viewerId: 'viewer-1' }, helpers);
    assert.strictEqual(summary.result.rows, undefined, 'summary carries no rows');
    assert.strictEqual(summary.result.rowCount, 15, '5 of 20 are LowQual');
});

guarded('refusals: unset dataset, foreign id, not-ready, empty selector, double selector', async () => {
    const run = (step) => datasetQueryStep(APP, MODEL, step, { viewerId: 'viewer-1' }, helpers);
    await assert.rejects(run({ kind: 'dataset_query', dataset: S(null), gene: S('BRCA1') }), /not set/);
    await assert.rejects(run({ kind: 'dataset_query', dataset: S('ds-of-someone-else'), gene: S('BRCA1') }), /not found/i);
    await assert.rejects(run({ kind: 'dataset_query', dataset: S('ds-pending'), gene: S('BRCA1') }), /still ingesting/);
    await assert.rejects(run({ kind: 'dataset_query', dataset: S('ds-ok'), gene: S('') }), /empty/);
    await assert.rejects(run({ kind: 'dataset_query', dataset: S('ds-ok'), gene: S('BRCA1'), rsid: S('rs1') }), /more than one/);
});

guarded('writeTo: rows land with mapping + constants; upsertOn routes to the existing row', async () => {
    global.__existingKey = `chr17:${brca1.start + 50}:A>G`;
    const r = await datasetQueryStep(APP, MODEL, {
        kind: 'dataset_query', dataset: S('ds-ok'), gene: S('BRCA1'), limit: 3, resultVar: 'v',
        writeTo: {
            tableId: 'tbl_v',
            mapping: { vkey: 'variant_key', position: 'pos', ignored_col: 'pos' },
            upsertOn: 'vkey',
            constants: { source: S('genome-upload') },
        },
    }, { viewerId: 'viewer-1' }, helpers);
    assert.strictEqual(r.result.written, 3);
    assert.strictEqual(helpers._writes.length, 3);
    // The first row's variant_key matches the seeded existing row → UPDATE.
    assert.strictEqual(helpers._writes[0].recordId, 'row-existing');
    assert.strictEqual(helpers._writes[1].recordId, undefined, 'the rest are inserts');
    assert.strictEqual(helpers._writes[0].values.vkey, global.__existingKey);
    assert.strictEqual(helpers._writes[0].values.position, brca1.start + 50);
    assert.strictEqual(helpers._writes[0].values.source, 'genome-upload');
    assert.ok(!('ignored_col' in helpers._writes[0].values), 'columns missing from the table are skipped');
});

// ── Whose a dataset is ───────────────────────────────────────────────
// No artifact needed: the refusal comes before a byte is read, so these run
// with or without the gene catalog. Alice, a member of owner-1's app, uploaded
// this one; it sits in owner-1's storage.
manifests.set('ds-alice', {
    id: 'ds-alice', appId: 'app-1', ownerId: 'owner-1', uploaderId: 'alice', name: 'alice.vcf', status: 'ready',
    dataKey: 'k/ds-alice/data.bgz', indexKey: 'k/ds-alice/index.bin', metadata: { build: 'GRCh38' },
});

test('a genome dataset answers only to the person who uploaded it', async () => {
    assert.strictEqual((await resolveReadyDataset(APP, 'ds-alice', 'alice')).id, 'ds-alice');
    const refused = {};
    for (const [who, actor] of Object.entries({
        'another member': 'bob',
        'the app owner': 'owner-1',
        'a public page visitor': 'anon_0f3c',
        'nobody named': undefined,
    })) {
        refused[who] = await resolveReadyDataset(APP, 'ds-alice', actor).then(() => 'resolved', (e) => `${e.status} ${e.message}`);
    }
    assert.deepStrictEqual(refused, {
        'another member': '400 Dataset not found',
        'the app owner': '400 Dataset not found',
        'a public page visitor': '400 Dataset not found',
        'nobody named': '400 Dataset not found',
    });
});

test('dataset_query runs as the person clicking: another member\'s file is refused before a byte is read', async () => {
    const before = streamed.length;
    await assert.rejects(datasetQueryStep(APP, MODEL, {
        kind: 'dataset_query', dataset: S({ kind: 'studio_dataset', datasetId: 'ds-alice' }), gene: S('BRCA1'),
    }, { viewerId: 'bob' }, helpers), /Dataset not found/);
    assert.deepStrictEqual(streamed.slice(before), [], 'not one byte of her file was read');
});
