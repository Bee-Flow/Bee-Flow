/**
 * App Studio quota helpers — row / db-byte / attachment ceilings and the org
 * usage rollup.
 *
 * The stores + db handle are stubbed via the require cache BEFORE studioAppQuota
 * loads (same trick as studioAppsRun.test.js) so nothing touches Postgres. The
 * real DATA_LIMITS drive the thresholds.
 *
 * Run: cd server && node --test appStudio/studioAppQuota.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { DATA_LIMITS } = require('./dataModel');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Mutable store state the stubs read from.
const state = {
    rowCounts: {},
    attachmentCount: 0,
    dbSize: 0,
    orgDbBytes: 0,
    orgAttBytes: 0,
    orgDatatableBytes: 0,
};

stub('../stores/studioAppDataStore', {
    getRowCounts: async () => ({ ...state.rowCounts }),
    countAttachments: async () => state.attachmentCount,
});
stub('../stores/studioAppDbStore', {
    sizeBytes: async () => state.dbSize,
});
stub('../db', {
    getOne: async (sql) => {
        // The three org-usage queries are distinguished by their target table.
        if (/FROM datatable_models\b/.test(sql)) return { bytes: state.orgDatatableBytes };
        if (/FROM studio_apps\b/.test(sql) && !/studio_app_attachments/.test(sql)) return { bytes: state.orgDbBytes };
        return { bytes: state.orgAttBytes };
    },
});

const quota = require('./studioAppQuota');

const app = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };

test.beforeEach(() => {
    state.rowCounts = {};
    state.attachmentCount = 0;
    state.dbSize = 0;
    state.orgDbBytes = 0;
    state.orgAttBytes = 0;
    state.orgDatatableBytes = 0;
});

// ── assertRowQuota ──────────────────────────────────────────────────

test('assertRowQuota: under both caps resolves', async () => {
    state.rowCounts = { orders: 5, items: 10 };
    await quota.assertRowQuota(app, 'orders'); // no throw
});

test('assertRowQuota: per-table ceiling → 409 quota_exceeded with limit/used', async () => {
    state.rowCounts = { orders: DATA_LIMITS.MAX_ROWS_PER_TABLE };
    await assert.rejects(
        () => quota.assertRowQuota(app, 'orders'),
        (err) => {
            assert.strictEqual(err.status, 409);
            assert.strictEqual(err.code, 'quota_exceeded');
            assert.strictEqual(err.limit, DATA_LIMITS.MAX_ROWS_PER_TABLE);
            assert.strictEqual(err.used, DATA_LIMITS.MAX_ROWS_PER_TABLE);
            return true;
        },
    );
});

test('assertRowQuota: whole-app ceiling → 409 even when the target table is small', async () => {
    // Spread the app-wide total across two tables so neither hits the per-table
    // cap but their sum does.
    const half = Math.ceil(DATA_LIMITS.MAX_ROWS_PER_APP / 2);
    state.rowCounts = { a: half, b: DATA_LIMITS.MAX_ROWS_PER_APP - half, target: 1 };
    await assert.rejects(
        () => quota.assertRowQuota(app, 'target'),
        (err) => err.status === 409 && err.limit === DATA_LIMITS.MAX_ROWS_PER_APP,
    );
});

// ── assertDbByteQuota ───────────────────────────────────────────────

test('assertDbByteQuota: below the ceiling resolves', async () => {
    state.dbSize = DATA_LIMITS.MAX_DB_BYTES - 1;
    await quota.assertDbByteQuota(app); // no throw
});

test('assertDbByteQuota: at/over the ceiling → 409 (write blocked; reads/deletes never call this)', async () => {
    state.dbSize = DATA_LIMITS.MAX_DB_BYTES;
    await assert.rejects(
        () => quota.assertDbByteQuota(app),
        (err) => err.status === 409 && err.limit === DATA_LIMITS.MAX_DB_BYTES && err.used === DATA_LIMITS.MAX_DB_BYTES,
    );
});

// ── assertAttachmentQuota ───────────────────────────────────────────

test('assertAttachmentQuota: within count + per-file caps resolves', async () => {
    state.attachmentCount = 3;
    await quota.assertAttachmentQuota(app, 1024); // no throw
});

test('assertAttachmentQuota: per-file byte cap → 409', async () => {
    await assert.rejects(
        () => quota.assertAttachmentQuota(app, DATA_LIMITS.MAX_ATTACHMENT_BYTES + 1),
        (err) => err.status === 409 && err.limit === DATA_LIMITS.MAX_ATTACHMENT_BYTES,
    );
});

test('assertAttachmentQuota: per-app count cap → 409', async () => {
    state.attachmentCount = DATA_LIMITS.MAX_ATTACHMENTS_PER_APP;
    await assert.rejects(
        () => quota.assertAttachmentQuota(app, 10),
        (err) => err.status === 409 && err.limit === DATA_LIMITS.MAX_ATTACHMENTS_PER_APP,
    );
});

// ── orgUsage ────────────────────────────────────────────────────────

test('orgUsage sums db_size + attachment bytes + datatable bytes across the org', async () => {
    // The datatable half was missing, so "total storage" excluded the one
    // surface a routine can grow unattended — `datatable_models.size_bytes` was
    // measured by the retention sweep and read by nobody.
    state.orgDbBytes = 1000;
    state.orgAttBytes = 250;
    state.orgDatatableBytes = 700;
    const usage = await quota.orgUsage('org-1');
    assert.deepStrictEqual(usage, {
        dbBytes: 1000, attachmentBytes: 250, datatableBytes: 700, totalBytes: 1950,
    });
});

test('orgUsage with no org id short-circuits to zero', async () => {
    assert.deepStrictEqual(await quota.orgUsage(null),
        { dbBytes: 0, attachmentBytes: 0, datatableBytes: 0, totalBytes: 0 });
});

test('a deployment with no datatable_models table still reports App Studio usage', async () => {
    // datatableStore owns that DDL and is not in App Studio's require graph, so
    // a usage screen that threw here would go blank for a reason that has
    // nothing to do with the apps it is about.
    const realGetOne = require('../db').getOne;
    require('../db').getOne = async (sql) => {
        if (/FROM datatable_models/.test(sql)) throw new Error('relation "datatable_models" does not exist');
        return realGetOne(sql);
    };
    try {
        state.orgDbBytes = 40;
        state.orgAttBytes = 2;
        assert.deepStrictEqual(await quota.orgUsage('org-1'),
            { dbBytes: 40, attachmentBytes: 2, datatableBytes: 0, totalBytes: 42 });
    } finally {
        require('../db').getOne = realGetOne;
    }
});

// ── input guard ─────────────────────────────────────────────────────

test('an app without { id, userId } is a 400, not a quota check', async () => {
    await assert.rejects(() => quota.assertRowQuota({}, 't'), (err) => err.status === 400);
    await assert.rejects(() => quota.assertDbByteQuota(null), (err) => err.status === 400);
});
