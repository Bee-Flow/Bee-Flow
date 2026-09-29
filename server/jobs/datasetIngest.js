/**
 * Dataset ingest — the background half of large-dataset uploads.
 *
 * Claims one 'uploaded' manifest at a time (FOR UPDATE SKIP LOCKED in the
 * store; a claim without a heartbeat for 30 min is retaken) and runs it through
 * core/datasets/ingest: stream the raw upload → validate + re-encode to BGZF →
 * build the block index and rsID shards → mark ready → DELETE the raw upload.
 *
 * This job IS the AV verdict for datasets ('structural'): the only bytes ever
 * served onward are a re-encoding of parsed, validated VCF fields written by
 * our own encoder. A file that does not parse as coordinate-sorted VCF is
 * marked failed and never becomes queryable; its raw upload is kept for
 * DATASET_FAILED_RAW_TTL_H hours (diagnosis/retry window) and then swept.
 *
 * Memory profile: constant. The raw stream flows through the parser; BGZF
 * blocks buffer to one 32 MB storage part at a time; rsID records spill to 64
 * scratch files and are sorted per-shard (a WGS shard is ~80 K records).
 *
 * Multi-replica: the advisory lock only keeps replicas from redundant claim
 * polling — the row claim is what prevents double ingesting (the connector-sync
 * job pattern). Artifact keys are deterministic per dataset, so a retaken
 * ingest simply overwrites the dead replica's partial output.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../db');
const datasetFileStore = require('../stores/datasetFileStore');
const storageStore = require('../stores/storageStore');
const { ingestVcf } = require('../core/datasets/ingest');
const blockIndex = require('../core/datasets/blockIndex');
const rsidIndex = require('../core/datasets/rsidIndex');
require('../core/datasets/bgzf');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const LOCK_KEY = 0xBEEFDA7A;
const INTERVAL_MS = 15 * 1000;
const BOOT_DELAY_MS = 45 * 1000;
const CONCURRENCY = parseInt(process.env.DATASET_INGEST_CONCURRENCY, 10) || 1;
const PART_BYTES = parseInt(process.env.DATASET_PART_BYTES, 10) || 32 * 1024 * 1024;
const FAILED_RAW_TTL_H = parseInt(process.env.DATASET_FAILED_RAW_TTL_H, 10) || 24;
const HEARTBEAT_MS = 60 * 1000;

let _inFlight = false;
let _timer = null;

/** Buffers bgzf blocks into ≥PART_BYTES storage parts; tracks byte offsets. */
function makeDataSink(dataKey, uploadId) {
    let total = 0;
    let bufs = [];
    let bufBytes = 0;
    let partNumber = 0;
    const parts = [];
    async function flush() {
        if (bufBytes === 0) return;
        partNumber++;
        const { etag } = await storageStore.uploadPartBuffer(dataKey, uploadId, partNumber, Buffer.concat(bufs, bufBytes));
        parts.push({ partNumber, etag });
        bufs = [];
        bufBytes = 0;
    }
    return {
        async write(block) {
            const offset = total;
            total += block.length;
            bufs.push(block);
            bufBytes += block.length;
            if (bufBytes >= PART_BYTES) await flush();
            return offset;
        },
        async finalize() {
            await flush();
            await storageStore.completeMultipartUpload(dataKey, uploadId, parts);
            return total;
        },
    };
}

/** Spills rsID records to 64 scratch files; sorted + serialized at finalize. */
function makeRsidSpill(scratchDir) {
    const streams = new Map(); // shard -> WriteStream
    return {
        write(shard, rec) {
            let ws = streams.get(shard);
            if (!ws) {
                ws = fs.createWriteStream(path.join(scratchDir, `rsid-${shard}.bin`));
                streams.set(shard, ws);
            }
            const buf = Buffer.alloc(16);
            buf.writeBigUInt64LE(BigInt(rec.rsNum), 0);
            buf.writeUInt32LE(rec.contigIdx >>> 0, 8);
            buf.writeUInt32LE(rec.pos >>> 0, 12);
            ws.write(buf);
        },
        async shards() {
            await Promise.all([...streams.values()].map((ws) => new Promise((r) => ws.end(r))));
            const out = [];
            for (const shard of streams.keys()) {
                const raw = fs.readFileSync(path.join(scratchDir, `rsid-${shard}.bin`));
                const records = [];
                for (let p = 0; p + 16 <= raw.length; p += 16) {
                    records.push({
                        rsNum: Number(raw.readBigUInt64LE(p)),
                        contigIdx: raw.readUInt32LE(p + 8),
                        pos: raw.readUInt32LE(p + 12),
                    });
                }
                out.push({ shard, buffer: rsidIndex.serializeShard(records) });
            }
            return out;
        },
    };
}

