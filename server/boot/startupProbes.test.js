// @typecheck strict
/**
 * The community pricing feed is fetched by boot, in the late warm-up phase, and
 * not because core/llm/modelCosts was required: a script, a generator or a test
 * that loads the cost registry opens no connection to GitHub.
 *
 * The other side of that rule is that a fetch nobody starts never happens, and
 * nothing would say so: usage is rated once, when it is written, so a model that
 * only the feed prices would be stored with an estimate from then on. This file
 * therefore holds both halves, with the global fetch replaced by a recorder
 * that answers with a one-model feed.
 *
 * Run: node --test boot/startupProbes.test.js
 */

process.env.NODE_ENV = 'test';
delete process.env.BROWSER_WARMUP;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const FEED_HOST = 'https://raw.githubusercontent.com/';
const FEED_KEY = 'review-host/review-model';

/** Every URL asked for while the recorder is in place. */
/** @type {string[]} */
const fetched = [];
const feedRequests = () => fetched.filter((url) => url.startsWith(FEED_HOST));

// Before the modules load: a fetch one of them started while loading is recorded too.
const realFetch = globalThis.fetch;
Object.assign(globalThis, {
    fetch: async (/** @type {unknown} */ url) => {
        fetched.push(String(url));
        return { ok: true, status: 200, json: async () => ({ [FEED_KEY]: { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 } }) };
    },
});
after(() => { globalThis.fetch = realFetch; });

const pricingService = require('../core/llm/pricingService');
const orgShield = require('../core/privacy/orgShield');
const { STARTUP_PHASES } = require('./startupTasks');
const { startLateWarmups } = require('./startupProbes');

/** Let what was started run to its end: the fetch and its JSON are promises, not timers. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('requiring the cost registry fetches nothing', async () => {
    require('../core/llm/modelCosts');
    await settle();

    assert.deepEqual(feedRequests(), []);
    assert.equal(pricingService.getPricingByKey(FEED_KEY), null, 'no feed in memory: lookups fall back to the repo snapshots');
});

test('the late warm-up phase of boot fetches the feed, once, and its prices are then served', async (t) => {
    // The phase's other work, kept off the database.
    t.mock.method(orgShield, 'selfCheckOrgShields', async () => {});
    assert.ok(STARTUP_PHASES.includes(startLateWarmups), 'the late warm-ups are a boot phase');

    startLateWarmups();
    await settle();

    assert.equal(feedRequests().length, 1);
    const rates = pricingService.getPricingByKey(FEED_KEY);
    assert.ok(rates, 'the feed that boot fetched answers an exact-key lookup');
    assert.equal(Math.round(rates.input), 2);
    assert.equal(Math.round(rates.output), 8);
});
