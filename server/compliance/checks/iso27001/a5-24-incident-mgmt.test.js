'use strict';

/**
 * ISO27001-A.5.24-incident-mgmt — an incident register that could not be read
 * warns; it never passes as "no incident is stuck past a deadline".
 *
 * Run: cd server && node --test compliance/checks/iso27001/a5-24-incident-mgmt.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const complianceStore = require('../../../stores/complianceStore');
const incidentStore = require('../../../stores/incidentStore');
const check = require('./a5-24-incident-mgmt');

const saved = {
    getSettings: complianceStore.getSettings,
    getDeadlineStats: incidentStore.getDeadlineStats,
    listNeedingAttention: incidentStore.listNeedingAttention,
};
afterEach(() => {
    complianceStore.getSettings = saved.getSettings;
    incidentStore.getDeadlineStats = saved.getDeadlineStats;
    incidentStore.listNeedingAttention = saved.listNeedingAttention;
});

function stub(deadlines) {
    complianceStore.getSettings = async () => ({ breach_recipients: ['dpo@example.com'] });
    incidentStore.getDeadlineStats = async () => (typeof deadlines === 'function' ? deadlines() : deadlines);
    incidentStore.listNeedingAttention = async () => [];
}

test('an unreadable register warns instead of passing', async () => {
    stub(() => { throw Object.assign(new Error('timeout'), { code: '57014' }); });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.registry_reachable, false);
    assert.match(r.details, /could not be read/);
});

test('a readable register with a recipient and nothing overdue passes', async () => {
    stub({ open: 0, overdue_unnotified: 0, nearing_deadline: 0 });
    assert.equal((await check.evaluate('org1')).status, 'pass');
});
