/**
 * AIA-Art26-6-log-retention — a ledger that could not be read is not "no
 * activity logs recorded yet".
 *
 * Run: cd server && node --test compliance/checks/aia/art26-6-log-retention.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

// Per table: a row, or an Error to throw.
const fx = { integration_activity_log: null, guardrail_events: null };
const restore = installResolveStub({
    '../../../db': {
        getOne: async (sql) => {
            const table = /FROM (\w+)/.exec(sql)[1];
            const v = fx[table];
            if (v instanceof Error) throw v;
            return v;
        },
    },
});
const check = require('./art26-6-log-retention');
test.after(restore);
test.beforeEach(() => { fx.integration_activity_log = null; fx.guardrail_events = null; });

function pgError(message, code) {
    return Object.assign(new Error(message), { code });
}

test('a failed read warns with the SQLSTATE only, never "no logs recorded yet"', async () => {
    fx.integration_activity_log = pgError('canceling statement due to statement timeout', '57014');
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.logs_readable, false);
    assert.deepEqual(r.evidence.error_codes, ['57014']);
    assert.match(r.details, /could not be read \(SQL state 57014\)/);
    assert.doesNotMatch(JSON.stringify(r), /statement timeout/, 'never the driver message');
});

test('a failed read next to a short span is still unknown, not a short span', async () => {
    fx.integration_activity_log = pgError('connection terminated', '08006');
    fx.guardrail_events = { age: 40 };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.error_codes, ['08006']);
    assert.match(r.details, /retention span is unknown/);
});

test('one readable ledger spanning six months settles the run even when the other failed', async () => {
    fx.integration_activity_log = pgError('connection terminated', '08006');
    fx.guardrail_events = { age: 210 };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.observed_span_days, 210);
    assert.equal(r.evidence.logs_readable, false);
});

test('not provisioned (42P01 / 42703) is still not_applicable', async () => {
    fx.integration_activity_log = pgError('relation does not exist', '42P01');
    fx.guardrail_events = pgError('column does not exist', '42703');
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.equal('logs_readable' in r.evidence, false);
});

test('six calendar months, not 180 days: the required span is 181–184 days depending on the date', () => {
    const { requiredDays } = check._test;
    assert.equal(requiredDays(Date.parse('2026-03-01T12:00:00Z')), 181, '1 Sep → 1 Mar');
    assert.equal(requiredDays(Date.parse('2027-01-01T12:00:00Z')), 184, '1 Jul → 1 Jan');
    assert.equal(requiredDays(Date.parse('2026-08-31T12:00:00Z')), 184, '28 Feb (clamped) → 31 Aug');
    assert.equal(requiredDays(Date.parse('2026-10-07T12:00:00Z')), 183);
});

test('a 180-day span never demonstrates six months; a 184-day span always does', async () => {
    fx.guardrail_events = { age: 180 };
    const short = await check.evaluate('org1');
    assert.equal(short.status, 'warn');
    assert.equal(short.evidence.required_months, 6);
    assert.ok(short.evidence.required_days >= 181 && short.evidence.required_days <= 184);
    fx.guardrail_events = { age: 184 };
    const long = await check.evaluate('org1');
    assert.equal(long.status, 'pass');
    assert.match(long.details, /six-month Art\. 26\(6\) retention window is demonstrated/);
});
