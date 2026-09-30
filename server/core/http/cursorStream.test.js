/**
 * The cursor-based SSE skeleton (core/http/cursorStream.js).
 *
 * Over real HTTP: headers (incl. X-Accel-Buffering), a new subscriber starts
 * at HEAD and `ready` names that cursor, Last-Event-ID replays with `id:`
 * lines, a durable doorbell drains, transient events pass without `id:` (or
 * through `onTransient`), a truncated backlog asks for a resync, a revoked
 * member gets `forbidden` and the stream ends, closing runs the close hooks.
 *
 * Over a stand-in response: a refused write pauses the drain until 'drain'
 * (no frame is lost or reordered), and a reader that buffers past the cap is
 * disconnected after `onSlowConsumer`.
 *
 * Run: cd server && node --test core/http/cursorStream.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('events');
const { openCursorStream } = require('./cursorStream');

const quiet = { warn() {} };

/** A log of durable events and a bus, like projectStore + projectEventBus. */
function feed() {
    const events = [];
    const bus = new EventEmitter();
    return {
        events,
        bus,
        add(kind) { const ev = { seq: events.length + 1, kind }; events.push(ev); return ev; },
        readSince: async (cursor) => ({ events: events.filter((e) => e.seq > cursor), truncated: false }),
        subscribe: (fn) => { bus.on('ev', fn); return () => bus.off('ev', fn); },
    };
}

function serve(handler) {
    const server = http.createServer((req, res) => { handler(req, res).catch(() => res.end()); });
    const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        async open(headers = {}) {
            await ready;
            const ctrl = new AbortController();
            const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers, signal: ctrl.signal });
            const reader = res.body.getReader();
            let buf = '';
            const frames = [];
            const pump = (async () => {
                const dec = new TextDecoder();
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buf += dec.decode(value, { stream: true });
                        let i;
                        while ((i = buf.indexOf('\n\n')) >= 0) {
                            const raw = buf.slice(0, i);
                            buf = buf.slice(i + 2);
                            const f = {};
                            for (const line of raw.split('\n')) {
                                if (line.startsWith('id: ')) f.id = line.slice(4);
                                else if (line.startsWith('event: ')) f.event = line.slice(7);
                                else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
                            }
                            if (f.event && f.event !== 'ping') frames.push(f);
                        }
                    }
                } catch (_) { /* aborted */ }
            })();
            return { res, frames, ended: pump, close: () => ctrl.abort() };
        },
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    };
}

async function until(fn, ms = 2000) {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > ms) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
}

test('headers, ready at HEAD, doorbell drains, transient frames carry no id', async () => {
    const f = feed();
    f.add('old.one');
    f.add('old.two');
    let closedHook = false;
    const srv = serve(async (req, res) => {
        const s = await openCursorStream(req, res, {
            cursor: Number(req.headers['last-event-id'] || 0),
            head: async () => f.events.length,
            readSince: f.readSince,
            subscribe: f.subscribe,
            readyPayload: () => ({ distributed: false }),
            onTransient: (ev, st) => { if (!ev.kind.startsWith('hidden.')) st.send(ev.kind, ev); },
            pollMs: () => 60_000,
            log: quiet,
        });
        s.onClose(() => { closedHook = true; });
    });
    const c = await srv.open();
    assert.strictEqual(c.res.headers.get('content-type'), 'text/event-stream');
    assert.strictEqual(c.res.headers.get('x-accel-buffering'), 'no');
    await until(() => c.frames.length >= 1);
    assert.deepStrictEqual(c.frames[0], { event: 'ready', data: { distributed: false, since: 2 } });

    f.add('chat.created');
    f.bus.emit('ev', { kind: 'chat.created' });
    f.bus.emit('ev', { kind: 'presence.typing', transient: true });
    f.bus.emit('ev', { kind: 'hidden.thing', transient: true });
    try {
        await until(() => c.frames.length >= 3);
        // The durable frame is read from the log, so it may land after the transient one.
        assert.deepStrictEqual(c.frames.find((x) => x.event === 'chat.created'), { id: '3', event: 'chat.created', data: { seq: 3, kind: 'chat.created' } });
        assert.deepStrictEqual(c.frames.find((x) => x.event === 'presence.typing'), { event: 'presence.typing', data: { kind: 'presence.typing', transient: true } });
        assert.ok(!c.frames.some((x) => x.event === 'hidden.thing'), 'onTransient decides');
        c.close();
        await until(() => closedHook);
    } finally {
        c.close();
        await srv.close();
    }
});

