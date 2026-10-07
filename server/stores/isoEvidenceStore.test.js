'use strict';

/**
 * isoEvidenceStore — the snapshot hash leaves out the elapsed-time fields
 * (days_remaining, oldest_open_days, …), so a day passing is not drift; and
 * an unchanged snapshot still gets the fresh payload, so a check never judges
 * a stored first-day age.
 *
 * The store destructures run/getOne from db at require time, so they are
 * replaced on the real db singleton BEFORE the store is required, and
 * db.makeStoreInit (the documented seam, stores/lib/storeInit.js) turns schema
 * creation into a no-op.
 *
 * Run: cd server && node --test stores/isoEvidenceStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const runs = [];
let prev = null;
db.makeStoreInit = () => async () => {};
db.run = async (sql, params) => { runs.push({ sql, params }); return { rowCount: 1, rows: [] }; };
db.getOne = async () => prev;

const store = require('./isoEvidenceStore');

beforeEach(() => { runs.length = 0; prev = null; });

test('a payload that differs only in an elapsed-time field hashes the same', () => {
    const { hashPayload } = store;
    assert.equal(hashPayload({ host: 'a', days_remaining: 40 }), hashPayload({ host: 'a', days_remaining: 39 }));
    assert.equal(
        hashPayload({ repo: 'r', dependabot: { open_total: 2, oldest_open_days: 5, oldest_high_critical_days: 3 } }),
        hashPayload({ repo: 'r', dependabot: { open_total: 2, oldest_open_days: 6, oldest_high_critical_days: 4 } }));
    assert.equal(hashPayload({ servers: 2, newest_backup_age_days: 1 }), hashPayload({ servers: 2, newest_backup_age_days: 2 }));
    assert.notEqual(hashPayload({ host: 'a', days_remaining: 40 }), hashPayload({ host: 'b', days_remaining: 40 }));
});

test('an unchanged snapshot refreshes the stored payload, so the ages stay current', async () => {
    const p1 = { host: 'a', days_remaining: 40 };
    const p2 = { host: 'a', days_remaining: 39 };
    prev = { hash: store.hashPayload(p1) };
    const r = await store.saveSnapshot('org1', 'tls-endpoints', 'a', p2);
    assert.equal(r.changed, false);
    assert.equal(runs.length, 1);
    assert.match(runs[0].sql, /^\s*UPDATE iso_evidence_snapshots SET fetched_at = NOW\(\), payload = \$4::jsonb/);
    assert.deepEqual(runs[0].params, ['org1', 'tls-endpoints', 'a', JSON.stringify(p2)]);
});

test('a real change inserts a new snapshot and reports drift', async () => {
    prev = { hash: store.hashPayload({ host: 'a', protocol: 'TLSv1.3' }) };
    const r = await store.saveSnapshot('org1', 'tls-endpoints', 'a', { host: 'a', protocol: 'TLSv1.1' });
    assert.equal(r.changed, true);
    assert.match(runs[0].sql, /INSERT INTO iso_evidence_snapshots/);
});
