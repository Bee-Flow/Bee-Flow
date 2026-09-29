/**
 * incidentStore — deadline math + input guards. Fake `db` injected into
 * require.cache so no Postgres is involved.
 *
 * The NIS2 / CRA / DORA clocks and stamps live in incidentStore.cra.test.js.
 *
 * Run: node --test server/stores/incidentStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const state = { calls: [], runRows: [], oneRow: null, allRows: [] };
const mockDb = {
    exec: async () => {},
    run: async (sql, params = []) => { state.calls.push({ fn: 'run', sql, params }); return { rowCount: 1, rows: state.runRows }; },
    getOne: async (sql, params = []) => { state.calls.push({ fn: 'getOne', sql, params }); return state.oneRow; },
    getAll: async (sql, params = []) => { state.calls.push({ fn: 'getAll', sql, params }); return state.allRows; },
    getClient: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const store = require('./incidentStore');

beforeEach(() => {
    state.calls = [];
    state.runRows = [];
    state.oneRow = null;
    state.allRows = [];
});

test('createIncident derives deadline_at = detected_at + 72h', async () => {
    const detected = new Date('2026-07-01T10:00:00Z');
    state.runRows = [{ id: 1 }];
    await store.createIncident({
        organization_id: 'org1', title: 'Leak', detected_at: detected.toISOString(),
    });
    const insert = state.calls.find(c => c.fn === 'run' && /INSERT INTO compliance_incidents/.test(c.sql));
    assert.ok(insert, 'insert issued');
    const detectedParam = insert.params[7];
    const deadlineParam = insert.params[8];
    assert.strictEqual(new Date(deadlineParam).getTime() - new Date(detectedParam).getTime(), 72 * 3600 * 1000);
});

test('createIncident requires org and title, coerces bad severity', async () => {
    await assert.rejects(() => store.createIncident({ title: 'x' }), /organization_id/);
    await assert.rejects(() => store.createIncident({ organization_id: 'o' }), /title/);
    state.runRows = [{ id: 2 }];
    await store.createIncident({ organization_id: 'o', title: 'x', severity: 'catastrophic' });
    const insert = state.calls.find(c => /INSERT INTO compliance_incidents/.test(c.sql));
    assert.strictEqual(insert.params[3], 'medium', 'unknown severity falls back to medium');
});

test('critical is a severity, not an unknown value that falls back to medium', async () => {
    // The picker in agent-hub offers it and the table has a tag for it; the
    // store used to know three steps, so every critical incident was filed
    // as medium.
    state.runRows = [{ id: 3 }];
    await store.createIncident({ organization_id: 'o', title: 'x', severity: 'critical' });
    const insert = state.calls.find(c => /INSERT INTO compliance_incidents/.test(c.sql));
    assert.strictEqual(insert.params[3], 'critical');
});

test('getDeadlineStats returns zeroed defaults when the query yields nothing', async () => {
    state.oneRow = null;
    const stats = await store.getDeadlineStats('org1');
    assert.deepStrictEqual(stats, { open: 0, overdue_unnotified: 0, nearing_deadline: 0, vulnerabilities_open: 0 });
});

test('updateIncident returns null for an unknown incident', async () => {
    state.oneRow = null;
    assert.strictEqual(await store.updateIncident('org1', 999, { status: 'closed' }), null);
});

test('updateIncident re-stamps deadline_at from the clocks that are still open', async () => {
    // The row as it reads back AFTER the status stamp: Art. 33 satisfied, so
    // nothing is due to anyone outside the organisation any more. Before the
    // roll-up was recomputed this row kept detected+72h and counted as
    // "overdue_unnotified" for ever.
    const detected = new Date('2026-07-01T10:00:00Z');
    state.oneRow = {
        id: 7, organization_id: 'org1', status: 'authority_notified', kind: 'breach',
        regimes: ['GDPR'], notes: [], detected_at: detected,
        deadline_at: new Date(detected.getTime() + 72 * 3600 * 1000),
        authority_notified_at: new Date('2026-07-02T09:00:00Z'),
    };
    const out = await store.updateIncident('org1', 7, { status: 'authority_notified' }, 'u1');
    const refresh = state.calls.find(c => c.fn === 'run' && /SET deadline_at = \$3/.test(c.sql));
    assert.ok(refresh, 'the roll-up is rewritten');
    assert.match(refresh.sql, /WHERE organization_id = \$1 AND id = \$2/);
    assert.deepStrictEqual([refresh.params[0], refresh.params[1], refresh.params[2]], ['org1', 7, null]);
    assert.strictEqual(out.deadline_at, null);
});

test('updateIncident appends a note and preserves invalid status as existing', async () => {
    state.oneRow = { id: 5, organization_id: 'org1', status: 'open', notes: [] };
    await store.updateIncident('org1', 5, { status: 'not-a-status', note: 'checked backups' }, 'u1');
    const update = state.calls.find(c => c.fn === 'run' && /UPDATE compliance_incidents/.test(c.sql));
    assert.ok(update, 'update issued');
    assert.strictEqual(update.params[6], 'open', 'invalid status keeps existing');
    const notes = JSON.parse(update.params[11]);
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].text, 'checked backups');
    assert.strictEqual(notes[0].by, 'u1');
});
