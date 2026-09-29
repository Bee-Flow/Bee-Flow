/**
 * Source mirror sync job — what one tick does.
 *
 * Thin job (advisory lock → list due → refresh each through the source
 * registry, which dispatches by kind), so the tests pin the two things that
 * would rot silently: every due mirror is handed to ITS engine tagged as
 * scheduled, and one mirror failing does not stop the rest of the tick.
 * Stubs via the require-cache trick — no Postgres, no network; only the
 * Nextcloud engine is stubbed, which is also the proof that requiring the
 * registry loads no other kind.
 *
 * Run: cd server && node --test jobs/datatableNcSync.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let due = [];
let locked = true;
stub('../db', { pool: { connect: async () => ({ query: async (sql) => (/advisory_lock/.test(sql) ? { rows: [{ locked }] } : { rows: [] }), release() {} }) } });
stub('../telemetry/metrics', { recordJobRun: () => {} });
stub('../stores/datatableStore', { listDueSourceSyncs: async () => due });

const calls = [];
let impl = async () => ({ ok: true });
stub('../core/dataEngine/sources/nextcloudTable/sync', {
    syncRows: async (table, opts) => { calls.push({ id: table.id, reason: opts.reason }); return impl(table); },
});

const job = require('./datatableNcSync');

test.beforeEach(() => { calls.length = 0; due = []; locked = true; impl = async () => ({ ok: true }); });

test('every due mirror is refreshed through the engine, tagged as scheduled', async () => {
    due = [{ id: 'tbl_a', managedKind: 'nextcloud_table' }, { id: 'tbl_b', managedKind: 'nextcloud_table' }];
    await job.processDueSyncs();
    assert.deepStrictEqual(calls.sort((a, b) => a.id.localeCompare(b.id)),
        [{ id: 'tbl_a', reason: 'schedule' }, { id: 'tbl_b', reason: 'schedule' }]);
});

test('one mirror throwing does not stop the others in the tick', async () => {
    due = [{ id: 'tbl_bad', managedKind: 'nextcloud_table' }, { id: 'tbl_ok', managedKind: 'nextcloud_table' }];
    impl = async (t) => { if (t.id === 'tbl_bad') throw new Error('boom'); return { ok: true }; };
    await job.processDueSyncs();
    assert.deepStrictEqual(calls.map(c => c.id).sort(), ['tbl_bad', 'tbl_ok']);
});

test('a tick another replica owns does nothing here', async () => {
    due = [{ id: 'tbl_a', managedKind: 'nextcloud_table' }];
    locked = false;
    await job.processDueSyncs();
    assert.strictEqual(calls.length, 0);
});

test('the lock key is its own, and the concurrency is bounded', () => {
    assert.strictEqual(job.LOCK_KEY, 0xBEEF110);
    assert.ok(job.SYNC_CONCURRENCY >= 1 && job.SYNC_CONCURRENCY <= 10);
});
