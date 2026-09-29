/**
 * Dataset File Store — the SQL-enforced upload/ingest state machine.
 *
 * Integration test against the local Postgres (CORE_DATABASE_URL); skips with
 * exit 0 when no DB is reachable, like the other store tests.
 *
 * Run: cd server && node --test stores/datasetFileStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const store = require('./datasetFileStore');

const OWNER = `tds_${crypto.randomBytes(4).toString('hex')}`;
const APP = `app_${crypto.randomBytes(4).toString('hex')}`;
let dbUp = false;
let pool;

test.before(async () => {
    try {
        await store.sumBytesForOwner(OWNER); // forces initDB + a real query
        ({ pool } = require('../db'));
        dbUp = true;
    } catch (e) {
        console.warn(`[datasetFileStore.test] Postgres unavailable, skipping: ${e.message}`);
    }
});

test.after(async () => {
    if (dbUp) {
        await pool.query(`DELETE FROM studio_app_dataset_files WHERE owner_id = $1`, [OWNER]).catch(() => {});
    }
});

function create(over = {}) {
    return store.createDataset({
        appId: APP, ownerId: OWNER, orgId: 'org1', uploaderId: OWNER,
        name: 'genome.vcf.gz', declaredBytes: 96, partSize: 32, partsTotal: 3,
        uploadState: { s3UploadId: 'u-1' }, rawKey: `k/${crypto.randomUUID()}/raw`,
        ...over,
    });
}

test('parts are sequential IN SQL: duplicates and gaps fail with the expectation', async (t) => {
    if (!dbUp) return t.skip('no database');
    const ds = await create();
    assert.strictEqual(ds.status, 'uploading');

    assert.deepStrictEqual((await store.recordPart(ds.id, APP, OWNER, 0, 'e0', 32)).ok, true);
    // Duplicate of part 0 → refused, told what is expected next.
    assert.deepStrictEqual(await store.recordPart(ds.id, APP, OWNER, 0, 'e0', 32), { ok: false, expected: 1 });
    // Gap (part 2 before part 1) → refused.
    assert.deepStrictEqual(await store.recordPart(ds.id, APP, OWNER, 2, 'e2', 32), { ok: false, expected: 1 });

    // markUploaded refuses while parts are missing.
    assert.strictEqual(await store.markUploaded(ds.id, APP, OWNER), false);

    await store.recordPart(ds.id, APP, OWNER, 1, 'e1', 32);
    await store.recordPart(ds.id, APP, OWNER, 2, 'e2', 32);
    assert.strictEqual(await store.markUploaded(ds.id, APP, OWNER), true);

    const after = await store.getDataset(ds.id, APP, OWNER);
    assert.strictEqual(after.status, 'uploaded');
    assert.strictEqual(after.receivedBytes, 96);
    assert.deepStrictEqual(after.uploadState.etags, { 0: 'e0', 1: 'e1', 2: 'e2' });
});

test('owner scoping: a foreign id is indistinguishable from a missing one', async (t) => {
    if (!dbUp) return t.skip('no database');
    const ds = await create();
    assert.strictEqual(await store.getDataset(ds.id, APP, 'someone-else'), null);
    assert.strictEqual(await store.getDataset(ds.id, 'other-app', OWNER), null);
    assert.strictEqual(await store.deleteDataset(ds.id, APP, 'someone-else'), null);
    assert.ok(await store.getDataset(ds.id, APP, OWNER), 'still there for the owner');
    const deleted = await store.deleteDataset(ds.id, APP, OWNER);
    assert.strictEqual(deleted.id, ds.id, 'delete returns the row for artifact cleanup');
});

test('ingest claims: exclusive, heartbeat-guarded, stale claims are retaken', async (t) => {
    if (!dbUp) return t.skip('no database');
    const ds = await create();
    for (let n = 0; n < 3; n++) await store.recordPart(ds.id, APP, OWNER, n, `e${n}`, 32);
    await store.markUploaded(ds.id, APP, OWNER);

    const [a, b] = await Promise.all([store.claimNextIngest('replica-A'), store.claimNextIngest('replica-B')]);
    const winners = [a, b].filter((r) => r && r.id === ds.id);
    assert.strictEqual(winners.length, 1, 'exactly one replica claims the row');
    const claimant = winners[0].claimedBy;

    assert.strictEqual(await store.heartbeatClaim(ds.id, claimant), true);
    assert.strictEqual(await store.heartbeatClaim(ds.id, 'impostor'), false);

    // Fresh claim → invisible to a new claimant.
    assert.strictEqual(await store.claimNextIngest('replica-C'), null);

    // Stale claim (dead replica) → retaken.
    await pool.query(
        `UPDATE studio_app_dataset_files SET claimed_at = NOW() - INTERVAL '31 minutes' WHERE id = $1`,
        [ds.id],
    );
    const retaken = await store.claimNextIngest('replica-D');
    assert.strictEqual(retaken?.id, ds.id);
    assert.strictEqual(retaken.claimedBy, 'replica-D');
});

test('markReady / markFailed drive the quota sum and the raw sweep', async (t) => {
    if (!dbUp) return t.skip('no database');
    const good = await create({ declaredBytes: 1000 });
    const bad = await create({ declaredBytes: 500 });

    const ready = await store.markReady(good.id, {
        dataKey: 'k/data.bgz', indexKey: 'k/index.bin', rsidPrefix: 'k/rsid',
        dataBytes: 400, blockCount: 7, variantCount: 1234,
        metadata: { build: 'GRCh38', samples: ['ME'], contigs: [{ name: 'chr1', count: 1234 }] },
        avStatus: 'structural',
    });
    assert.strictEqual(ready.status, 'ready');
    assert.strictEqual(ready.progressPct, 100);
    assert.strictEqual(ready.variantCount, 1234);
    assert.strictEqual(ready.metadata.build, 'GRCh38');

    await store.markFailed(bad.id, 'boom: not sorted (line 12)');
    const failed = await store.getDataset(bad.id, APP, OWNER);
    assert.strictEqual(failed.status, 'failed');
    assert.match(failed.error, /not sorted/);

    // Quota counts the READY row at its real (post-ingest) size and skips failed.
    const uploadingRows = (await store.listDatasets(APP, OWNER)).filter((d) => d.status === 'uploading');
    const uploadingBytes = uploadingRows.reduce((n, d) => n + d.declaredBytes, 0);
    assert.strictEqual(await store.sumBytesForOwner(OWNER), 400 + uploadingBytes);

    // The failed row (still holding raw_key) shows up for the sweep once old.
    assert.strictEqual((await store.listFailedRawSweep(24)).filter((d) => d.id === bad.id).length, 0, 'too fresh to sweep');
    await pool.query(`UPDATE studio_app_dataset_files SET updated_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [bad.id]);
    assert.strictEqual((await store.listFailedRawSweep(24)).filter((d) => d.id === bad.id).length, 1);
    await store.clearRawKey(bad.id);
    assert.strictEqual((await store.listFailedRawSweep(24)).filter((d) => d.id === bad.id).length, 0, 'swept rows drop out');
});

test('countForUploader counts one person\'s live datasets in the app, and nobody else\'s', async (t) => {
    if (!dbUp) return t.skip('no database');
    const MEMBER = `${OWNER}_member`;
    const before = await store.countForUploader(APP, OWNER);
    const ds = await create();
    assert.strictEqual(await store.countForUploader(APP, OWNER), before + 1);
    // A member's upload into the same app (same owner envelope) is theirs.
    await create({ uploaderId: MEMBER });
    assert.strictEqual(await store.countForUploader(APP, OWNER), before + 1, 'the member\'s file is not the owner\'s count');
    assert.strictEqual(await store.countForUploader(APP, MEMBER), 1);
    await store.markFailed(ds.id, 'x');
    assert.strictEqual(await store.countForUploader(APP, OWNER), before, 'failed rows do not count');
});
