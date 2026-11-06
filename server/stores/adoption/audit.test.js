'use strict';
/**
 * The access-audit row of a reveal: an allow-listed payload, and a failed
 * write that throws instead of being swallowed.
 *
 * Run: cd server && node --test stores/adoption/audit.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordReveal, REVEAL_ACTION } = require('./audit');

test('the row carries the action, the organisation, the actor and only the allow-listed details', async () => {
    const calls = [];
    const db = { run: async (sql, params) => { calls.push({ sql, params }); } };
    const details = /** @type {any} */ ({ startDate: 's', endDate: 'e', group: 'g1', limit: 50, names: ['Kim'], email: 'kim@x' });
    await recordReveal(db, { orgId: 'o1', actorId: 'u1', details });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO access_audit_log/);
    const [, action, orgId, actorId, payload] = calls[0].params;
    assert.equal(action, REVEAL_ACTION);
    assert.equal(REVEAL_ACTION, 'usage_adoption_people_revealed');
    assert.equal(orgId, 'o1');
    assert.equal(actorId, 'u1');
    assert.deepEqual(JSON.parse(payload), { startDate: 's', endDate: 'e', group: 'g1', limit: 50 });
});

test('a failed write throws', async () => {
    const db = { run: async () => { throw new Error('db down'); } };
    await assert.rejects(recordReveal(db, { orgId: 'o1', actorId: 'u1', details: { startDate: 's', endDate: 'e', group: null, limit: 1 } }), /db down/);
});
