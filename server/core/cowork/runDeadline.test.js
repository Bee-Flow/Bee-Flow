// @typecheck
/**
 * The time limit of one Cowork run (./runDeadline.mts): a signal that aborts when the limit passes, with a reason the
 * owner can read, and a timer that every exit of a run calls off.
 *
 * Run: cd server && node --test core/cowork/runDeadline.test.js
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { startRunDeadline, runMaxMs, RunDeadlineError, RUN_MAX_MINUTES_ENV } = require('./runDeadline.mts');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => { delete process.env[RUN_MAX_MINUTES_ENV]; });

test('before the limit the deadline is silent: nothing aborts, check() passes, an error stays itself', () => {
    const deadline = startRunDeadline(60_000);
    try {
        assert.strictEqual(deadline.expired(), false);
        assert.strictEqual(deadline.signal.aborted, false);
        deadline.check();
        const boom = new Error('provider said no');
        assert.strictEqual(deadline.reasonFor(boom), boom);
    } finally {
        deadline.clear();
    }
});

test('past the limit the signal aborts with the deadline error, and check() throws it', async () => {
    const deadline = startRunDeadline(15);
    await wait(40);
    assert.strictEqual(deadline.expired(), true);
    assert.strictEqual(deadline.signal.aborted, true);
    assert.ok(deadline.signal.reason instanceof RunDeadlineError);
    assert.throws(() => deadline.check(), RunDeadlineError);
    deadline.clear();
});

test('a run that failed after its deadline failed BECAUSE of it: the abort error of an SDK is replaced', async () => {
    const deadline = startRunDeadline(10);
    await wait(30);
    const sdkAbort = Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    const reason = /** @type {Error} */ (deadline.reasonFor(sdkAbort));
    assert.ok(reason instanceof RunDeadlineError);
    assert.match(reason.message, /stopped after 1 minute: it took longer than a run may take/);
    deadline.clear();
});

test('the message names the limit in whole minutes', () => {
    assert.match(new RunDeadlineError(20 * 60_000).message, /stopped after 20 minutes/);
    assert.match(new RunDeadlineError(60_000).message, /stopped after 1 minute:/);
    assert.strictEqual(new RunDeadlineError(20 * 60_000).minutes, 20);
});

test('clear() calls the timer off: a finished run is never aborted afterwards', async () => {
    const deadline = startRunDeadline(15);
    deadline.clear();
    await wait(40);
    assert.strictEqual(deadline.expired(), false);
});

test('the limit comes from COWORK_RUN_MAX_MINUTES, 20 minutes by default, and nonsense falls back to it', () => {
    assert.strictEqual(runMaxMs(), 20 * 60_000);
    process.env[RUN_MAX_MINUTES_ENV] = '5';
    assert.strictEqual(runMaxMs(), 5 * 60_000);
    process.env[RUN_MAX_MINUTES_ENV] = '0';
    assert.strictEqual(runMaxMs(), 20 * 60_000, 'a run without a limit is not on offer');
    process.env[RUN_MAX_MINUTES_ENV] = '100000';
    assert.strictEqual(runMaxMs(), 20 * 60_000);
});
