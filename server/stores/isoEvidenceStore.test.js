// @typecheck
'use strict';

/**
 * isoEvidenceStore against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js): the snapshot hash leaves out the elapsed-time
 * fields (days_remaining, oldest_open_days, …), so a day passing is not drift;
 * an unchanged snapshot refreshes the latest row with the fresh payload, so a
 * check never judges a stored first-day age; a real change appends a row.
 *
 * Run: cd server && node --test stores/isoEvidenceStore.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./isoEvidenceStore');

before(() => store.initDB());
after(close);

const snapshots = async (subject) => (await pg.query(
    `SELECT payload, fetched_at FROM iso_evidence_snapshots
      WHERE organization_id = 'org1' AND connector_id = 'tls-endpoints' AND subject_id = $1 ORDER BY id`, [subject],
)).rows;

test('a payload that differs only in an elapsed-time field hashes the same', () => {
    const { hashPayload } = store;
    assert.equal(hashPayload({ host: 'a', days_remaining: 40 }), hashPayload({ host: 'a', days_remaining: 39 }));
    assert.equal(
        hashPayload({ repo: 'r', dependabot: { open_total: 2, oldest_open_days: 5, oldest_high_critical_days: 3 } }),
        hashPayload({ repo: 'r', dependabot: { open_total: 2, oldest_open_days: 6, oldest_high_critical_days: 4 } }));
    assert.equal(hashPayload({ servers: 2, newest_backup_age_days: 1 }), hashPayload({ servers: 2, newest_backup_age_days: 2 }));
    assert.notEqual(hashPayload({ host: 'a', days_remaining: 40 }), hashPayload({ host: 'b', days_remaining: 40 }));
});

test('the first snapshot is stored and reported as a change', async () => {
    const r = await store.saveSnapshot('org1', 'tls-endpoints', 'first', { host: 'first', days_remaining: 40 });
    assert.equal(r.changed, true);
    assert.equal((await snapshots('first')).length, 1);
});

test('an unchanged snapshot refreshes the stored payload in place, so the ages stay current', async () => {
    await store.saveSnapshot('org1', 'tls-endpoints', 'a', { host: 'a', days_remaining: 40 });
    await pg.query("UPDATE iso_evidence_snapshots SET fetched_at = NOW() - INTERVAL '1 day' WHERE subject_id = 'a'");
    const before = await snapshots('a');
    const r = await store.saveSnapshot('org1', 'tls-endpoints', 'a', { host: 'a', days_remaining: 39 });
    assert.equal(r.changed, false);
    const after = await snapshots('a');
    assert.equal(after.length, 1, 'no identical-row time series');
    assert.deepEqual(after[0].payload, { host: 'a', days_remaining: 39 });
    assert.ok(new Date(after[0].fetched_at) > new Date(before[0].fetched_at));
});

test('a real change appends a new snapshot and reports drift; another subject is untouched', async () => {
    await store.saveSnapshot('org1', 'tls-endpoints', 'b', { host: 'b', protocol: 'TLSv1.3' });
    await store.saveSnapshot('org1', 'tls-endpoints', 'c', { host: 'c', protocol: 'TLSv1.3' });
    const r = await store.saveSnapshot('org1', 'tls-endpoints', 'b', { host: 'b', protocol: 'TLSv1.1' });
    assert.equal(r.changed, true);
    assert.deepEqual((await snapshots('b')).map((s) => s.payload.protocol), ['TLSv1.3', 'TLSv1.1']);
    assert.equal((await snapshots('c')).length, 1);
});