/** Is the raw upload gzip? Two ranged bytes answer it — nothing was persisted. */
async function rawIsGzip(rawKey) {
    const head = await storageStore.streamFile(rawKey, { range: { start: 0, end: 1 } });
    const chunks = [];
    for await (const c of head.stream) chunks.push(c);
    const b = Buffer.concat(chunks);
    return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * Ingest one claimed manifest end to end. Exported for tests.
 * @returns {{ok:boolean, error?:string}}
 */
async function ingestOne(ds) {
    const claimant = ds.claimedBy;
    const dataKey = storageStore.buildStudioAppDatasetKey(ds.ownerId, ds.appId, ds.id, 'data.bgz');
    const indexKey = storageStore.buildStudioAppDatasetKey(ds.ownerId, ds.appId, ds.id, 'index.bin');
    const rsidPrefix = `studio-apps/${ds.ownerId}/${ds.appId}/datasets/${ds.id}/rsid`;

    let scratchDir = null;
    let dataUploadId = null;
    let heartbeat = null;
    let claimLost = false;

    try {
        heartbeat = setInterval(() => {
            datasetFileStore.heartbeatClaim(ds.id, claimant).then((ok) => { if (!ok) claimLost = true; }).catch(() => {});
        }, HEARTBEAT_MS);
        heartbeat.unref?.();

        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dataset-'));
        const gzip = await rawIsGzip(ds.rawKey);
        ({ uploadId: dataUploadId } = await storageStore.beginMultipartUpload(dataKey, 'application/gzip'));
        const dataSink = makeDataSink(dataKey, dataUploadId);
        const rsidSpill = makeRsidSpill(scratchDir);

        const raw = await storageStore.streamFile(ds.rawKey);
        const result = await ingestVcf({
            input: raw.stream,
            gzip,
            sink: {
                write: async (buf) => {
                    // A stolen claim means another replica is (or will be)
                    // writing these very keys — stop immediately, never race it.
                    if (claimLost) throw new Error('ingest claim lost (stale heartbeat) — another replica took over');
                    return dataSink.write(buf);
                },
                writeRsid: async (shard, rec) => rsidSpill.write(shard, rec),
            },
            totalBytes: ds.receivedBytes || ds.declaredBytes,
            onProgress: ({ pct, variantCount }) => {
                datasetFileStore.updateProgress(ds.id, {
                    pct,
                    note: `${variantCount.toLocaleString('en-US')} variants indexed`,
                }).catch(() => {});
            },
        });

        const dataBytes = await dataSink.finalize();
        await datasetFileStore.updateProgress(ds.id, { note: 'writing indexes' });

        await storageStore.uploadFile(indexKey, blockIndex.serialize(result.perContig, result.contentEnd), 'application/octet-stream');
        for (const { shard, buffer } of await rsidSpill.shards()) {
            const key = storageStore.buildStudioAppDatasetKey(ds.ownerId, ds.appId, ds.id, `rsid/${rsidIndex.shardName(shard)}.bin`);
            await storageStore.uploadFile(key, buffer, 'application/octet-stream');
        }

        await datasetFileStore.markReady(ds.id, {
            dataKey,
            indexKey,
            rsidPrefix,
            dataBytes,
            blockCount: result.stats.blockCount,
            variantCount: result.stats.variantCount,
            metadata: {
                build: result.stats.build,
                samples: result.stats.samples,
                contigs: result.stats.contigs,
            },
            avStatus: 'structural',
        });

        // The raw upload has served its purpose — the re-encoded artifact is
        // the canonical copy. Deleting it is part of the AV story.
        await storageStore.deleteFile(ds.rawKey).catch(() => {});
        await datasetFileStore.clearRawKey(ds.id);
        log.info(`[DatasetIngest] ready: ${ds.id} (${result.stats.variantCount} variants, ${result.stats.blockCount} blocks)`);
        return { ok: true };
    } catch (e) {
        const msg = e?.message || 'ingest failed';
        log.warn(`[DatasetIngest] failed: ${ds.id} — ${msg}`);
        await datasetFileStore.markFailed(ds.id, msg).catch(() => {});
        // Partial artifacts are noise — clean them; the raw stays for the TTL
        // window so a platform bug can be diagnosed and the ingest retried.
        if (dataUploadId) await storageStore.abortMultipartUpload(dataKey, dataUploadId).catch(() => {});
        await storageStore.deleteFile(indexKey).catch(() => {});
        return { ok: false, error: msg };
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    }
}

/** Failed rows past the TTL lose their raw upload (their manifest row stays). */
async function sweepFailedRaws() {
    const stale = await datasetFileStore.listFailedRawSweep(FAILED_RAW_TTL_H);
    for (const ds of stale) {
        await storageStore.deleteFile(ds.rawKey).catch(() => {});
        await datasetFileStore.clearRawKey(ds.id);
        log.info(`[DatasetIngest] swept failed raw: ${ds.id}`);
    }
}

/**
 * One pass: sweep expired failed raws, then claim and ingest.
 *
 * `mayIngest` (optional, async → boolean) is asked AFTER the sweep and gates
 * only the claim loop. start() hands it the runtime module gate, so switching
 * App Studio off stops new ingests while failed raw uploads past their TTL are
 * still deleted: a deletion obligation must not stop with a billable feature
 * (same reasoning as jobs/datatableRetention.js and jobs/platformRetention.js).
 */
async function processTick({ mayIngest = null } = {}) {
    if (_inFlight) return;
    _inFlight = true;
    let client = null;
    let acquired = false;
    const t0 = Date.now();
    let ok = true;
    let didWork = false;
    try {
        if (!storageStore.isAvailable()) return; // nothing can move without object storage
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return;

        await sweepFailedRaws().catch((e) => log.warn('[DatasetIngest] sweep error:', e.message));

        if (mayIngest && !(await mayIngest())) return;

        const claimant = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
        for (let slot = 0; slot < CONCURRENCY; slot++) {
            const ds = await datasetFileStore.claimNextIngest(claimant);
            if (!ds) break;
            didWork = true;
            const r = await ingestOne(ds);
            if (!r.ok) ok = false;
        }
    } catch (e) {
        ok = false;
        log.warn('[DatasetIngest] tick error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
        if (acquired && didWork) recordJobRun({ job: 'dataset_ingest', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
        _inFlight = false;
    }
}

/**
 * Mount the interval and the boot tick. Both put the INGEST behind the runtime
 * module gate, so removing App Studio in the admin Modules panel stops dataset
 * ingest on a running pod (BFSF-438); the failed-raw sweep keeps running (see
 * processTick). `gate` is a test seam; a bare processTick() stays ungated.
 */
function start({ gate } = {}) {
    if (_timer) return;
    const moduleGatedTick = gate || require('../modules').moduleGatedTick;
    // The gate wraps a probe rather than processTick: it answers true while
    // App Studio is active and undefined (after logging the pause once) when
    // it is not, keeping moduleGatedTick's fail-open read of the module row.
    const appsActive = moduleGatedTick('apps', async () => true, 'datasetIngest');
    const mayIngest = async () => (await appsActive()) === true;
    const gatedTick = () => processTick({ mayIngest });
    log.info(`[DatasetIngest] started: every ${INTERVAL_MS / 1000}s, concurrency ${CONCURRENCY}`);
    _timer = setInterval(() => {
        gatedTick().catch((e) => log.warn('[DatasetIngest] tick error:', e && e.message));
    }, INTERVAL_MS);
    _timer.unref?.();
    setTimeout(() => {
        gatedTick().catch((e) => log.warn('[DatasetIngest] boot tick error:', e && e.message));
    }, BOOT_DELAY_MS).unref?.();
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, processTick, ingestOne, sweepFailedRaws, LOCK_KEY };
