/**
 * Unit — startSseHeartbeat transport + onDead liveness (H5). DB-free.
 * Run: node --test core/sseHeartbeat.test.js
 *
 * The clock is DRIVEN here, not waited on. Every one of these tests used to
 * sleep for real and count what had happened by then — "await 35ms, assert at
 * least two beats fired at a 10ms interval". That holds on an idle machine and
 * fails on a loaded one, where the event loop simply does not get around to
 * the interval in time. It failed exactly that way in a full-suite run and
 * passed on its own three times afterwards, which is the signature of a test
 * measuring the machine instead of the code.
 *
 * With mocked timers the counts are exact rather than "at least": tick(35) at
 * an interval of 10 fires three times, always, on any machine. That also makes
 * these tests stricter than they were — an off-by-one in the scheduling would
 * now be caught, where `>= 2` would have shrugged at it.
 */

const { test, mock } = require('node:test');
const assert = require('node:assert');

const { startSseHeartbeat } = require('./http/sseHelpers');

function fakeRes() {
    const handlers = {};
    return {
        writes: [],
        writableEnded: false,
        destroyed: false,
        write(frame) {
            if (this._throw) throw new Error('EPIPE');
            this.writes.push(frame);
            return true;
        },
        on(ev, fn) { handlers[ev] = fn; },
        emit(ev) { handlers[ev]?.(); },
    };
}

/**
 * A fake clock for the duration of one test. `setInterval` is what the
 * heartbeat schedules on; `setTimeout` comes along because the helper may
 * clear either, and a half-mocked clock is worse than none.
 */
function withFakeClock(t) {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    return (ms) => t.mock.timers.tick(ms);
}

test('writes the default frame and stop() halts further beats', (t) => {
    const tick = withFakeClock(t);
    const res = fakeRes();
    const stop = startSseHeartbeat(res, 10);

    tick(35);
    assert.strictEqual(res.writes.length, 3, 'three beats in 35ms at a 10ms interval');
    assert.match(res.writes[0], /event: ping/, 'default frame includes the ping event');

    stop();
    tick(1000);
    assert.strictEqual(res.writes.length, 3, 'no beats after stop(), however long we wait');
});

test('custom frame is written verbatim (preserves a route\'s wire format)', (t) => {
    const tick = withFakeClock(t);
    const res = fakeRes();
    const stop = startSseHeartbeat(res, 10, { frame: ': keepalive\n\n' });
    tick(25);
    stop();
    assert.strictEqual(res.writes.length, 2);
    assert.ok(res.writes.every((w) => w === ': keepalive\n\n'), 'only the custom frame is sent');
});

test('onDead fires after maxFailures consecutive write failures', (t) => {
    const tick = withFakeClock(t);
    const res = fakeRes();
    let dead = 0;
    res._throw = true;
    const stop = startSseHeartbeat(res, 10, { onDead: () => { dead += 1; }, maxFailures: 3 });

    tick(20);
    assert.strictEqual(dead, 0, 'two failures is not yet dead');
    tick(10);
    assert.strictEqual(dead, 1, 'the third consecutive failure is');

    tick(1000);
    stop();
    assert.strictEqual(dead, 1, 'onDead called exactly once, not once per later beat');
});

test('onDead fires when the response has already ended', (t) => {
    const tick = withFakeClock(t);
    const res = fakeRes();
    let dead = 0;
    res.writableEnded = true;
    startSseHeartbeat(res, 10, { onDead: () => { dead += 1; } });
    tick(25);
    assert.strictEqual(dead, 1);
});

test('without onDead, a single write error just stops (legacy behaviour)', (t) => {
    const tick = withFakeClock(t);
    const res = fakeRes();
    res._throw = true;
    const stop = startSseHeartbeat(res, 10);
    tick(30);
    stop();
    assert.strictEqual(res.writes.length, 0, 'no successful writes, and it stopped itself');
});

test('res close/finish/error all stop the heartbeat', (t) => {
    const tick = withFakeClock(t);
    for (const ev of ['close', 'finish', 'error']) {
        const res = fakeRes();
        startSseHeartbeat(res, 10);
        tick(15);
        const count = res.writes.length;
        assert.ok(count > 0, `beating before ${ev}`);
        res.emit(ev);
        tick(1000);
        assert.strictEqual(res.writes.length, count, `stopped on ${ev}`);
    }
});

// The clock is restored between tests by the runner, but a stray interval on a
// real timer would outlive the file and hold the process open.
test.after(() => mock.timers.reset());
