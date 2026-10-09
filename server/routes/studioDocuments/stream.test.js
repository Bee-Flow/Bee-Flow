'use strict';

/**
 * GET /api/studio-documents/:id/stream: refusal, delivery on the document's
 * channel, and the access re-check that ends a stream.
 *
 * Run: cd server && node --test routes/studioDocuments/stream.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { makeDocumentStreamRouter, documentChannel } = require('./stream');

const readable = new Set(['d1']);
const emitter = new EventEmitter();
const subscribed = [];
const router = makeDocumentStreamRouter({
    documents: { async getDocument(id, userId) { return userId === 'anna' && readable.has(id) ? { id } : null; } },
    bus: {
        subscribeChannel(channel, fn) {
            subscribed.push(channel);
            emitter.on(channel, fn);
            return () => emitter.off(channel, fn);
        },
    },
    requireAuth: (req, res, next) => next(),
    streamOptions: { recheckMs: 40, heartbeatMs: 60_000 },
    log: { warn() {} },
});

const app = express();
app.use((req, _res, next) => { req.session = { user: { id: req.headers['x-user'] || 'anna' } }; next(); });
app.use('/api/studio-documents', router);
app.use(terminalErrorHandler);
const server = http.createServer(app);
const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(() => { server.closeAllConnections?.(); server.close(); });

async function open(id, user = 'anna') {
    await ready;
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/studio-documents/${id}/stream`, { headers: { 'x-user': user }, signal: ctl.signal });
    return { res, ctl };
}

/** Read chunks until `done(text)` is true or the stream ends. */
async function readUntil(res, done) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) return { text, ended: true };
        text += dec.decode(value, { stream: true });
        if (done(text)) { reader.releaseLock(); return { text, ended: false }; }
    }
}

test('a reader who cannot read the document gets 404 and no stream', async () => {
    const { res } = await open('nope');
    assert.strictEqual(res.status, 404);
    const stranger = await open('d1', 'stranger');
    assert.strictEqual(stranger.res.status, 404);
});

test('an event on doc:<id> is delivered under its kind, after a ready frame at 0', async () => {
    const { res, ctl } = await open('d1');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const first = await readUntil(res, (t) => t.includes('event: ready'));
    assert.match(first.text, /"since":0/);
    assert.ok(subscribed.includes(documentChannel('d1')));
    assert.strictEqual(documentChannel('d1'), 'doc:d1');
    const event = { kind: 'document.presence', transient: true, actorId: 'bob', targetId: 'd1', payload: { clientId: 'c1', state: 'viewing' } };
    emitter.emit('doc:d1', event);
    const got = await readUntil(res, (t) => t.includes('document.presence'));
    assert.match(got.text, /event: document\.presence\ndata: /);
    assert.doesNotMatch(got.text, /^id: /m, 'transient frames carry no cursor');
    ctl.abort();
});

test('losing the read right sends forbidden and ends the stream', async () => {
    readable.add('d2');
    const { res } = await open('d2');
    await readUntil(res, (t) => t.includes('event: ready'));
    readable.delete('d2');
    const out = await readUntil(res, () => false);
    assert.ok(out.ended);
    assert.match(out.text, /event: forbidden/);
    assert.match(out.text, /access_revoked/);
});
