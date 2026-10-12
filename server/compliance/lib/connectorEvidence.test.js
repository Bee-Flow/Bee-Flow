'use strict';

/**
 * connectorEvidence — a failed store read is a warn naming only the SQLSTATE,
 * a disabled connector reads no snapshots, and the configured subject is
 * picked by exact subject_id.
 *
 * Run: cd server && node --test compliance/lib/connectorEvidence.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { unreadableConnector, readConnector, snapshotFor } = require('./connectorEvidence');

test('a failed read warns with the SQLSTATE and no driver message', async () => {
    const err = Object.assign(new Error('canceling statement: SELECT … acme'), { code: '57014' });
    const r = await readConnector({ getConfig: async () => { throw err; } }, 'org1', 'afas');
    assert.equal(r.failed.status, 'warn');
    assert.deepEqual(r.failed.evidence, { connector: 'afas', readable: false, error_code: '57014' });
    assert.match(r.failed.details, /SQL state 57014/);
    assert.ok(!JSON.stringify(r.failed).includes('acme'));
    assert.equal(unreadableConnector('afas', new Error('x')).evidence.error_code, null);
});

test('a snapshot read failure is a failure too, not "no snapshot yet"', async () => {
    const store = {
        getConfig: async () => ({ enabled: true }),
        listLatestSnapshots: async () => { throw Object.assign(new Error('x'), { code: '08006' }); },
    };
    const r = await readConnector(store, 'org1', 'youtrack');
    assert.equal(r.failed.status, 'warn');
});

test('a disabled connector does not read snapshots', async () => {
    let read = false;
    const store = { getConfig: async () => ({ enabled: false }), listLatestSnapshots: async () => { read = true; return []; } };
    const r = await readConnector(store, 'org1', 'afas');
    assert.equal(r.config.enabled, false);
    assert.deepEqual(r.snaps, []);
    assert.equal(read, false);
});

test('snapshotFor picks the configured subject, never the first row', () => {
    const snaps = [{ subject_id: 'CHG' }, { subject_id: 'OPS' }];
    assert.equal(snapshotFor(snaps, 'OPS'), snaps[1]);
    assert.equal(snapshotFor(snaps, 'NONE'), null);
    assert.equal(snapshotFor(snaps, ''), null);
});
