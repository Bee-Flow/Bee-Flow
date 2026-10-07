'use strict';

/**
 * ISO27001-A.6.5-offboarding-feed — a failed store read warns instead of
 * reading as "not enabled"; the snapshot judged is the configured
 * GetConnector's, not the alphabetically first one; and a truncated page is
 * reported as "at least N" rows.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a6-5-offboarding-feed.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
const check = require('./a6-5-offboarding-feed');

const saved = { getConfig: isoEvidenceStore.getConfig, listLatestSnapshots: isoEvidenceStore.listLatestSnapshots };
afterEach(() => Object.assign(isoEvidenceStore, saved));

function stub(config, snaps = []) {
    isoEvidenceStore.getConfig = async () => (typeof config === 'function' ? config() : config);
    isoEvidenceStore.listLatestSnapshots = async () => snaps;
}

const feed = (name, payload) => ({ subject_id: name, payload: { source: 'afas', connector: name, fields: ['EmployeeId'], fetched: true, ...payload } });

test('a config read that fails warns; it is not "connector not enabled"', async () => {
    stub(() => { throw Object.assign(new Error('x'), { code: '57014' }); });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.error_code, '57014');
});

test('the configured GetConnector is judged, not the first subject in the list', async () => {
    // 'Old_Feed' sorts before 'Profit_Employees' and returned nothing.
    stub({ enabled: true, settings: { connector: ' Profit_Employees ' } }, [feed('Old_Feed', { rows: 0 }), feed('Profit_Employees', { rows: 42 })]);
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.connector, 'Profit_Employees');
    stub({ enabled: true, settings: { connector: 'New_Feed' } }, [feed('Profit_Employees', { rows: 42 })]);
    assert.equal((await check.evaluate('org1')).status, 'warn');
});

test('a truncated page reads as "at least" that many rows', async () => {
    stub({ enabled: true, settings: { connector: 'Profit_Employees' } }, [feed('Profit_Employees', { rows: 100, truncated: true })]);
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.truncated, true);
    assert.match(r.details, /at least 100 row/);
});
