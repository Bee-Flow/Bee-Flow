// @typecheck
/**
 * A cursor-based Server-Sent Events stream: the skeleton of
 * GET /api/projects/:id/stream, shared so the co-editing frames that ride on
 * it (core/collab) do not copy it.
 *
 * ── The delivery model ──────────────────────────────────────────────────────
 *
 * Every DURABLE frame carries `id: <seq>`, so a client that drops reconnects
 * with Last-Event-ID (or ?since=) and replays exactly what it missed.
 * Reconnect and live delivery are the same code path. The bus is only a
 * doorbell ("something moved, read from your cursor"); a poll covers a
 * doorbell that never rang (no Redis across replicas, a dropped publish).
 *
 * TRANSIENT frames (typing, presence, co-editing updates) have no `id:` line
 * and never move the cursor.
 *
 * ── What the skeleton owns ──────────────────────────────────────────────────
 *
 *   - headers, including `X-Accel-Buffering: no` for proxies that buffer;
 *   - the `ready {since}` frame: a client without a cursor starts at HEAD and
 *     must adopt this one, or a reconnect before the first event loses the gap;
 *   - a serialised drain (two overlapping drains could reorder frames and
 *     move the cursor past frames never sent);
 *   - BACKPRESSURE: a write the socket cannot take pauses the drain until
 *     'drain'; a reader that lets more than `maxBufferedBytes` pile up is
 *     disconnected (it reconnects with its cursor and loses nothing);
 *   - the poll (its interval asked fresh each time, so it can stretch when the
 *     bus is distributed), a periodic access re-check that ends the stream
 *     with `forbidden`, and the heartbeat.
 */

'use strict';

const { once } = require('events');
const { startSseHeartbeat } = require('./sseHelpers');

const STREAM_HEADERS = Object.freeze({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx (and the customer proxies that copy its defaults) buffer a
    // response unless told otherwise; a buffered event stream is a stream
    // that delivers nothing until it ends.
    'X-Accel-Buffering': 'no',
});

const DEFAULTS = Object.freeze({
    recheckMs: 60_000,
    heartbeatMs: 10_000,
    maxBufferedBytes: 1024 * 1024,
});

/**
 * @typedef {{
 *   send: (kind: string, data: object) => boolean,
 *   close: (reason?: string) => void,
 *   onClose: (fn: () => void) => void,
 *   onDrain: (fn: () => void) => void,
 *   readonly closed: boolean,
 *   readonly cursor: number,
 * }} CursorStream
 */

/**
 * @param {any} req
 * @param {any} res
 * @param {{
 *   cursor: number,
 *   head: () => Promise<number>,
 *   readSince: (cursor: number) => Promise<{ events: Array<{ seq: number, kind: string }>, truncated?: boolean }>,
 *   subscribe: (onEvent: (ev: any) => void) => () => void,
 *   stillAllowed?: () => Promise<boolean|null>,
 *   readyPayload?: () => object,
 *   onTransient?: (ev: any, stream: CursorStream) => void,
 *   onSlowConsumer?: (stream: CursorStream) => void,
 *   pollMs?: () => number,
 *   recheckMs?: number, heartbeatMs?: number, maxBufferedBytes?: number,
 *   log?: { warn: Function },
 * }} opts
 * @returns {Promise<CursorStream>}
 */
