// @typecheck strict
/**
 * GET /api/ready: 503 until this process can serve, 200 when it can, 503 again
 * once it shuts down.
 *
 * The real router and the real schema probe run behind testUtils/routeHarness;
 * the database is the recording pool (each test says what it answers) and the
 * lifecycle is the real utils/runtimeState.mts, reset per test.
 *
 * Run: cd server && node --test routes/ready.test.js
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const h = require('../testUtils/routeHarness');

const SENTINELS = ['users', 'agents', 'automations', 'direct_conversations'];

/** What "the database" does in this test: 'up', 'unmigrated' or 'down'. */
let database = 'up';
const db = h.recordDb(() => {
    if (database === 'down') throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const present = database === 'unmigrated' ? SENTINELS.slice(0, 2) : SENTINELS;
    return { rows: present.map((table_name) => ({ table_name })) };
});

const state = require('../utils/runtimeState.mts');
const healthSchema = require('./healthSchema');
const api = h.serve('/api/ready', require('./ready'), { user: null });
after(api.close);

/** A process whose boot work has ended. */
function booted() {
    state.beginBoot();
}

beforeEach(() => {
    state._resetForTests();
    healthSchema._resetCache();
    db.reset();
    database = 'up';
});

test('not ready: 503 "starting" while the boot work runs, without asking the database', async () => {
    /** @type {() => void} */
    let finish = () => {};
    state.beginBoot();
    state.trackBootStep('data migrations', new Promise((resolve) => { finish = () => resolve(undefined); }));

    const before = await api.call('GET', '/api/ready');
    assert.strictEqual(before.status, 503);
    assert.deepStrictEqual(before.body, { ready: false, reason: 'starting' });
    assert.deepStrictEqual(db.all, [], 'a starting process is not ready whatever the database says');

    finish();
    await new Promise((resolve) => { setImmediate(resolve); });
    const afterBoot = await api.call('GET', '/api/ready');
    assert.strictEqual(afterBoot.status, 200);
    assert.deepStrictEqual(afterBoot.body, { ready: true });
});

test('not ready: 503 "starting" before the listener callback has run at all', async () => {
    const res = await api.call('GET', '/api/ready');
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, { ready: false, reason: 'starting' });
});

test('ready: 200 { ready: true } with the boot work done and the core tables there, with no session', async () => {
    booted();
    const res = await api.call('GET', '/api/ready');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ready: true });
});

test('a healthy answer is cached: a poller does not query the database on every probe', async () => {
    booted();
    await api.call('GET', '/api/ready');
    await api.call('GET', '/api/ready?t=123');
    const last = await api.call('GET', '/api/ready');
    assert.strictEqual(last.status, 200);
    assert.strictEqual(db.all.length, 1);
});

test('shutting down: 503 "shutting_down", also when it was ready a moment ago', async () => {
    booted();
    assert.strictEqual((await api.call('GET', '/api/ready')).status, 200);

    state.beginShutdown();
    const res = await api.call('GET', '/api/ready');
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, { ready: false, reason: 'shutting_down' });
});

test('database down: 503 "database" and nothing of the error in the body; 200 again once it answers', async (t) => {
    t.mock.method(console, 'warn', () => {});
    booted();
    database = 'down';
    const down = await api.call('GET', '/api/ready');
    assert.strictEqual(down.status, 503);
    assert.deepStrictEqual(down.body, { ready: false, reason: 'database' });
    assert.ok(!down.text.includes('ECONNREFUSED') && !down.text.includes('5432'), down.text);

    // The failure is cached, so a poller does not hammer a database that is down...
    database = 'up';
    assert.strictEqual((await api.call('GET', '/api/ready')).status, 503);
    assert.strictEqual(db.all.length, 1);

    // ...but for 2 s only, not for the 30 s of a healthy answer.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2001 });
    const up = await api.call('GET', '/api/ready');
    assert.strictEqual(up.status, 200);
    assert.deepStrictEqual(up.body, { ready: true });
    assert.strictEqual(db.all.length, 2);
});

test('database up but not migrated: 503 "schema", and no table name in the body', async () => {
    booted();
    database = 'unmigrated';
    const res = await api.call('GET', '/api/ready');
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.body, { ready: false, reason: 'schema' });
    for (const table of SENTINELS) assert.ok(!res.text.includes(table), res.text);
});

test('/api/health/schema keeps caching a failure for its full 30 s', async (t) => {
    t.mock.method(console, 'warn', () => {});
    database = 'down';
    assert.strictEqual((await healthSchema.getSchemaHealth()).ok, false);
    database = 'up';
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 29_000 });
    const still = await healthSchema.getSchemaHealth();
    assert.strictEqual(still.ok, false, 'its own callers do not get the short failure window of the readiness probe');
    assert.strictEqual(db.all.length, 1);
});
