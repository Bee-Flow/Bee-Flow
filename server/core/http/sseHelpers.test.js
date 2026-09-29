/**
 * Unit tests for startSseHeartbeat — the keep-alive that stops a long, idle
 * SSE stream (e.g. a thinking-model automation build) from being idle-timed-out
 * to a false 504 by an upstream gateway (NC AppAPI proxy / HaRP / ingress).
 *
 * Run: node --test core/sseHelpers.test.js
 */

const { test, mock } = require('node:test');
const assert = require('assert');
const { startSseHeartbeat } = require('./sseHelpers');

function fakeRes() {
    const r = { writes: [], writableEnded: false, destroyed: false, _handlers: {} };
    r.write = (s) => { r.writes.push(s); return true; };
    r.on = (ev, fn) => { r._handlers[ev] = fn; return r; };
    r.emit = (ev) => { if (r._handlers[ev]) r._handlers[ev](); };
    return r;
}

test('writes a comment frame + a ping event on each interval', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        const res = fakeRes();
        const stop = startSseHeartbeat(res, 10000);
        assert.strictEqual(res.writes.length, 0, 'no ping before the first interval');
        mock.timers.tick(10000);
        const joined = res.writes.join('');
        assert.ok(joined.includes(': ping'), 'wrote a comment frame for comment-resetting proxies');
        assert.ok(joined.includes('event: ping'), 'wrote a real ping event for event-resetting proxies');
        mock.timers.tick(10000);
        assert.ok(res.writes.length >= 2, 'keeps pinging on each interval');
        stop();
    } finally {
        mock.timers.reset();
    }
});

test('stop() halts further pings', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        const res = fakeRes();
        const stop = startSseHeartbeat(res, 5000);
        mock.timers.tick(5000);
        const count = res.writes.length;
        stop();
        mock.timers.tick(30000);
        assert.strictEqual(res.writes.length, count, 'no writes after stop()');
    } finally {
        mock.timers.reset();
    }
});

test('a finished response auto-stops the heartbeat', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        const res = fakeRes();
        startSseHeartbeat(res, 5000);
        res.emit('finish'); // res.on('finish', stop) is registered by the helper
        const before = res.writes.length;
        mock.timers.tick(20000);
        assert.strictEqual(res.writes.length, before, 'finish stops the heartbeat');
    } finally {
        mock.timers.reset();
    }
});

test('a dead socket stops itself on the next tick', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        const res = fakeRes();
        startSseHeartbeat(res, 5000);
        res.writableEnded = true;
        mock.timers.tick(5000); // tick fires, sees writableEnded → stop, no write
        const count = res.writes.length;
        mock.timers.tick(15000);
        assert.strictEqual(count, 0, 'no ping written to an ended socket');
        assert.strictEqual(res.writes.length, count, 'and none after');
    } finally {
        mock.timers.reset();
    }
});
