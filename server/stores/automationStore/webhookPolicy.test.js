/**
 * The operator's knobs of the automation webhook trigger
 * (stores/automationStore/webhookPolicy.mts) and the limiter they size
 * (utils/perUserRateLimit.js limiterUnlessZero): a generous default when a
 * variable is unset or unreadable, the number when it is set, and 0 = no limit.
 *
 * Run: cd server && node --test stores/automationStore/webhookPolicy.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { automationWebhookLimits, AUTOMATION_WEBHOOK_ENV } = require('./webhookPolicy.mts');
const { limiterUnlessZero } = require('../../utils/perUserRateLimit');

test('unset, blank and unreadable values give the defaults', () => {
    const defaults = Object.fromEntries(Object.entries(AUTOMATION_WEBHOOK_ENV).map(([key, { fallback }]) => [key, fallback]));
    assert.deepStrictEqual(automationWebhookLimits({}), defaults);
    const odd = Object.fromEntries(Object.values(AUTOMATION_WEBHOOK_ENV).map(({ env }, i) => [env, ['', '  ', 'many', '-5'][i % 4]]));
    assert.deepStrictEqual(automationWebhookLimits(odd), defaults);
    assert.strictEqual(defaults.rpmPerSlug, 120);
    assert.strictEqual(defaults.rpmPerIp, 300);
    assert.strictEqual(defaults.eventsRpmPerIp, 600);
});

test('a set value is used, and 0 stays 0', () => {
    const limits = automationWebhookLimits({ AUTOMATION_WEBHOOK_RPM_PER_SLUG: '7', AUTOMATION_WEBHOOK_RPM_PER_IP: '0', AUTOMATION_EVENTS_RPM_PER_IP: '12.9' });
    assert.strictEqual(limits.rpmPerSlug, 7);
    assert.strictEqual(limits.rpmPerIp, 0);
    assert.strictEqual(limits.eventsRpmPerIp, 12);
});

/** Send `n` requests under one key; the statuses that came back (200 = passed on). */
async function send(limiter, n) {
    const statuses = [];
    for (let i = 0; i < n; i++) {
        await new Promise((resolve) => {
            const res = {
                set() { return res; },
                status(code) { return { json() { statuses.push(code); resolve(); } }; },
            };
            limiter({ ip: '203.0.113.9', session: {} }, res, () => { statuses.push(200); resolve(); });
        });
    }
    return statuses;
}

test('a limit of 0 lets every request through; any other number is the ceiling per window', async () => {
    const key = () => 'one-sender';
    assert.deepStrictEqual(await send(limiterUnlessZero({ max: 0, keyFn: key }), 50), new Array(50).fill(200));
    assert.deepStrictEqual(await send(limiterUnlessZero({ max: 2, keyFn: key }), 4), [200, 200, 429, 429]);
});
