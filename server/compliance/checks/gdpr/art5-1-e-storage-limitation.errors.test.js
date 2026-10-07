'use strict';

/**
 * GDPR-Art5-1-e-storage-limitation — a failed count is not a missing table.
 *
 * Only 42P01/42703 mean "user_memories is not provisioned yet"
 * (not_applicable). Any other failure — a timeout, a dropped connection — is
 * a failed read: not_applicable would drop the check out of the score and
 * hide an orphan warning, so it warns with the SQLSTATE. And a stale
 * heartbeat still fails first, whatever the count did.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art5-1-e-storage-limitation.errors.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const state = { error: null, settings: {} };
const restore = installResolveStub({
    '../../../db': { async getOne() { if (state.error) throw state.error; return { c: 0 }; } },
    '../../../stores/complianceStore': { async getSettings() { return state.settings; } },
});
const check = require('./art5-1-e-storage-limitation');
test.after(() => restore());

const fresh = () => ({ last_retention_run_at: new Date().toISOString() });
const pgError = (code) => Object.assign(new Error('canceling statement due to statement timeout'), { code });

test('a count that fails for another reason warns with the SQLSTATE', async () => {
    state.settings = fresh();
    state.error = pgError('57014');
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.sqlstate, '57014');
    assert.ok(!JSON.stringify(r).includes('canceling statement'), 'the raw error message stays out of the evidence');
});

test('a missing table is still "not provisioned yet"', async () => {
    state.settings = fresh();
    state.error = pgError('42P01');
    assert.equal((await check.evaluate('orgA')).status, 'not_applicable');
    state.error = pgError('42703');
    assert.equal((await check.evaluate('orgA')).status, 'not_applicable');
});

test('a stale heartbeat still fails when the count cannot be read', async () => {
    state.settings = {};
    state.error = pgError('57014');
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.orphan_memories, null, 'an unread count is not zero');
});
