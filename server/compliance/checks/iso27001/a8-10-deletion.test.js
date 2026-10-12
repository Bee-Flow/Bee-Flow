'use strict';

/**
 * ISO27001-A.8.10-deletion — an erasure request that is still open and past
 * its deadline fails the check even when it was received more than 12 months
 * ago (the statistics window filters on created_at), and a ledger error
 * carries the SQLSTATE, never the driver message.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-10-deletion.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const complianceStore = require('../../../stores/complianceStore');
const dsrStore = require('../../../stores/dsrStore');
const check = require('./a8-10-deletion');

const DAY = 86400000;
const saved = {
    getSettings: complianceStore.getSettings,
    getSlaStats: dsrStore.getSlaStats,
    listOpenWithDeadlines: dsrStore.listOpenWithDeadlines,
};
afterEach(() => {
    complianceStore.getSettings = saved.getSettings;
    dsrStore.getSlaStats = saved.getSlaStats;
    dsrStore.listOpenWithDeadlines = saved.listOpenWithDeadlines;
});

function stub({ open = [], stats = { total: 0, open: 0, overdue: 0, fulfilled: 0 } } = {}) {
    complianceStore.getSettings = async () => ({ last_retention_run_at: new Date(Date.now() - 3600 * 1000).toISOString() });
    dsrStore.getSlaStats = async () => (typeof stats === 'function' ? stats() : stats);
    dsrStore.listOpenWithDeadlines = async () => open;
}

test('an erasure request open and overdue for more than a year fails', async () => {
    stub({ open: [{ request_type: 'deletion', status: 'pending', due_at: new Date(Date.now() - 400 * DAY).toISOString() }] });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.deletion_requests_overdue, 1);
    assert.match(r.details, /past their deadline \(one month from receipt, or three months when extended\)/);
});

test('an overdue request of another type, or one not yet due, does not fail A.8.10', async () => {
    stub({ open: [
        { request_type: 'access', status: 'pending', due_at: new Date(Date.now() - 10 * DAY).toISOString() },
        { request_type: 'deletion', status: 'in_progress', due_at: new Date(Date.now() + 10 * DAY).toISOString() },
    ] });
    assert.equal((await check.evaluate('org1')).status, 'pass');
});

test('a ledger read that fails warns with the SQLSTATE only', async () => {
    stub({ stats: () => { throw Object.assign(new Error('relation "dsr_requests" … subject@example.com'), { code: '57014' }); } });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.dsr_ledger_error, '57014');
    assert.ok(!JSON.stringify(r).includes('example.com'));
});
