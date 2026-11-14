// @typecheck
/**
 * incidentStore — deadline math and input guards, against a real Postgres
 * (PGlite behind db.js's pool, testUtils/pglitePool.js, with the store's own
 * schema). The NIS2 / CRA / DORA clocks and stamps live in
 * incidentStore.cra.test.js.
 *
 * Run: cd server && node --test server/stores/incidentStore.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { close } = usePglitePool();
const store = require('./incidentStore');

before(() => store.initDB());
after(close);

const HOUR = 3600 * 1000;

test('createIncident derives deadline_at = detected_at + 72h', async () => {
    const detected = new Date('2026-07-01T10:00:00Z');
    const row = await store.createIncident({ organization_id: 'org1', title: 'Leak', detected_at: detected.toISOString() });
    assert.strictEqual(new Date(row.deadline_at).getTime() - new Date(row.detected_at).getTime(), 72 * HOUR);
    assert.strictEqual(new Date(row.detected_at).toISOString(), detected.toISOString());
});

test('createIncident requires org and title, and coerces an unknown severity to medium', async () => {
    await assert.rejects(() => store.createIncident(/** @type {any} */ ({ title: 'x' })), /organization_id/);
    await assert.rejects(() => store.createIncident(/** @type {any} */ ({ organization_id: 'o' })), /title/);
    const row = await store.createIncident({ organization_id: 'o', title: 'x', severity: 'catastrophic' });
    assert.strictEqual(row.severity, 'medium');
});

test('critical is a severity, not an unknown value that falls back to medium', async () => {
    // The picker in agent-hub offers it and the table has a tag for it.
    assert.strictEqual((await store.createIncident({ organization_id: 'o', title: 'x', severity: 'critical' })).severity, 'critical');
});

test('getDeadlineStats returns zeroed defaults for an organisation with nothing on file', async () => {
    assert.deepStrictEqual(await store.getDeadlineStats('org-empty'), {
        open: 0, overdue_unnotified: 0, nearing_deadline: 0, vulnerabilities_open: 0,
        gdpr_overdue_unnotified: 0, gdpr_nearing_deadline: 0,
    });
});

test('getDeadlineStats counts the Art. 33 clock on its own: GDPR incidents, detected_at + 72 h', async () => {
    // deadline_at is the earliest open clock over every regime (a NIS2 24 h
    // early warning), so it cannot tell whether the 72-hour GDPR deadline passed.
    const org = 'org-stats';
    const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
    await store.createIncident({ organization_id: org, title: 'GDPR overdue', detected_at: ago(80), regimes: ['GDPR'] });
    await store.createIncident({ organization_id: org, title: 'GDPR nearing', detected_at: ago(60), regimes: ['GDPR'] });
    await store.createIncident({ organization_id: org, title: 'GDPR fresh', detected_at: ago(1), regimes: ['GDPR'] });
    await store.createIncident({ organization_id: org, title: 'NIS2 only', detected_at: ago(80), regimes: ['NIS2'] });
    const stats = await store.getDeadlineStats(org);
    assert.strictEqual(stats.open, 4);
    assert.strictEqual(stats.gdpr_overdue_unnotified, 1);
    assert.strictEqual(stats.gdpr_nearing_deadline, 1);
    assert.strictEqual(stats.overdue_unnotified, 2, 'the roll-up count (counts.js, ISO A.5.24) reads deadline_at');
    assert.deepStrictEqual(await store.getDeadlineStats('org-empty'), {
        open: 0, overdue_unnotified: 0, nearing_deadline: 0, vulnerabilities_open: 0,
        gdpr_overdue_unnotified: 0, gdpr_nearing_deadline: 0,
    }, 'another organisation is not counted');
});

test('updateIncident returns null for an unknown incident, or one of another organisation', async () => {
    assert.strictEqual(await store.updateIncident('org1', 999999, { status: 'closed' }), null);
    const theirs = await store.createIncident({ organization_id: 'org-theirs', title: 'x' });
    assert.strictEqual(await store.updateIncident('org1', theirs.id, { status: 'closed' }), null);
    assert.notStrictEqual((await store.getIncident('org-theirs', theirs.id)).status, 'closed');
});

test('updateIncident re-stamps deadline_at from the clocks that are still open', async () => {
    // Art. 33 satisfied: nothing is due outside the organisation any more, so the
    // roll-up must not keep detected+72h and count as overdue for ever.
    const row = await store.createIncident({ organization_id: 'org1', title: 'Breach', regimes: ['GDPR'], detected_at: '2026-07-01T10:00:00Z' });
    assert.ok(row.deadline_at);
    const out = await store.updateIncident('org1', row.id, { status: 'authority_notified' }, 'u1');
    assert.strictEqual(out.deadline_at, null);
    const stored = await store.getIncident('org1', row.id);
    assert.strictEqual(stored.deadline_at, null);
    assert.ok(stored.authority_notified_at);
    assert.strictEqual(stored.authority_notified_by, 'u1');
});

test('updateIncident appends a note and keeps the existing status for an invalid one', async () => {
    const row = await store.createIncident({ organization_id: 'org1', title: 'Notes' });
    await store.updateIncident('org1', row.id, { status: 'not-a-status', note: 'checked backups' }, 'u1');
    await store.updateIncident('org1', row.id, { note: 'second' }, 'u2');
    const stored = await store.getIncident('org1', row.id);
    assert.strictEqual(stored.status, row.status, 'invalid status keeps existing');
    assert.deepStrictEqual(stored.notes.map((n) => [n.text, n.by]), [['checked backups', 'u1'], ['second', 'u2']]);
});
