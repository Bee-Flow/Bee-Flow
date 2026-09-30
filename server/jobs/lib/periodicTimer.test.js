'use strict';

/**
 * periodicTimer: the boot pass after the delay, then one per interval; a
 * second start is a no-op; stop clears both timers (also the boot one that
 * has not fired yet); a rejecting pass never escapes as an unhandled
 * rejection.
 *
 * Run: cd server && node --test jobs/lib/periodicTimer.test.js
 */

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const { periodicTimer } = require('./periodicTimer');

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); });
afterEach(() => { mock.timers.reset(); });

/** Let the promise chain behind a tick settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('boot pass after the delay, then one per interval, labelled', async () => {
    const calls = [];
    const timer = periodicTimer({ bootDelayMs: 100, intervalMs: 1000, run: (when) => { calls.push(when); } });
    assert.strictEqual(timer.start(), true);
    mock.timers.tick(99);
    await settle();
    assert.deepStrictEqual(calls, []);
    mock.timers.tick(1);
    await settle();
    assert.deepStrictEqual(calls, ['initial']);
    mock.timers.tick(900);
    await settle();
    assert.deepStrictEqual(calls, ['initial', 'scheduled']);
    timer.stop();
});

test('a second start is a no-op, and stop clears the boot timer that has not fired yet', async () => {
    let runs = 0;
    const timer = periodicTimer({ bootDelayMs: 100, intervalMs: 1000, run: () => { runs += 1; } });
    assert.strictEqual(timer.start(), true);
    assert.strictEqual(timer.start(), false);
    timer.stop();
    mock.timers.tick(5000);
    await settle();
    assert.strictEqual(runs, 0);
    assert.strictEqual(timer.start(), true, 'a stopped timer can start again');
    timer.stop();
});

test('a pass that rejects or throws is swallowed', async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
        let n = 0;
        const timer = periodicTimer({
            bootDelayMs: 10,
            intervalMs: 20,
            run: () => {
                n += 1;
                if (n === 1) throw new Error('sync boom');
                return Promise.reject(new Error('async boom'));
            },
        });
        timer.start();
        mock.timers.tick(10);
        await settle();
        mock.timers.tick(20);
        await settle();
        timer.stop();
        assert.strictEqual(n, 2);
        assert.deepStrictEqual(unhandled, []);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});
