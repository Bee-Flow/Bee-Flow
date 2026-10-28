/**
 * The compatibility gate compares a package's min/max_app_version with the
 * version a release stamped (APP_VERSION). It used to fall back to the
 * repository root package.json, which has no version; an unstamped build now
 * skips the semver bounds on purpose (server/package.json is frozen at 1.0.0).
 *
 * Run: node --test modules/packageStaging.compat.test.js
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert');

require('./packageLoader'); // wires the dependency seam
const { _compatCheck } = require('./packageStaging');

const saved = process.env.APP_VERSION;
afterEach(() => { if (saved === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = saved; });

test('a package that needs a newer product than this server is incompatible', () => {
    process.env.APP_VERSION = '2.3.0';
    assert.throws(
        () => _compatCheck({ min_app_version: '999.0.0' }),
        (e) => e.compat === true && /requires product >= 999\.0\.0 \(have 2\.3\.0\)/.test(e.message),
    );
});

test('a package whose max_app_version is below this server is incompatible', () => {
    process.env.APP_VERSION = '2.3.0';
    assert.throws(() => _compatCheck({ max_app_version: '0.0.1' }), (e) => e.compat === true);
});

test('a package within range passes', () => {
    process.env.APP_VERSION = '2.3.0';
    assert.doesNotThrow(() => _compatCheck({ min_app_version: '0.0.1', max_app_version: '3.0.0' }));
});

test('an unstamped build skips the semver bounds instead of grading the frozen 1.0.0', () => {
    delete process.env.APP_VERSION;
    assert.doesNotThrow(() => _compatCheck({ min_app_version: '999.0.0' }));
});

test('unstamped build: a module that needs a newer product is NOT refused (bounds skipped on purpose, one warning)', (t) => {
    delete process.env.APP_VERSION;
    require('./appVersion')._resetWarned();
    const warn = t.mock.method(require('../telemetry/log'), 'warn', () => {});
    assert.doesNotThrow(() => _compatCheck({ min_app_version: '999.0.0', max_app_version: '0.0.1' }));
    assert.equal(warn.mock.callCount(), 1);
});
