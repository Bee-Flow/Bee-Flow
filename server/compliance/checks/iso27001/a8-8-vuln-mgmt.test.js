'use strict';

/**
 * ISO27001-A.8.8-vuln-mgmt — a pass covers the whole estate: a repository
 * whose Dependabot alerts are not readable, or whose alerts were cut off at
 * the first page, makes the result partial (warn), not a pass "across N".
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-8-vuln-mgmt.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
const check = require('./a8-8-vuln-mgmt');

const saved = { getConfig: isoEvidenceStore.getConfig, listLatestSnapshots: isoEvidenceStore.listLatestSnapshots };
afterEach(() => Object.assign(isoEvidenceStore, saved));

const clean = { critical: 0, high: 0, medium: 0, low: 0 };
function stub(payloads) {
    isoEvidenceStore.getConfig = async () => ({ enabled: true });
    isoEvidenceStore.listLatestSnapshots = async () => payloads.map(p => ({ subject_id: p.repo, payload: p }));
}

test('one clean repository and one with unreadable alerts warns instead of passing', async () => {
    stub([
        { repo: 'acme/a', dependabot: { accessible: true, by_severity: clean } },
        { repo: 'acme/b', dependabot: { accessible: false } },
    ]);
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.repos_without_alert_access, ['acme/b']);
    assert.match(r.details, /not readable on acme\/b/);
});

test('a repository read only up to the first page of alerts warns', async () => {
    stub([{ repo: 'acme/a', dependabot: { accessible: true, by_severity: clean, truncated: true } }]);
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.alerts_truncated, ['acme/a']);
});

test('every repository readable and clean passes', async () => {
    stub([{ repo: 'acme/a', dependabot: { accessible: true, by_severity: clean } }]);
    assert.equal((await check.evaluate('org1')).status, 'pass');
});
