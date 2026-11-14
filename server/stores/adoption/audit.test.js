// @typecheck
'use strict';
/**
 * The access-audit row of a reveal, against a real Postgres (PGlite behind the
 * store's injected db, testUtils/pgliteDb.js, with the real access_audit_log
 * DDL): an allow-listed payload, the action a caller names, and a failed write
 * that throws instead of being swallowed.
 *
 * Run: cd server && node --test stores/adoption/audit.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { usePglitePool } = require('../../testUtils/pglitePool');
const { recordReveal, REVEAL_ACTION, QUALITY_REVEAL_ACTION } = require('./audit');

// The table comes from the user store's own schema init, run once on the same PGlite.
const pool = usePglitePool();
const { pg, db } = pgliteDb(pool.pg);
const facade = { run: db.query };

test.before(async () => {
    await require('../user/schema').initDB();
    pool.restore();
});
test.after(() => pg.close());

const rowsOf = async (orgId) => (await pg.query(
    'SELECT action, target_type, target_id, organization_id, changed_by, old_values, new_values FROM access_audit_log WHERE organization_id = $1 ORDER BY created_at, id',
    [orgId],
)).rows;

test('the row carries the action, the organisation, the actor and only the allow-listed details', async () => {
    const details = /** @type {any} */ ({ startDate: 's', endDate: 'e', group: 'g1', limit: 50, names: ['Kim'], email: 'kim@x' });
    await recordReveal(facade, { orgId: 'o1', actorId: 'u1', details });
    const rows = await rowsOf('o1');
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(REVEAL_ACTION, 'usage_adoption_people_revealed');
    assert.deepEqual({ ...row, new_values: JSON.parse(row.new_values) }, {
        action: REVEAL_ACTION, target_type: 'organization', target_id: 'o1', organization_id: 'o1', changed_by: 'u1',
        old_values: null, new_values: { startDate: 's', endDate: 'e', group: 'g1', limit: 50 },
    });
});

test('a failed write throws', async () => {
    const down = { run: async () => { throw new Error('db down'); } };
    await assert.rejects(recordReveal(down, { orgId: 'o1', actorId: 'u1', details: { startDate: 's', endDate: 'e', group: null, limit: 1 } }), /db down/);
});

test('a caller can name the action; the default stays the Adoption reveal', async () => {
    const details = { startDate: 's', endDate: 'e', group: null, limit: 1 };
    await recordReveal(facade, { orgId: 'o2', actorId: 'u1', details, action: QUALITY_REVEAL_ACTION });
    await recordReveal(facade, { orgId: 'o2', actorId: 'u1', details });
    assert.deepEqual((await rowsOf('o2')).map((r) => r.action).sort(), [REVEAL_ACTION, 'usage_quality_people_revealed'].sort());
});
