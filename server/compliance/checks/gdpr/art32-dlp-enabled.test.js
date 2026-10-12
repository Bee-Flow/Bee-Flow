/**
 * GDPR-Art32-dlp-enabled — the configuration layer and the words it uses.
 *
 * Pins the regression where a fully configured shield PASSED but its details
 * said "DLP is partially enabled": the wording compared against three layers
 * after content moderation (the third) had been removed.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art32-dlp-enabled.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const fx = { config: {}, events: { total_events: 3, blocked_events: 1, redacted_events: 2 }, aiCalls: 40 };

const restore = installResolveStub({
    '../../../db': {
        getOne: async (sql) => (/ai_usage_log/.test(sql) ? { c: fx.aiCalls } : { ...fx.events }),
    },
    '../../../stores/configStore': {
        getConfig: async (key) => fx.config[key] ?? null,
    },
});
const check = require('./art32-dlp-enabled');
test.after(restore);

test.beforeEach(() => {
    fx.config = {};
    fx.events = { total_events: 3, blocked_events: 1, redacted_events: 2 };
    fx.aiCalls = 40;
});

test('both layers on: pass, and the details say so', async () => {
    fx.config.org_privacy_shield_org1 = { enabled: true, collectionIds: ['c1'] };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.match(r.details, /both enabled/);
    assert.doesNotMatch(r.details, /partially/);
});

test('one layer on: warn, naming the layer that is missing', async () => {
    fx.config.org_privacy_shield_org1 = { enabled: true };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /partially enabled/);
    assert.match(r.details, /regex collection/);
    assert.doesNotMatch(r.details, /moderation/);
});

test('nothing on: fail', async () => {
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.match(r.details, /No DLP protection active/);
});

test('configured but silent on real traffic: warn', async () => {
    fx.config.org_privacy_shield_org1 = { enabled: true, collectionIds: ['c1'] };
    fx.events = { total_events: 0, blocked_events: 0, redacted_events: 0 };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /no guardrail events fired/);
});
