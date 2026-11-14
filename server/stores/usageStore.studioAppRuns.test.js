'use strict';

/**
 * "N actions this month" per App Studio app (APPS-08).
 *
 * The number comes from `ai_usage_log`, where routes/studioAppsRun.js writes one row per
 * action run. Two things can break there, both silently and independently:
 *
 *   • the SOURCE can be renamed on one side (the runtime writes 'studio_app_action', the query
 *     looks for something else) — then every app counts zero and the whole screen looks dead;
 *   • the FILTER can shift to the viewer. Every row is on the OWNER of the app, so as soon as
 *     `user_id = <viewer>` is in the where, everyone except the builder sees zero. That is
 *     precisely the trap in the finding, and it is not visible in the answer: zero is a valid
 *     number.
 *
 * The counts run against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js, with the usage store's own schema).
 *
 * Run: cd server && node --test stores/usageStore.studioAppRuns.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, query, close } = usePglitePool();
const usageStore = require('./usageStore');

const RUN_ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'studioAppsRun.js'), 'utf8');
// The row itself is built in one place now (usecases/studioAppsRunUsage.js); the
// route's two action endpoints call it.
const USAGE_MODULE = fs.readFileSync(path.join(__dirname, '..', 'usecases', 'studioAppsRunUsage.js'), 'utf8');

test('the store and the run bridge name the SAME source', () => {
    // Genuinely textual: usecases/studioAppsRunUsage.js hardcodes the literal
    // string on purpose (the default `source` of actionUsageRow) rather than
    // importing usageStore.STUDIO_APP_ACTION_SOURCE — so a store does not need
    // to pull anything from the runtime. There is no shared reference to check
    // by identity; the two literals only have to agree by VALUE, and reading
    // the source is the only way to compare them.
    //
    // Counted, not just matched: the route has two action endpoints (the
    // 'step' and the 'run' actions) and both must write their row through the
    // one builder, so a second copy with its own literal cannot creep back in.
    assert.strictEqual(usageStore.STUDIO_APP_ACTION_SOURCE, 'studio_app_action');
    const sourceHits = USAGE_MODULE.match(/source = 'studio_app_action'/g) || [];
    const agentIdHits = USAGE_MODULE.match(/agent_id: app\.id/g) || [];
    const callSites = RUN_ROUTE.match(/logActionUsage\(/g) || [];
    assert.strictEqual(sourceHits.length, 1, 'the row builder names this source as its default, once');
    assert.strictEqual(agentIdHits.length, 1, 'the row carries the APP as agent_id: that is what this query sums');
    assert.strictEqual(callSites.length, 2, 'both action endpoints of the run route write their row through the builder');
});

/** One ai_usage_log row. */
async function usage(agentId, source, userId, when = 'NOW()') {
    await pg.query(
        `INSERT INTO ai_usage_log (timestamp, user_id, agent_id, model, prompt_tokens, completion_tokens, total_tokens, source)
         VALUES (${when}, $1, $2, 'm', 1, 1, 2, $3)`, [userId, agentId, source]);
}

test.before(async () => {
    await usageStore.initDB();
    // Every row is on the OWNER of the app, whoever pressed the button.
    for (let i = 0; i < 12; i++) await usage('app-1', 'studio_app_action', 'owner');
    await usage('app-1', 'chat', 'owner');
    await usage('app-1', 'studio_app_action', 'owner', "date_trunc('month', NOW()) - INTERVAL '1 day'");
    await usage('someone-elses-app', 'studio_app_action', 'other');
});
test.after(close);

test('counts action runs of the asked apps this month, whoever is looking', async () => {
    const out = await usageStore.getStudioAppRunCounts(['app-1', 'app-2'], { db: { query } });
    assert.strictEqual(out.get('app-1'), 12, 'not the chat row, not last month');
    assert.strictEqual(out.get('app-2'), 0, 'an app nobody pressed is a fact, not a gap');
    assert.strictEqual((await usageStore.getStudioAppRunCounts(['app-1'])).get('app-1'), 12, 'the default path reads the same');
});

test('the window list is closed: an unknown window is refused, never answered as a month', async () => {
    assert.deepStrictEqual(Object.keys(usageStore.RUN_COUNT_WINDOWS), ['month']);
    await assert.rejects(() => usageStore.getStudioAppRunCounts(['app-1'], { window: 'week', db: { query } }), /unknown window/);
    await assert.rejects(() => usageStore.getStudioAppRunCounts(['app-1'], { window: "x') OR true --", db: { query } }), /unknown window/,
        'the window is a key in a closed list, never text that goes into the query');
});

test('an empty or junk id list answers an empty map', async () => {
    for (const ids of [[], null, undefined, [null, '', false]]) {
        assert.strictEqual((await usageStore.getStudioAppRunCounts(/** @type {any} */ (ids), { db: { query } })).size, 0);
    }
});

test('an app nobody asked about stays out, and duplicate ids are answered once', async () => {
    assert.deepStrictEqual([...(await usageStore.getStudioAppRunCounts(['app-1', 'app-1'], { db: { query } })).entries()], [['app-1', 12]]);
});
