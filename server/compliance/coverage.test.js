'use strict';
/**
 * coverage — the pure coverage rows. Pinned here: a listing that failed or
 * hung is unknown coverage (a warn, total null, never 0), and a failure
 * records the error's class and code, never its message.
 *
 * Run: cd server && node --test compliance/coverage.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coverageFailure, coverageVerdict, COVERAGE_SCOPE } = require('./coverage');

const CHECK = { id: 'GDPR-Art30-x', remediationLink: 'admin/compliance/ropa' };

test('a listing that threw is unknown coverage with the class and code only', () => {
    const e = Object.assign(new Error('invalid input syntax for type uuid: "jan@example.com"'), { code: '22P02' });
    const r = coverageFailure(CHECK, e, null);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.unknown, true);
    assert.equal(r.evidence.total, null, 'not 0: we do not know that it is 0');
    assert.equal(r.evidence.error, 'coverage_exception');
    assert.equal(r.evidence.error_name, 'Error');
    assert.equal(r.evidence.error_code, '22P02');
    assert.equal(r.evidence.link, 'admin/compliance/ropa');
    assert.match(r.details, /the population could not be read/);
    assert.ok(!JSON.stringify(r).includes('jan@example.com'));
});

test('a listing that timed out says so with the budget, from our own text', () => {
    const r = coverageFailure(CHECK, Object.assign(new Error('anything'), { code: 'check_timeout' }), '30 s');
    assert.equal(r.evidence.error, 'coverage timed out after 30 s');
    assert.match(r.details, /timed out after 30 s/);
    assert.ok(!JSON.stringify(r).includes('anything'));
});

test('the coverage verdict still names what was never examined', () => {
    const r = coverageVerdict(CHECK, { kind: 'datatable', label: 'Studio tables', total: 2, examined: 1, unexamined: [{ id: 't2', label: 'Leads' }] });
    assert.equal(r.status, 'warn');
    assert.match(r.details, /"Leads"/);
    assert.equal(COVERAGE_SCOPE, 'coverage');
});
