/**
 * GET /api/studio/search (routes/studio/search.js): the automations kind on a real Postgres (the LIKE escape and the length cap reach its SQL). The module half of
 * search.test.js, owned by module automation (scripts/module-map.json); the set-up is shared
 * through search.testkit.js.
 *
 * Run: node --test routes/studio/search.automation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSearchRouter, MAX_QUERY_LENGTH } = require('./search');
const { studioApp, studioServer } = require('./studioServer.testkit');
const { sqlFixture } = require('./search.testkit');

const mount = (nextDeps) => studioApp(createSearchRouter(nextDeps), { errors: true });
const srv = studioServer(test);
const listen = srv.listen;
const get = (q = 'invoice', user = 'u1') => fetch(
    `${srv.baseUrl}/api/studio/search?q=${encodeURIComponent(q)}`,
    { headers: user ? { 'x-test-user': user } : {} },
);
const { realDeps, resetTables, automation, ids } = sqlFixture(test, ['automations']);

test('LIKE wildcards in the query are escaped, so "100%" searches for "100%"', async () => {
    await resetTables();
    const hit = await automation('Done 100% of it');
    await automation('Done 1000 times');
    await automation('A_B plan');
    const theirs = await automation('100% theirs', { user_id: 'u2' });
    await listen(mount(realDeps()));
    const body = await (await get('100%')).json();
    assert.deepStrictEqual(ids(body.results.automations), [hit.id], 'the % is a character, and another user\'s automation is not searched');
    assert.ok(theirs);
    assert.deepStrictEqual((await (await get('a_b')).json()).results.automations.map((r) => r.name), ['A_B plan']);
});

test('an over-long query is truncated rather than sent on', async () => {
    await resetTables();
    const exact = await automation('x'.repeat(MAX_QUERY_LENGTH));
    await listen(mount(realDeps()));
    const body = await (await get('x'.repeat(MAX_QUERY_LENGTH + 50))).json();
    assert.strictEqual(body.query.length, MAX_QUERY_LENGTH);
    assert.deepStrictEqual(ids(body.results.automations), [exact.id], 'the truncated query is what was searched');
});
