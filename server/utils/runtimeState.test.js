// @typecheck strict
/**
 * utils/runtimeState.mts: when this process calls itself ready.
 *
 * The state is one per process, so every test starts from _resetForTests().
 *
 * Run: cd server && node --test utils/runtimeState.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('./runtimeState.mts');

/** A promise with its resolve and reject on the outside. */
function deferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    /** @type {(reason: Error) => void} */
    let reject = () => {};
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Let the handlers trackBootStep attached run. */
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

beforeEach(() => {
    state._resetForTests();
    delete process.env[state.BOOT_READY_TIMEOUT_ENV];
});

test('a process that has not started its boot work is not ready', () => {
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'starting' });
});

test('boot work with no steps is ready as soon as it began', () => {
    state.beginBoot();
    assert.deepStrictEqual(state.readiness(), { ready: true });
});

test('ready waits until every tracked step has settled', async () => {
    const schemas = deferred();
    const migrations = deferred();
    state.beginBoot();
    state.trackBootStep('store schemas', schemas.promise);
    state.trackBootStep('migrations', migrations.promise);
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'starting' });

    schemas.resolve();
    await settle();
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'starting' }, 'one of two is not enough');

    migrations.resolve();
    await settle();
    assert.deepStrictEqual(state.readiness(), { ready: true });
    assert.deepStrictEqual(state.bootFailures(), []);
});

test('a failed step settles too: ready, with its name in bootFailures()', async () => {
    const migrations = deferred();
    state.beginBoot();
    state.trackBootStep('migrations', migrations.promise);
    state.trackBootStep('store schemas', Promise.resolve());

    migrations.reject(new Error('add-nl-x failed'));
    await settle();   // an unhandled rejection would end the test process here
    assert.deepStrictEqual(state.readiness(), { ready: true });
    assert.deepStrictEqual(state.bootFailures(), ['migrations']);
});

test('a step tracked again under the same name is not finished by the earlier one', async () => {
    const first = deferred();
    const second = deferred();
    state.beginBoot();
    state.trackBootStep('migrations', first.promise);
    state.trackBootStep('migrations', second.promise);

    first.reject(new Error('stale'));
    await settle();
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'starting' });
    assert.deepStrictEqual(state.bootFailures(), []);

    second.resolve();
    await settle();
    assert.deepStrictEqual(state.readiness(), { ready: true });
});

test('a step that never settles stops holding ready back after the time limit, with one error line', async (t) => {
    const error = t.mock.method(console, 'error', () => {});
    state.beginBoot(1_000_000);
    state.trackBootStep('migrations', new Promise(() => {}));
    state.trackBootStep('store schemas', Promise.resolve());
    await settle();

    const limit = state.DEFAULT_BOOT_READY_TIMEOUT_MS;
    assert.deepStrictEqual(state.readiness(1_000_000 + limit - 1), { ready: false, reason: 'starting' });
    assert.strictEqual(error.mock.callCount(), 0);

    assert.deepStrictEqual(state.readiness(1_000_000 + limit), { ready: true });
    assert.deepStrictEqual(state.readiness(1_000_000 + limit + 60_000), { ready: true });
    assert.strictEqual(error.mock.callCount(), 1, 'said once, not on every probe');
    const line = String(error.mock.calls[0].arguments[0]);
    assert.ok(line.includes('migrations'), line);
    assert.ok(!line.includes('store schemas'), 'only the step that is still running is named');
});

test('BOOT_READY_TIMEOUT_MS moves the time limit; the clock starts at the first beginBoot()', (t) => {
    t.mock.method(console, 'error', () => {});
    process.env[state.BOOT_READY_TIMEOUT_ENV] = '2000';
    state.beginBoot(5_000);
    state.beginBoot(9_000);
    state.trackBootStep('migrations', new Promise(() => {}));
    assert.deepStrictEqual(state.readiness(6_999), { ready: false, reason: 'starting' });
    assert.deepStrictEqual(state.readiness(7_000), { ready: true });
});

test('shutting down is never ready again, whatever the boot work says', async () => {
    state.beginBoot();
    state.trackBootStep('store schemas', Promise.resolve());
    await settle();
    assert.deepStrictEqual(state.readiness(), { ready: true });

    state.beginShutdown();
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'shutting_down' });
    state.beginBoot();
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'shutting_down' });
});

test('a shutdown before the boot work began answers shutting_down, not starting', () => {
    state.beginShutdown();
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'shutting_down' });
});
