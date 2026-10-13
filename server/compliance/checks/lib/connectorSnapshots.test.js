'use strict';

// Run: cd server && node --test compliance/checks/lib/connectorSnapshots.test.js

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
const { readConnectorSnapshots, noSnapshotYet } = require('./connectorSnapshots');

const saved = { getConfig: isoEvidenceStore.getConfig, listLatestSnapshots: isoEvidenceStore.listLatestSnapshots };
afterEach(() => Object.assign(isoEvidenceStore, saved));

test('a disabled connector returns the not_applicable result with the given text and reads no snapshots', async () => {
    let listed = false;
    isoEvidenceStore.getConfig = async () => ({ enabled: false });
    isoEvidenceStore.listLatestSnapshots = async () => { listed = true; return []; };
    const out = await readConnectorSnapshots('org1', 'github', 'GitHub off.');
    assert.deepEqual(out, {
        result: { status: 'not_applicable', evidence: { connector: 'github', enabled: false }, details: 'GitHub off.' },
    });
    assert.equal(listed, false);
});

test('a missing config is not_applicable too', async () => {
    isoEvidenceStore.getConfig = async () => null;
    const out = await readConnectorSnapshots('org1', 'scaleway', 'x');
    assert.equal(out.result.status, 'not_applicable');
});

test('an enabled connector returns its config and snapshots for that org and connector', async () => {
    const config = { enabled: true, settings: { project: 'OPS' } };
    const calls = [];
    isoEvidenceStore.getConfig = async (...a) => { calls.push(['config', ...a]); return config; };
    isoEvidenceStore.listLatestSnapshots = async (...a) => { calls.push(['snaps', ...a]); return [{ subject_id: 'OPS' }]; };
    const out = await readConnectorSnapshots('org1', 'youtrack', 'x');
    assert.deepEqual(out, { config, snaps: [{ subject_id: 'OPS' }] });
    assert.deepEqual(calls, [['config', 'org1', 'youtrack'], ['snaps', 'org1', 'youtrack']]);
});

test('store errors propagate', async () => {
    const err = Object.assign(new Error('down'), { code: '57P01' });
    isoEvidenceStore.getConfig = async () => { throw err; };
    await assert.rejects(() => readConnectorSnapshots('org1', 'github', 'x'), { code: '57P01' });
    isoEvidenceStore.getConfig = async () => ({ enabled: true });
    isoEvidenceStore.listLatestSnapshots = async () => { throw err; };
    await assert.rejects(() => readConnectorSnapshots('org1', 'github', 'x'), { code: '57P01' });
});

test('noSnapshotYet keeps the evidence shape and key order', () => {
    const r = noSnapshotYet('github', 'none yet');
    assert.deepEqual(r, { status: 'warn', evidence: { connector: 'github', enabled: true, snapshots: 0 }, details: 'none yet' });
    assert.deepEqual(Object.keys(r.evidence), ['connector', 'enabled', 'snapshots']);
    assert.deepEqual(noSnapshotYet('tls-endpoints', 'd', { endpoints: 0 }).evidence, { connector: 'tls-endpoints', enabled: true, endpoints: 0 });
});