test('Last-Event-ID replays what was missed; a truncated backlog asks for a resync', async () => {
    const f = feed();
    for (let i = 0; i < 4; i += 1) f.add(`k${i}`);
    const srv = serve(async (req, res) => {
        await openCursorStream(req, res, {
            cursor: Number(req.headers['last-event-id'] || 0),
            head: async () => 99,
            readSince: async (cursor) => ({ events: f.events.filter((e) => e.seq > cursor).slice(0, 2), truncated: cursor < 2 }),
            subscribe: f.subscribe,
            pollMs: () => 60_000,
            log: quiet,
        });
    });
    const c = await srv.open({ 'last-event-id': '1' });
    await until(() => c.frames.length >= 4);
    assert.deepStrictEqual(c.frames.map((x) => [x.event, x.id]), [['ready', undefined], ['k1', '2'], ['k2', '3'], ['resync', undefined]]);
    assert.deepStrictEqual(c.frames[0].data, { since: 1 });
    assert.deepStrictEqual(c.frames[3].data, { since: 3 });
    c.close();
    await srv.close();
});

test('a revoked member gets forbidden and the stream ends', async () => {
    const f = feed();
    let allowed = true;
    const srv = serve(async (req, res) => {
        await openCursorStream(req, res, {
            cursor: 0, head: async () => 0, readSince: f.readSince, subscribe: f.subscribe,
            stillAllowed: async () => allowed, recheckMs: 30, pollMs: () => 60_000, log: quiet,
        });
    });
    const c = await srv.open();
    await until(() => c.frames.length >= 1);
    allowed = false;
    await c.ended;
    assert.deepStrictEqual(c.frames.at(-1), { event: 'forbidden', data: { reason: 'access_revoked' } });
    assert.strictEqual(f.bus.listenerCount('ev'), 0, 'unsubscribed');
    await srv.close();
});

/** A response that refuses writes on demand, like a socket whose buffer is full. */
function standInResponse() {
    const res = new EventEmitter();
    Object.assign(res, {
        written: [], full: false, writableLength: 0, writableEnded: false, destroyed: false,
        setHeader() {}, flushHeaders() {},
        write(chunk) { this.written.push(chunk); if (this.full) this.writableLength += chunk.length; return !this.full; },
        end() { this.writableEnded = true; this.emit('close'); },
    });
    return res;
}

