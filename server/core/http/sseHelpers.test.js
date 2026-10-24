// @typecheck
/**
 * Unit tests for startSseHeartbeat — the keep-alive that stops a long, idle
 * SSE stream (e.g. a thinking-model automation build) from being idle-timed-out
 * to a false 504 by an upstream gateway (NC AppAPI proxy / HaRP / ingress).
 *
 * Run: node --test core/sseHelpers.test.js
 */

const { test, mock } = require('node:test');
const assert = require('assert');
const { startSseHeartbeat, openSse } = require('./sseHelpers');

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

// ── openSse: headers, guarded send, client stop and the opt-in keep-alive ──

function fakeStreamRes() {
    const r = fakeRes();
    const handlers = {};
    r.on = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); return r; };
    r.emit = (ev) => { for (const fn of handlers[ev] || []) fn(); };
    r.writeHead = (status, headers) => { r.status = status; r.headers = headers; return r; };
    return r;
}

test('openSse writes the SSE headers and sends framed events until the response ends', () => {
    const res = fakeStreamRes();
    const { send } = openSse(res);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.headers, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    send('content', { text: 'hi' });
    assert.deepStrictEqual(res.writes, ['event: content\ndata: {"text":"hi"}\n\n']);
    res.writableEnded = true;
    send('content', { text: 'late' });
    assert.strictEqual(res.writes.length, 1, 'no write after end()');
});

test('openSse: a client close aborts the signal; our own end() does not', () => {
    const own = fakeStreamRes();
    const a = openSse(own);
    own.writableEnded = true;
    own.emit('close');
    assert.strictEqual(a.signal.aborted, false);
    assert.strictEqual(a.isGone(), false);

    const left = fakeStreamRes();
    const b = openSse(left);
    left.emit('close');
    assert.strictEqual(b.signal.aborted, true);
    assert.strictEqual(b.isGone(), true);
});

test('openSse starts the keep-alive only when asked', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        const quiet = fakeStreamRes();
        openSse(quiet);
        const warm = fakeStreamRes();
        const { stopHeartbeat } = openSse(warm, { heartbeat: true });
        mock.timers.tick(10000);
        assert.strictEqual(quiet.writes.length, 0);
        assert.ok(warm.writes.join('').includes('event: ping'));
        stopHeartbeat();
        const n = warm.writes.length;
        mock.timers.tick(30000);
        assert.strictEqual(warm.writes.length, n);
    } finally {
        mock.timers.reset();
    }
});

test('openSse keeps a route\'s own head: overrides a value, drops a null one, flushes on request', () => {
    const res = fakeStreamRes();
    let flushed = 0;
    res.flushHeaders = () => { flushed++; };
    openSse(res, { headers: { 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': null }, flush: true });
    assert.deepStrictEqual(res.headers, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive',
    });
    assert.strictEqual(flushed, 1);
    const plain = fakeStreamRes();
    plain.flushHeaders = () => { flushed++; };
    openSse(plain);
    assert.strictEqual(flushed, 1, 'no flush unless asked');
});

test('openSse: sendRaw writes the chunk as is, swallows a throwing write, and stops after end', () => {
    const res = fakeStreamRes();
    let ended = 0;
    res.end = () => { ended++; res.writableEnded = true; return res; };
    const { sendRaw, end } = openSse(res);
    sendRaw('data: {"type":"done"}\n\n');
    assert.deepStrictEqual(res.writes, ['data: {"type":"done"}\n\n']);
    res.write = () => { throw new Error('EPIPE'); };
    assert.doesNotThrow(() => sendRaw('x'));
    assert.strictEqual(end(), res);
    assert.strictEqual(end(), res, 'a second end() is a no-op');
    assert.strictEqual(ended, 1);
});

test('openSse: the heartbeat takes startSseHeartbeat\'s interval and frame, and end() stops it', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
        const res = fakeStreamRes();
        res.end = () => { res.writableEnded = true; return res; };
        const { end } = openSse(res, { heartbeat: { intervalMs: 25000, frame: ': keepalive\n\n' } });
        mock.timers.tick(10000);
        assert.strictEqual(res.writes.length, 0);
        mock.timers.tick(15000);
        assert.deepStrictEqual(res.writes, [': keepalive\n\n']);
        end();
        mock.timers.tick(50000);
        assert.strictEqual(res.writes.length, 1);
    } finally {
        mock.timers.reset();
    }
});

test('openSse tolerates a response stub without event listeners', () => {
    const res = { writes: [], writeHead() {}, write(s) { this.writes.push(s); return true; } };
    const { send } = openSse(res, { heartbeat: true });
    send('done', { ok: true });
    assert.deepStrictEqual(res.writes, ['event: done\ndata: {"ok":true}\n\n']);
});

test('openSse viaSetHeader sets the head header by header instead of writeHead', () => {
    const res = fakeStreamRes();
    const set = {};
    res.setHeader = (k, v) => { set[k] = v; };
    res.writeHead = () => { throw new Error('writeHead must not be called'); };
    openSse(res, { viaSetHeader: true, headers: { 'X-Accel-Buffering': null } });
    assert.deepStrictEqual(set, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
});

test('openSse charset reproduces the Content-Type Express\'s res.set wrote', () => {
    const res = fakeStreamRes();
    openSse(res, { charset: 'utf-8' });
    assert.strictEqual(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
});