async function openCursorStream(req, res, opts) {
    const log = opts.log || require('../../telemetry/log');
    const recheckMs = opts.recheckMs || DEFAULTS.recheckMs;
    const heartbeatMs = opts.heartbeatMs || DEFAULTS.heartbeatMs;
    const maxBufferedBytes = opts.maxBufferedBytes || DEFAULTS.maxBufferedBytes;
    const pollMs = opts.pollMs || (() => 1500);

    for (const [name, value] of Object.entries(STREAM_HEADERS)) res.setHeader(name, value);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    let cursor = Number(opts.cursor) || 0;
    /** @type {Array<() => void>} */
    const closeHandlers = [];
    /** @type {Array<() => void>} */
    const drainHandlers = [];
    /** @type {any} */
    let pollTimer = null;
    /** @type {any} */
    let recheckTimer = null;
    /** @type {() => void} */
    let stopHeartbeat = () => {};
    /** @type {() => void} */
    let unsubscribe = () => {};

    const onSocketDrain = () => { for (const fn of drainHandlers) { try { fn(); } catch (_) { /* a listener's problem */ } } };
    res.on('drain', onSocketDrain);

    function writable() {
        return !closed && !res.writableEnded && !res.destroyed;
    }

    // Set while a slow reader is being ended: the parting notice that
    // `onSlowConsumer` sends goes straight to the socket, past the cap. Through
    // the cap it would find the buffer still over it, end the reader again,
    // send the notice again, and so on until the stack overflowed — halfway
    // through close(), leaving a stream that pings forever and delivers
    // nothing.
    let ending = false;

    /** @param {string} frame */
    function write(frame) {
        if (ending) {
            if (res.writableEnded || res.destroyed) return false;
            try { res.write(frame); } catch (_) { /* the socket is going anyway */ }
            return false;
        }
        if (!writable()) return false;
        let ok;
        try { ok = res.write(frame); } catch (_) { close('write_failed'); return false; }
        if ((res.writableLength || 0) > maxBufferedBytes) {
            endSlowConsumer();
            return false;
        }
        return ok !== false;
    }

    /**
     * Not reading: drop it rather than hold its backlog in memory. It
     * reconnects with its cursor and misses nothing durable.
     */
    function endSlowConsumer() {
        if (closed || ending) return;
        ending = true;
        try { if (opts.onSlowConsumer) opts.onSlowConsumer(stream); } catch (_) { /* best effort */ }
        close('slow_consumer');
    }

    /** @type {CursorStream} */
    const stream = {
        send: (kind, data) => write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`),
        close,
        onClose: (fn) => { if (closed) fn(); else closeHandlers.push(fn); },
        onDrain: (fn) => { drainHandlers.push(fn); },
        get closed() { return closed; },
        get cursor() { return cursor; },
    };

    /** One step of closing; a failing step never keeps the next from running. @param {() => void} fn */
    function step(fn) {
        try { fn(); } catch (_) { /* keep closing */ }
    }

    /**
     * End the stream. The steps that matter most to the other side run first
     * — the response ends (so the client reconnects) and the close hooks run
     * (so a document hub forgets this reader) — and each one on its own, so
     * one that throws cannot leave a half-closed stream behind.
     * @param {string} [_reason]
     */
    function close(_reason) {
        if (closed) return;
        closed = true;
        ending = false;
        step(() => { if (!res.writableEnded) res.end(); });
        for (const fn of closeHandlers.splice(0)) step(fn);
        step(() => unsubscribe());
        step(() => stopHeartbeat());
        step(() => { if (pollTimer) clearTimeout(pollTimer); });
        step(() => { if (recheckTimer) clearInterval(recheckTimer); });
        step(() => res.off('drain', onSocketDrain));
    }

    let draining = false;
    let again = false;

    /** Replay everything after the cursor, in order, respecting backpressure. */
    async function drain() {
        if (closed) return;
        if (draining) { again = true; return; }
        draining = true;
        try {
            do {
                again = false;
                const { events, truncated } = await opts.readSince(cursor);
                for (const ev of events) {
                    if (!writable()) return;
                    const ok = write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
                    cursor = ev.seq;
                    if (!ok && writable()) {
                        await Promise.race([once(res, 'drain'), once(res, 'close')]);
                    }
                }
                if (truncated) {
                    // Too far behind to replay. Refetching is cheaper than
                    // streaming a backlog, and leaves the client correct.
                    stream.send('resync', { since: cursor });
                }
            } while (again && writable());
        } catch (err) {
            log.warn('[CursorStream] drain failed:', /** @type {Error} */ (err).message);
        } finally {
            draining = false;
        }
    }

    function schedulePoll() {
        if (closed) return;
        pollTimer = setTimeout(async () => {
            pollTimer = null;
            await drain();
            schedulePoll();
        }, Math.max(250, pollMs()));
        if (pollTimer.unref) pollTimer.unref();
    }

    // Listen for the client leaving before the first await: one that leaves
    // while the head is read must still close the stream.
    req.on('close', () => close('client_closed'));

    // A brand-new subscriber (no cursor) starts from HEAD: replaying history
    // to someone who just opened the page is noise, and the page loads its
    // own current state anyway.
    if (!cursor) {
        try { cursor = Number(await opts.head()) || 0; } catch (_) { cursor = 0; }
    }
    stream.send('ready', { ...(opts.readyPayload ? opts.readyPayload() : {}), since: cursor });
    // Gone already: start nothing that close() has run too early to stop.
    if (closed) return stream;

    unsubscribe = opts.subscribe((ev) => {
        if (closed) return;
        if (ev && ev.transient) {
            if (opts.onTransient) opts.onTransient(ev, stream);
            else stream.send(ev.kind || 'transient', ev);
            return;
        }
        drain();
    });

    schedulePoll();

    if (opts.stillAllowed) {
        const stillAllowed = opts.stillAllowed;
        recheckTimer = setInterval(async () => {
            try {
                if ((await stillAllowed()) === false) {
                    stream.send('forbidden', { reason: 'access_revoked' });
                    close('access_revoked');
                }
            } catch (_) { /* a transient failure keeps the stream; next tick tries again */ }
        }, recheckMs);
        if (recheckTimer.unref) recheckTimer.unref();
    }

    stopHeartbeat = /** @type {() => void} */ (startSseHeartbeat(res, heartbeatMs, { onDead: () => close('dead') }));

    // Anything that landed between reading the cursor and subscribing.
    await drain();
    return stream;
}

module.exports = { openCursorStream, DEFAULTS, STREAM_HEADERS };
