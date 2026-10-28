const test = require('node:test');
const assert = require('node:assert/strict');

const { productVersion, _resetWarned } = require('./appVersion');
const log = require('../telemetry/log');

const saved = process.env.APP_VERSION;
test.afterEach(() => { if (saved === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = saved; });

test('a stamped APP_VERSION is the product version, trimmed', () => {
    process.env.APP_VERSION = ' 2026.10.23 ';
    assert.equal(productVersion(), '2026.10.23');
});

test('unstamped: null, with one warning per process', (t) => {
    delete process.env.APP_VERSION;
    _resetWarned();
    const warn = t.mock.method(log, 'warn', () => {});
    assert.equal(productVersion(), null);
    assert.equal(productVersion(), null);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /APP_VERSION is not set/);
});