test('a refused write pauses the drain until the socket drains; nothing is lost or reordered', async () => {
    const f = feed();
    const res = standInResponse();
    const req = new EventEmitter();
    await openCursorStream(req, res, {
        cursor: 0, head: async () => 0, readSince: f.readSince, subscribe: f.subscribe, pollMs: () => 60_000, log: quiet,
    });
    res.full = true;
    f.add('a'); f.add('b'); f.add('c');
    f.bus.emit('ev', { kind: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    const ids = () => res.written.filter((w) => w.startsWith('id: ')).map((w) => w.split('\n')[0]);
    assert.deepStrictEqual(ids(), ['id: 1'], 'paused after the refused write');
    res.full = false;
    res.writableLength = 0;
    res.emit('drain');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(ids(), ['id: 1', 'id: 2', 'id: 3']);
    req.emit('close');
});

test('a reader that buffers past the cap is disconnected after onSlowConsumer', async () => {
    const f = feed();
    const res = standInResponse();
    const req = new EventEmitter();
    let slow = 0;
    let closed = false;
    const s = await openCursorStream(req, res, {
        cursor: 0, head: async () => 0, readSince: f.readSince, subscribe: f.subscribe, pollMs: () => 60_000,
        maxBufferedBytes: 100, onSlowConsumer: () => { slow += 1; }, log: quiet,
    });
    s.onClose(() => { closed = true; });
    res.full = true;
    assert.strictEqual(s.send('x', { pad: 'y'.repeat(200) }), false);
    assert.strictEqual(slow, 1);
    assert.strictEqual(closed, true);
    assert.strictEqual(res.writableEnded, true);
    assert.strictEqual(s.send('x', {}), false, 'nothing more is written');
    assert.strictEqual(f.bus.listenerCount('ev'), 0);
});

test('a slow reader whose onSlowConsumer sends a parting notice is ended once, completely', async () => {
    // collabStream's onSlowConsumer sends `doc.resync`. That write found the
    // buffer still over the cap and ended the reader again, recursively,
    // until the stack overflowed inside close(): hooks never ran, the
    // response never ended, and the heartbeat kept pinging a dead stream.
    const f = feed();
    const res = standInResponse();
    const req = new EventEmitter();
    let hooks = 0;
    const s = await openCursorStream(req, res, {
        cursor: 0, head: async () => 0, readSince: f.readSince, subscribe: f.subscribe, pollMs: () => 60_000,
        heartbeatMs: 10, maxBufferedBytes: 100, log: quiet,
        onSlowConsumer: (st) => { st.send('doc.resync', { docId: 'd1', reason: 'slow_consumer' }); },
    });
    s.onClose(() => { hooks += 1; });
    res.full = true;
    f.bus.emit('ev', { kind: 'doc.update', transient: true, pad: 'y'.repeat(200) });

    const notices = res.written.filter((w) => w.startsWith('event: doc.resync'));
    assert.strictEqual(notices.length, 1, 'exactly one parting notice');
    assert.strictEqual(s.closed, true);
    assert.strictEqual(hooks, 1, 'the close hooks ran (a document hub forgets this reader)');
    assert.strictEqual(res.writableEnded, true, 'the response ended, so the client reconnects');
    assert.strictEqual(f.bus.listenerCount('ev'), 0, 'unsubscribed from the bus');
    const writes = res.written.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(res.written.length, writes, 'no heartbeat after the end');
});

test('closing runs every step even when one of them throws', async () => {
    const res = standInResponse();
    const req = new EventEmitter();
    const ran = [];
    const s = await openCursorStream(req, res, {
        cursor: 0, head: async () => 0, readSince: async () => ({ events: [] }),
        subscribe: () => () => { throw new Error('bus gone'); }, pollMs: () => 60_000, log: quiet,
    });
    s.onClose(() => { ran.push('a'); throw new Error('hook failed'); });
    s.onClose(() => { ran.push('b'); });
    s.close('test');
    assert.deepStrictEqual(ran, ['a', 'b']);
    assert.strictEqual(res.writableEnded, true);
});

test('a client that leaves while the head is read closes the stream, and nothing is started', async () => {
    const f = feed();
    const res = standInResponse();
    const req = new EventEmitter();
    let releaseHead;
    const opening = openCursorStream(req, res, {
        cursor: 0, head: () => new Promise((r) => { releaseHead = () => r(5); }), readSince: f.readSince,
        subscribe: f.subscribe, pollMs: () => 60_000, heartbeatMs: 10, log: quiet,
    });
    await new Promise((r) => setImmediate(r));
    req.emit('close');
    releaseHead();
    const s = await opening;
    assert.strictEqual(s.closed, true);
    assert.strictEqual(f.bus.listenerCount('ev'), 0, 'never subscribed');
    const writes = res.written.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(res.written.length, writes, 'no heartbeat for a stream that is gone');
});
