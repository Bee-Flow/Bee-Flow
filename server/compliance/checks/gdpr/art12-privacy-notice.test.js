// @typecheck strict
/**
 * GDPR Art. 12: a privacy-notice address without a scheme still fails, but it
 * is on record, so the check must not claim that nothing is set.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art12-privacy-notice.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const state = { settings: {} };
// The real complianceStore over a recording pool; its settings row is what getSettings used to be stubbed to.
require('../../../testUtils/routeHarness').recordDb((sql, params) => (/FROM compliance_settings/i.test(sql)
    ? { rows: [((_orgId) => state.settings)(params && params[0])] }
    : undefined));
const check = require('./art12-privacy-notice');

test('an address without a scheme fails with what is wrong with it, not "not set"', async () => {
    state.settings = { privacy_notice_url: 'www.acme.eu/privacy' };
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'fail');
    assert.doesNotMatch(r.details, /No privacy-notice URL set/);
    assert.match(r.details, /https:\/\//);
});

test('an empty value keeps the "not set" wording', async () => {
    state.settings = { privacy_notice_url: '   ' };
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'fail');
    assert.match(r.details, /No privacy-notice URL set/);
});

test('a full web address passes', async () => {
    state.settings = { privacy_notice_url: 'https://acme.eu/privacy' };
    assert.equal((await check.evaluate('orgA')).status, 'pass');
});
