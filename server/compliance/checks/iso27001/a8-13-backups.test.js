'use strict';

/**
 * ISO27001-A.8.13-backups — a Scaleway summary read from a truncated listing
 * (more than 300 servers or snapshots in a zone) is partial evidence: warn,
 * never a pass.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-13-backups.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
const check = require('./a8-13-backups');

const saved = { getConfig: isoEvidenceStore.getConfig, listLatestSnapshots: isoEvidenceStore.listLatestSnapshots };
afterEach(() => Object.assign(isoEvidenceStore, saved));

function stub(summary) {
    isoEvidenceStore.getConfig = async () => ({ enabled: true });
    isoEvidenceStore.listLatestSnapshots = async () => [{ subject_id: 'summary', payload: summary }];
}

const healthy = { region: 'nl-ams', servers: 2, servers_with_backup: 2, newest_backup_age_days: 1 };

test('a truncated listing warns instead of passing', async () => {
    stub({ ...healthy, truncated: true });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.truncated, true);
    assert.match(r.details, /only the first 300 were read/);
});

test('a complete listing with fresh backups passes', async () => {
    stub(healthy);
    assert.equal((await check.evaluate('org1')).status, 'pass');
});
