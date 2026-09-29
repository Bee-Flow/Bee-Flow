/**
 * Dataset ingest job — end-to-end over an in-memory storage stub: raw upload
 * in, ready artifacts out; failures keep the raw and abort partial output.
 *
 * Run: cd server && node --test jobs/datasetIngest.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { mountGated } = require('../testUtils/gatedStart');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── In-memory storage with real multipart semantics ─────────────────
const objects = new Map();     // key -> Buffer
const mpu = new Map();         // uploadId -> { key, parts: Map<partNumber, Buffer> }
const events = { deletes: [], aborts: [] };
let mpuSeq = 0;

stub('../stores/storageStore', {
    isAvailable: () => true,
    buildStudioAppDatasetKey: (ownerId, appId, dsId, artifact) => `studio-apps/${ownerId}/${appId}/datasets/${dsId}/${artifact}`,
    beginMultipartUpload: async (key) => { const uploadId = `mpu-${++mpuSeq}`; mpu.set(uploadId, { key, parts: new Map() }); return { uploadId }; },
    uploadPartBuffer: async (_key, uploadId, partNumber, buffer) => { mpu.get(uploadId).parts.set(partNumber, Buffer.from(buffer)); return { etag: `e${partNumber}` }; },
    completeMultipartUpload: async (key, uploadId) => {
        const u = mpu.get(uploadId);
        const ordered = [...u.parts.keys()].sort((a, b) => a - b).map((n) => u.parts.get(n));
        objects.set(key, Buffer.concat(ordered));
        mpu.delete(uploadId);
    },
    abortMultipartUpload: async (_key, uploadId) => { events.aborts.push(uploadId); mpu.delete(uploadId); },
    uploadFile: async (key, buffer) => { objects.set(key, Buffer.from(buffer)); return { key }; },
    deleteFile: async (key) => { events.deletes.push(key); objects.delete(key); },
    streamFile: async (key, { range = null } = {}) => {
        const buf = objects.get(key);
        if (!buf) { const e = new Error(`NoSuchKey: ${key}`); e.name = 'NoSuchKey'; throw e; }
        const slice = range ? buf.subarray(range.start, range.end + 1) : buf;
        const { Readable } = require('stream');
        return { stream: Readable.from([slice]), contentType: 'application/octet-stream', contentLength: slice.length };
    },
});

// ── Manifest stub ────────────────────────────────────────────────────
const manifest = { ready: null, failed: null, progress: [], rawCleared: false, heartbeats: 0 };
stub('../stores/datasetFileStore', {
    heartbeatClaim: async () => { manifest.heartbeats++; return true; },
    updateProgress: async (_id, p) => { manifest.progress.push(p); },
    markReady: async (_id, fields) => { manifest.ready = fields; return fields; },
    markFailed: async (_id, error) => { manifest.failed = error; },
    clearRawKey: async () => { manifest.rawCleared = true; },
    listFailedRawSweep: async () => [],
    claimNextIngest: async () => null,
});
stub('../db', { pool: { connect: async () => { throw new Error('not used in ingestOne tests'); } } });
stub('../telemetry/metrics', { recordJobRun: () => {} });

const datasetIngest = require('./datasetIngest');
const { ingestOne } = datasetIngest;
const blockIndex = require('../core/datasets/blockIndex');

const HEADER = [
    '##fileformat=VCFv4.2',
    '##reference=GRCh38',
    '##contig=<ID=chr1,length=248956422>',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
].join('\n');

function makeDs(rawBuffer, over = {}) {
    const ds = {
        id: 'ds-1', appId: 'app-1', ownerId: 'owner-1', claimedBy: 'test-replica',
        rawKey: 'studio-apps/owner-1/app-1/datasets/ds-1/raw',
        receivedBytes: rawBuffer.length, declaredBytes: rawBuffer.length,
        ...over,
    };
    objects.set(ds.rawKey, rawBuffer);
    return ds;
}

test.beforeEach(() => {
    objects.clear(); mpu.clear(); mpuSeq = 0;
    events.deletes.length = 0; events.aborts.length = 0;
    manifest.ready = null; manifest.failed = null; manifest.progress.length = 0; manifest.rawCleared = false;
});

test('happy path: raw VCF → ready artifacts, raw deleted, stats faithful', async () => {
    const rows = [];
    for (let i = 0; i < 1000; i++) rows.push(`chr1\t${100 + i}\t${i === 5 ? 'rs69' : '.'}\tA\tG\t50\tPASS\tDP=${i}`);
    const text = [HEADER, ...rows].join('\n') + '\n';
    const ds = makeDs(Buffer.from(text));

    const r = await ingestOne(ds);
    assert.deepStrictEqual(r, { ok: true });

    // Manifest: ready with the right stats and the structural AV verdict.
    assert.strictEqual(manifest.ready.avStatus, 'structural');
    assert.strictEqual(manifest.ready.variantCount, 1000);
    assert.strictEqual(manifest.ready.metadata.build, 'GRCh38');
    assert.deepStrictEqual(manifest.ready.metadata.contigs, [{ name: 'chr1', count: 1000, minPos: 100, maxPos: 1099 }]);
    assert.strictEqual(manifest.rawCleared, true);
    assert.ok(events.deletes.includes(ds.rawKey), 'the raw upload is deleted after a clean ingest');

    // The data artifact is a complete VCF again.
    const data = objects.get(manifest.ready.dataKey);
    assert.strictEqual(manifest.ready.dataBytes, data.length);
    assert.strictEqual(zlib.gunzipSync(data).toString(), text);

    // The index deserializes and covers the rows.
    const idx = blockIndex.deserialize(objects.get(manifest.ready.indexKey));
    assert.strictEqual(idx.byName.get('chr1').count, 1000);

    // rs69 → shard 5 exists; no other shards were written.
    const shardKeys = [...objects.keys()].filter((k) => k.includes('/rsid/'));
    assert.deepStrictEqual(shardKeys, [`${manifest.ready.rsidPrefix}/05.bin`]);
});

test('gzipped raw is detected from its magic bytes — nothing persisted at upload time', async () => {
    const text = [HEADER, 'chr1\t100\t.\tA\tG\t50\tPASS\t.'].join('\n') + '\n';
    const ds = makeDs(zlib.gzipSync(Buffer.from(text)));
    const r = await ingestOne(ds);
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(manifest.ready.variantCount, 1);
});

test('failure (unsorted): markFailed with the line, partial output aborted, raw KEPT', async () => {
    const text = [HEADER, 'chr1\t500\t.\tA\tG\t50\tPASS\t.', 'chr1\t100\t.\tA\tG\t50\tPASS\t.'].join('\n') + '\n';
    const ds = makeDs(Buffer.from(text));
    const r = await ingestOne(ds);
    assert.strictEqual(r.ok, false);
    assert.match(manifest.failed, /coordinate-sorted.*line 6/s);
    assert.strictEqual(manifest.ready, null);
    assert.strictEqual(events.aborts.length, 1, 'the data multipart upload was aborted');
    assert.ok(objects.has(ds.rawKey), 'the raw upload stays for the diagnosis window');
    assert.strictEqual(manifest.rawCleared, false);
});

test('failure (not a VCF at all): the structural gate refuses', async () => {
    const ds = makeDs(Buffer.from('PK\x03\x04 definitely a zip pretending'));
    const r = await ingestOne(ds);
    assert.strictEqual(r.ok, false);
    assert.match(manifest.failed, /not a VCF|could not read/);
});

test('BFSF-438: both timers put ingest behind the apps module gate, never the failed-raw sweep', async () => {
    const { pool } = require('../db');
    const store = require('../stores/datasetFileStore');
    const real = { connect: pool.connect, sweep: store.listFailedRawSweep, claim: store.claimNextIngest };
    let sweeps = 0;
    let claims = 0;
    pool.connect = async () => ({ query: async () => ({ rows: [{ locked: true }] }), release() {} });
    store.listFailedRawSweep = async () => { sweeps += 1; return []; };
    store.claimNextIngest = async () => { claims += 1; return null; };
    try {
        const w = mountGated((opts) => datasetIngest.start(opts));
        assert.deepStrictEqual(w.state.consulted.map(c => c.moduleId), ['apps']);
        assert.deepStrictEqual(w.timers.map(t => t.kind).sort(), ['interval', 'timeout']);

        // App Studio removed in the Modules panel: nothing is ingested, but
        // raw uploads past their TTL are still deleted.
        w.state.active = false;
        await w.fireAll();
        assert.strictEqual(claims, 0, 'a removed App Studio module still ingested a dataset');
        assert.strictEqual(sweeps, 2, 'switching App Studio off stopped the failed-raw sweep');

        w.state.active = true;
        await w.fireAll();
        assert.strictEqual(claims, 2, 'the interval and the boot tick must both reach the ingest');
        assert.strictEqual(sweeps, 4);
        datasetIngest.stop();
    } finally {
        pool.connect = real.connect;
        store.listFailedRawSweep = real.sweep;
        store.claimNextIngest = real.claim;
    }
});
