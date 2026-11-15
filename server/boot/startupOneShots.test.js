// @typecheck strict
/**
 * boot/startupOneShots.js startLadder: a migration ladder as a boot step.
 *
 * The ladder runs after the tick that started it, the readiness state says
 * "starting" until it has ended, and a ladder that ends with failed migrations
 * is one error line that names them.
 *
 * Run: cd server && node --test boot/startupOneShots.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { startLadder } = require('./startupOneShots');
const state = require('../utils/runtimeState.mts');

/** Let the ladder start (setImmediate) and its handlers run. */
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/** @param {import('node:test').TestContext} t */
function quietErrors(t) {
    const error = t.mock.method(console, 'error', () => {});
    return () => error.mock.calls.map((c) => c.arguments.map(String).join(' '));
}

beforeEach(() => {
    state._resetForTests();
    state.beginBoot();
});

test('the ladder starts after the current tick, and ready waits until it has ended', async (t) => {
    const errors = quietErrors(t);
    let started = 0;
    /** @type {(out: { failed: { name: string }[] }) => void} */
    let finish = () => {};
    startLadder('data migrations', () => {
        started += 1;
        return new Promise((resolve) => { finish = resolve; });
    });
    assert.strictEqual(started, 0, 'boot does not wait for the ladder');
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'starting' }, 'tracked before it starts');

    await tick();
    assert.strictEqual(started, 1);
    assert.deepStrictEqual(state.readiness(), { ready: false, reason: 'starting' });

    finish({ failed: [] });
    await tick();
    assert.deepStrictEqual(state.readiness(), { ready: true });
    assert.deepStrictEqual(state.bootFailures(), []);
    assert.deepStrictEqual(errors(), []);
});

test('failed migrations are one error line with their names; the step ends as failed and ready follows', async (t) => {
    const errors = quietErrors(t);
    startLadder('data migrations', async () => ({
        failed: [{ name: 'backfill-a', error: 'boom' }, { name: 'backfill-b', error: 'bang' }],
    }));
    await tick();
    await tick();
    const lines = errors();
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('data migrations: 2 failed'), lines[0]);
    assert.ok(lines[0].includes('backfill-a, backfill-b'), lines[0]);
    assert.deepStrictEqual(state.bootFailures(), ['data migrations']);
    assert.deepStrictEqual(state.readiness(), { ready: true }, 'a failed migration does not keep the server out of rotation');
});

test('a ladder that does not run at all is logged and ends the step as failed', async (t) => {
    const errors = quietErrors(t);
    startLadder('Dutch translation catalogues', async () => { throw new Error('ledger gone'); });
    await tick();
    await tick();
    const lines = errors();
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('Dutch translation catalogues did not run'), lines[0]);
    assert.ok(lines[0].includes('ledger gone'), lines[0]);
    assert.deepStrictEqual(state.bootFailures(), ['Dutch translation catalogues']);
    assert.deepStrictEqual(state.readiness(), { ready: true });
});
