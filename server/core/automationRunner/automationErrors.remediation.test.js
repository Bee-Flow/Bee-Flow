// @typecheck
/** Run: node --test core/automationRunner/automationErrors.remediation.test.js */
const test = require('node:test');
const assert = require('node:assert');
const { remediationFor } = require('./automationErrors');

test('a stop_error has no remediation: the author\'s message is the cause', () => {
    assert.strictEqual(remediationFor('stop_error'), '');
});

test('an unreachable http target is not told to check a room token', () => {
    assert.doesNotMatch(remediationFor('http_unreachable'), /room token/);
    assert.match(remediationFor('http_unreachable'), /reachable/);
});

test('other classes keep their remediation', () => {
    assert.match(remediationFor('IntegrationError'), /room token/);
    assert.match(remediationFor('nope'), /run history/);
});
