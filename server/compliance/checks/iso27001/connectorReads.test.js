// @typecheck strict
'use strict';

/**
 * The connector-backed ISO 27001 checks must let a failing store read reach
 * the runner. A swallowed getConfig() error used to come back as
 * `not_applicable` ("connector not enabled") and a swallowed
 * listLatestSnapshots() error as "no snapshot yet": audit evidence that no
 * evaluation took place. The runner turns a thrown error into a
 * `check_exception` row (compliance/runner.js), so the checks rethrow.
 *
 * Run: cd server && node --test compliance/checks/iso27001/connectorReads.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

const CHECKS = [
    './a8-13-backups',
    './a8-16-monitoring',
    './a8-19-workplace-software',
    './a8-20-network-exposure',
    './a8-24-tls-endpoints',
    './a8-28-secure-coding',
    './a8-32-change-management',
    './a8-32-ticketed-changes',
    './a8-4-source-protection',
    './a8-8-vuln-mgmt',
];

const saved = { getConfig: isoEvidenceStore.getConfig, listLatestSnapshots: isoEvidenceStore.listLatestSnapshots };
afterEach(() => Object.assign(isoEvidenceStore, saved));

function dbError() {
    const e = new Error('connection terminated unexpectedly');
    e.code = '57P01';
    return e;
}

for (const path of CHECKS) {
    const check = require(path);

    test(`${check.id}: a failing config read throws instead of reporting not_applicable`, async () => {
        isoEvidenceStore.getConfig = async () => { throw dbError(); };
        isoEvidenceStore.listLatestSnapshots = async () => [];
        await assert.rejects(() => check.evaluate('org1'), { code: '57P01' });
    });

    test(`${check.id}: a failing snapshot read throws instead of reporting "no snapshot yet"`, async () => {
        isoEvidenceStore.getConfig = async () => ({ enabled: true, settings: { project: 'OPS' } });
        isoEvidenceStore.listLatestSnapshots = async () => { throw dbError(); };
        await assert.rejects(() => check.evaluate('org1'), { code: '57P01' });
    });

    test(`${check.id}: a disabled connector is still not_applicable`, async () => {
        isoEvidenceStore.getConfig = async () => null;
        isoEvidenceStore.listLatestSnapshots = async () => [];
        assert.equal((await check.evaluate('org1')).status, 'not_applicable');
    });
}
