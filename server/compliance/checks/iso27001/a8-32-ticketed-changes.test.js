'use strict';

/**
 * ISO27001-A.8.32-ticketed-changes — the snapshot judged is the configured
 * project's. listLatestSnapshots orders by subject_id, and a project that was
 * configured before keeps its last snapshot, so the first row can be stale.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-32-ticketed-changes.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
const check = require('./a8-32-ticketed-changes');

const saved = { getConfig: isoEvidenceStore.getConfig, listLatestSnapshots: isoEvidenceStore.listLatestSnapshots };
afterEach(() => Object.assign(isoEvidenceStore, saved));

const project = (key, recent) => ({ subject_id: key, payload: { source: 'youtrack', project: key, window_days: 30, recent_issues: recent, resolved_recent: 0 } });

test('the configured project is judged, not the alphabetically first one', async () => {
    isoEvidenceStore.getConfig = async () => ({ enabled: true, settings: { project: 'OPS' } });
    isoEvidenceStore.listLatestSnapshots = async () => [project('CHG', 0), project('OPS', 7)];
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.project, 'OPS');
});

test('no snapshot for the configured project yet warns', async () => {
    isoEvidenceStore.getConfig = async () => ({ enabled: true, settings: { project: 'NEW' } });
    isoEvidenceStore.listLatestSnapshots = async () => [project('OPS', 7)];
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /no snapshot for the configured project/);
});
