// @typecheck strict
/**
 * testUtils/requirePostgres.js: a database-dependent test skips without a
 * Postgres, and fails without one when REQUIRE_POSTGRES=1 says it must run.
 *
 * Run: node --test testUtils/requirePostgres.test.js
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { postgresSkipReason } = require('./requirePostgres');

const before = process.env.REQUIRE_POSTGRES;
afterEach(() => {
    if (before === undefined) delete process.env.REQUIRE_POSTGRES;
    else process.env.REQUIRE_POSTGRES = before;
});

test('without REQUIRE_POSTGRES an unreachable database is a reason to skip', () => {
    delete process.env.REQUIRE_POSTGRES;
    assert.strictEqual(
        postgresSkipReason('x.test', new Error('connect ECONNREFUSED 127.0.0.1:5432')),
        'Postgres unavailable, skipping: connect ECONNREFUSED 127.0.0.1:5432',
    );
    assert.strictEqual(postgresSkipReason('x.test', 'no route'), 'Postgres unavailable, skipping: no route');
});

test('with REQUIRE_POSTGRES=1 it throws, naming the test and keeping the cause', () => {
    process.env.REQUIRE_POSTGRES = '1';
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    assert.throws(
        () => postgresSkipReason('x.test', cause),
        (/** @type {Error} */ e) => {
            assert.strictEqual(e.message, '[x.test] REQUIRE_POSTGRES=1 but Postgres is unavailable: connect ECONNREFUSED 127.0.0.1:5432');
            assert.strictEqual(e.cause, cause);
            return true;
        },
    );
});

test('any other value of REQUIRE_POSTGRES still skips', () => {
    process.env.REQUIRE_POSTGRES = 'true';
    assert.match(postgresSkipReason('x.test', new Error('down')), /^Postgres unavailable, skipping: down$/);
});
