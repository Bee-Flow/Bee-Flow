/**
 * GDPR Art. 17: the warning reads the open requests' own deadlines.
 *
 * The average fulfilment time is over CLOSED requests, so it says nothing
 * about how old an open one is: a request on day 29 used to pass behind a
 * 10-day history, and a request opened yesterday warned behind a 26-day one.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art17-dsr-deletion.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const state = { stats: null };
const restore = installResolveStub({
    '../../../stores/dsrStore': { async getSlaStats() { return state.stats; } },
});
const check = require('./art17-dsr-deletion');
test.after(() => restore());

test('an open request due within 5 days warns, whatever the history averages', async () => {
    state.stats = { total: 3, fulfilled: 2, open: 1, overdue: 0, nearing: 1, avg_days_to_fulfil: 10 };
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /1 erasure request\(s\) are due within 5 days/);
});

test('a slow history does not warn about a request with time to spare', async () => {
    state.stats = { total: 3, fulfilled: 2, open: 1, overdue: 0, nearing: 0, avg_days_to_fulfil: 26 };
    assert.equal((await check.evaluate('orgA')).status, 'pass');
});

test('an overdue request still fails first', async () => {
    state.stats = { total: 3, fulfilled: 2, open: 2, overdue: 1, nearing: 1, avg_days_to_fulfil: 10 };
    assert.equal((await check.evaluate('orgA')).status, 'fail');
});
