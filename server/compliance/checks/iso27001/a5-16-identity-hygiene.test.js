'use strict';

/**
 * ISO27001-A.5.16-identity-hygiene — a failed read of a connector's config or
 * snapshots warns instead of reading as "not enabled" (which leaves the score)
 * or "no snapshot yet", and never hides the other directory's verdict.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a5-16-identity-hygiene.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
const check = require('./a5-16-identity-hygiene');

const saved = { getConfig: isoEvidenceStore.getConfig, listLatestSnapshots: isoEvidenceStore.listLatestSnapshots };
afterEach(() => Object.assign(isoEvidenceStore, saved));

const boom = (code) => { throw Object.assign(new Error('connection terminated'), { code }); };

test('a config read that fails warns; it is not "no directory connector enabled"', async () => {
    isoEvidenceStore.getConfig = async () => boom('08006');
    isoEvidenceStore.listLatestSnapshots = async () => [];
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.error_code, '08006');
    assert.ok(!JSON.stringify(r).includes('terminated'), 'no driver message');
});

test('a snapshot read that fails warns, and a failing directory next to it still fails', async () => {
    isoEvidenceStore.getConfig = async () => ({ enabled: true });
    isoEvidenceStore.listLatestSnapshots = async (_org, id) => {
        if (id === 'google-workspace') boom('57014');
        return [{ subject_id: 'summary', payload: { users: 100, enabled: 100, dormant_90d: 50, mfa_enrolled: 100 } }];
    };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail', 'the Entra verdict is not downgraded by the Google read failure');
    assert.deepEqual(r.evidence.unreadable, [{ connector: 'google-workspace', error_code: '57014' }]);

    isoEvidenceStore.listLatestSnapshots = async () => boom('57014');
    const none = await check.evaluate('org1');
    assert.equal(none.status, 'warn');
    assert.match(none.details, /could not be read \(SQL state 57014\)/);
});
