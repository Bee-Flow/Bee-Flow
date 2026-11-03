'use strict';

/**
 * GET /_runs/stream (run-watch F8): an editor who starts a run of somebody
 * else's automation runs it AS THE OWNER (the event's userId), so the stream
 * also passes an event whose startedByUserId is the subscriber. Everything
 * else stays out, and a run on its starter's own connections still carries no
 * data on its events (runHeartbeat.makeLifecycleEmitter's hideData).
 *
 * Run: node --test routes/automation/runs.streamStarter.test.js
 */
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

// Nothing here reads a store: the stream route only subscribes to the bus.
const { runRoute } = require('../../testUtils/routeHandlers');
const router = require('./runs');
const { emitRunEvent, emitRunClosed } = require('../../core/runEventBus');
const { makeLifecycleEmitter } = require('../../core/automationRunner/runHeartbeat');
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const stream = runRoute(router, 'get', '/_runs/stream');

/** Subscribe as `me`; returns the events received and a close function. */
async function subscribe(me, query = {}) {
    const req = Object.assign(new EventEmitter(), { query, session: { user: { id: me } } });
    const res = Object.assign(new EventEmitter(), {
        chunks: /** @type {string[]} */ ([]),
        setHeader() {}, flushHeaders() {}, write(c) { this.chunks.push(c); return true; },
        writableEnded: false, destroyed: false,
    });
    await stream(req, res);
    const events = () => res.chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
    return { events, close: () => req.emit('close') };
}

test('the starter of a run on someone else\'s automation receives its events; strangers do not', async () => {
    const editor = await subscribe('editor3');
    const owner = await subscribe('owner1');
    const stranger = await subscribe('someone');
    emitRunEvent('run.started', { runId: 'r1', automationId: 'a1', userId: 'owner1', startedByUserId: 'editor3', rootRunId: 'r1' });
    emitRunEvent('run.finished', { runId: 'r2', automationId: 'a1', userId: 'owner1', startedByUserId: 'other', rootRunId: 'r2', status: 'success' });
    assert.deepStrictEqual(editor.events().map((e) => e.runId), ['r1']);
    assert.deepStrictEqual(owner.events().map((e) => e.runId), ['r1', 'r2']);
    assert.deepStrictEqual(stranger.events(), []);
    for (const s of [editor, owner, stranger]) s.close();
});

test('an event without startedByUserId is scoped to its owner, as before', async () => {
    const editor = await subscribe('editor3');
    emitRunEvent('run.started', { runId: 'r3', automationId: 'a1', userId: 'owner1', rootRunId: 'r3' });
    assert.deepStrictEqual(editor.events(), []);
    editor.close();
});

test('the automation scope still narrows the starter\'s stream', async () => {
    const editor = await subscribe('editor3', { automationId: 'a2' });
    emitRunEvent('run.started', { runId: 'r4', automationId: 'a1', userId: 'owner1', startedByUserId: 'editor3' });
    emitRunEvent('run.started', { runId: 'r5', automationId: 'a2', userId: 'owner1', startedByUserId: 'editor3' });
    assert.deepStrictEqual(editor.events().map((e) => e.runId), ['r5']);
    editor.close();
});

test('a run on its starter\'s own connections still streams no data to anyone', async () => {
    const editor = await subscribe('editor3');
    const owner = await subscribe('owner1');
    const run = { id: 'r6', rootRunId: 'r6', connectionsMode: 'caller', startedByUserId: 'editor3' };
    const emit = makeLifecycleEmitter({ run, automation: { id: 'a1', userId: 'owner1' }, effectiveMode: 'live' });
    emit('run.failed', { status: 'error', errorClass: 'Boom', error: 'secret detail of the starter', summary: 'their data' });
    emitRunClosed({ ...run, automationId: 'a1', userId: 'owner1' }, { status: 'cancelled', summary: 'Closed without an answer' });
    for (const sub of [owner, editor]) {
        const got = sub.events().filter((e) => e.runId === 'r6');
        // The lifecycle emitter stamps startedByUserId once WI-01 lands; the
        // closed-run emitter always does. Whoever receives them gets no data.
        for (const e of got) {
            assert.strictEqual(e.error, undefined, JSON.stringify(e));
            assert.strictEqual(e.summary, undefined, JSON.stringify(e));
        }
    }
    assert.ok(owner.events().some((e) => e.runId === 'r6' && e.status === 'error'), 'the owner hears the failure');
    assert.ok(editor.events().some((e) => e.runId === 'r6' && e.status === 'cancelled'), 'the starter hears the close');
    owner.close(); editor.close();
});
