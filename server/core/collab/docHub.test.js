/**
 * The per-replica fan-out of co-editing updates (core/collab/docHub.js),
 * over an in-memory log and bus. No module mocking, no timers left running.
 *
 * Proven: a local write reaches every subscriber at its cursor without a
 * database read; a remote doorbell reads the missing rows once for all
 * subscribers; a subscriber that joins behind catches up in one merged frame
 * that applies cleanly; frames never overtake each other when writes land
 * out of order; too far behind or behind retention → `doc.resync`; a full
 * socket pauses one subscriber without delaying the others, and `resume`
 * catches it up; awareness and queries go to this document's subscribers
 * only; `doc.closed` ends it; the poll backstop notices a write it was never
 * told about; the last leave releases the bus subscription.
 *
 * Run: cd server && node --test core/collab/docHub.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const Y = require('yjs');
const { makeDocHub, closedPayload } = require('./docHub');

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 10; i += 1) await tick(); }

function world() {
    const source = new Y.Doc();
    const text = source.getText('t');
    /** @type {Array<{ seq: number, u: Uint8Array, userId: string, origin: string, agentId: string|null }>} */
    const log = [];
    source.on('update', (u) => log.push({ seq: log.length + 1, u, userId: 'ann', origin: 'user', agentId: null }));
    const reads = [];
    const emitter = new EventEmitter();
    let retainedFrom = 1;
    const timers = [];
    const hub = makeDocHub({
        async listUpdates(docId, afterSeq, limit) {
            reads.push(afterSeq);
            return log.filter((r) => r.seq > afterSeq && r.seq >= retainedFrom).slice(0, limit)
                .map((r) => ({ seq: r.seq, body: Buffer.from(r.u), userId: r.userId, origin: r.origin, agentId: r.agentId }));
        },
        async readHead() { return { updateSeq: log.length }; },
        async openRows(_doc, rows) { return rows.map((r) => new Uint8Array(r.body)); },
        subscribeProject(projectId, handler) {
            emitter.on(projectId, handler);
            return () => emitter.off(projectId, handler);
        },
        isDistributed: () => false,
        backlogMax: 5,
        setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
        clearTimer: (t) => { t.cleared = true; },
        log: { warn() {} },
    });
    const doc = () => ({ id: 'd1', projectId: 'p1', updateSeq: log.length });
    /** A subscriber that records frames and can refuse writes. */
    function client(cursor) {
        const frames = [];
        const replica = new Y.Doc();
        // Everything up to `cursor` came from the sync response.
        for (const r of log.filter((x) => x.seq <= cursor)) Y.applyUpdate(replica, r.u);
        const c = {
            frames, replica, full: false,
            send(kind, payload) {
                frames.push({ kind, payload });
                if (kind === 'doc.update') Y.applyUpdate(replica, Buffer.from(payload.u, 'base64'));
                return !c.full;
            },
        };
        return c;
    }
    return { source, text, log, reads, emitter, hub, doc, client, timers, setRetained: (n) => { retainedFrom = n; } };
}

test('a local write reaches every subscriber at its cursor, with no database read', async () => {
    const w = world();
    w.text.insert(0, 'hi');
    const a = w.client(1);
    const b = w.client(1);
    w.hub.join(w.doc(), { cursor: 1, send: a.send });
    w.hub.join(w.doc(), { cursor: 1, send: b.send });
    await settle();
    w.text.insert(2, '!');
    w.hub.localAppend('d1', { seq: 2, u: w.log[1].u, by: 'bob' });
    await settle();
    assert.deepStrictEqual(w.reads, []);
    for (const c of [a, b]) {
        assert.strictEqual(c.frames.length, 1);
        assert.deepStrictEqual({ ...c.frames[0].payload, u: undefined }, { docId: 'd1', from: 1, seq: 2, u: undefined, by: ['bob'] });
        assert.strictEqual(c.replica.getText('t').toString(), 'hi!');
    }
});

test('a doorbell from another replica reads the missing rows once for everyone', async () => {
    const w = world();
    const a = w.client(0);
    const b = w.client(0);
    w.hub.join(w.doc(), { cursor: 0, send: a.send });
    w.hub.join(w.doc(), { cursor: 0, send: b.send });
    await settle();
    w.text.insert(0, 'abc');
    w.text.insert(3, 'd');
    w.emitter.emit('p1', { kind: 'doc.moved', docId: 'd1', seq: 2, transient: true });
    w.emitter.emit('p1', { kind: 'doc.moved', docId: 'other', seq: 9, transient: true });
    await settle();
    assert.deepStrictEqual(w.reads, [0], 'one read, shared');
    for (const c of [a, b]) {
        assert.strictEqual(c.frames.length, 1, 'one merged frame');
        assert.strictEqual(c.frames[0].payload.from, 0);
        assert.strictEqual(c.frames[0].payload.seq, 2);
        assert.deepStrictEqual(c.frames[0].payload.by, ['ann']);
        assert.strictEqual(c.replica.getText('t').toString(), 'abcd');
    }
});

test('a subscriber joining behind catches up in order; out-of-order local writes never overtake', async () => {
    const w = world();
    for (const ch of 'xyz') w.text.insert(w.text.length, ch);
    const late = w.client(1);
    w.hub.join(w.doc(), { cursor: 1, send: late.send });
    await settle();
    assert.strictEqual(late.replica.getText('t').toString(), 'xyz');
    assert.strictEqual(late.frames.at(-1).payload.seq, 3);
    // Seq 5 announced before seq 4 (two requests committing in parallel).
    w.text.insert(3, '1');
    w.text.insert(4, '2');
    w.hub.localAppend('d1', { seq: 5, u: w.log[4].u, by: 'ann' });
    await settle();
    assert.strictEqual(late.frames.at(-1).payload.seq, 5, 'the gap was filled from the log, in order');
    w.hub.localAppend('d1', { seq: 4, u: w.log[3].u, by: 'ann' });
    await settle();
    const seqs = late.frames.filter((f) => f.kind === 'doc.update').map((f) => [f.payload.from, f.payload.seq]);
    for (let i = 1; i < seqs.length; i += 1) assert.strictEqual(seqs[i][0], seqs[i - 1][1], 'each frame starts where the last ended');
    assert.strictEqual(late.replica.getText('t').toString(), 'xyz12');
});

test('too far behind, or behind retention, is a resync', async () => {
    const w = world();
    for (let i = 0; i < 8; i += 1) w.text.insert(0, 'a');
    const far = w.client(0);
    w.hub.join(w.doc(), { cursor: 0, send: far.send });
    await settle();
    assert.deepStrictEqual(far.frames[0], { kind: 'doc.resync', payload: { docId: 'd1', reason: 'backlog' } });

    const w2 = world();
    for (let i = 0; i < 4; i += 1) w2.text.insert(0, 'b');
    w2.setRetained(3);
    const old = w2.client(1);
    w2.hub.join(w2.doc(), { cursor: 1, send: old.send });
    await settle();
    assert.deepStrictEqual(old.frames[0], { kind: 'doc.resync', payload: { docId: 'd1', reason: 'behind_retention' } });

    const w3 = world();
    const future = w3.client(0);
    w3.hub.join(w3.doc(), { cursor: 7, send: future.send });
    assert.strictEqual(future.frames[0].kind, 'doc.resync', 'a cursor past the head is another incarnation');
});

test('a full socket pauses one subscriber without delaying the others', async () => {
    const w = world();
    w.text.insert(0, 'a');
    const slow = w.client(1);
    const fast = w.client(1);
    const joined = w.hub.join(w.doc(), { cursor: 1, send: slow.send });
    w.hub.join(w.doc(), { cursor: 1, send: fast.send });
    slow.full = true;
    w.text.insert(1, 'b');
    w.hub.localAppend('d1', { seq: 2, u: w.log[1].u, by: 'ann' });
    await settle();
    w.text.insert(2, 'c');
    w.hub.localAppend('d1', { seq: 3, u: w.log[2].u, by: 'ann' });
    await settle();
    assert.strictEqual(fast.replica.getText('t').toString(), 'abc');
    assert.strictEqual(slow.frames.length, 1, 'paused after the write the socket refused');
    slow.full = false;
    w.hub.resume('d1', joined.subscriber);
    await settle();
    assert.strictEqual(slow.replica.getText('t').toString(), 'abc');
});

test('awareness and queries reach this document\'s subscribers only; doc.closed ends it', async () => {
    const w = world();
    const a = w.client(0);
    w.hub.join(w.doc(), { cursor: 0, send: a.send });
    w.emitter.emit('p1', { kind: 'doc.awareness', docId: 'd1', u: 'AQID', transient: true });
    w.emitter.emit('p1', { kind: 'doc.awareness', docId: 'd2', u: 'BBBB', transient: true });
    w.emitter.emit('p1', { kind: 'doc.awareness.query', docId: 'd1', transient: true });
    w.emitter.emit('p1', { kind: 'doc.closed', docId: 'd1', reason: 'detached', transient: true });
    assert.deepStrictEqual(a.frames, [
        { kind: 'doc.awareness', payload: { docId: 'd1', u: 'AQID' } },
        { kind: 'doc.awareness.query', payload: { docId: 'd1' } },
        { kind: 'doc.closed', payload: { docId: 'd1', reason: 'detached' } },
    ]);
    assert.strictEqual(w.hub.subscriberCount('d1'), 0);
    assert.strictEqual(w.emitter.listenerCount('p1'), 0, 'bus subscription released');
});

test('the poll notices a write nobody rang for, and the last leave stops it', async () => {
    const w = world();
    const a = w.client(0);
    const joined = w.hub.join(w.doc(), { cursor: 0, send: a.send });
    assert.strictEqual(w.timers.length, 1);
    assert.strictEqual(w.timers[0].ms, 1500, 'fast backstop without a distributed bus');
    w.text.insert(0, 'q');
    await w.timers[0].fn();
    await settle();
    assert.strictEqual(a.replica.getText('t').toString(), 'q');
    assert.strictEqual(w.timers.length, 2, 'rescheduled');
    joined.leave();
    assert.strictEqual(w.timers[1].cleared, true);
    assert.deepStrictEqual(w.hub.activeDocs(), []);
});

test('doc.closed speaks the editor\'s words: switched off or unavailable reads as detached, never as lost access', async () => {
    assert.deepStrictEqual(closedPayload('d1', 'disabled'), { docId: 'd1', reason: 'detached', cause: 'disabled' });
    assert.deepStrictEqual(closedPayload('d1', 'unavailable'), { docId: 'd1', reason: 'detached', cause: 'unavailable' });
    assert.deepStrictEqual(closedPayload('d1', 'detached'), { docId: 'd1', reason: 'detached' });
    assert.deepStrictEqual(closedPayload('d1', 'deleted'), { docId: 'd1', reason: 'deleted' });
    assert.deepStrictEqual(closedPayload('d1', 'not_found'), { docId: 'd1', reason: 'not_found' });

    // A switch-off on another replica arrives over the bus with the server's reason.
    const w = world();
    const a = w.client(0);
    w.hub.join(w.doc(), { cursor: 0, send: a.send });
    w.emitter.emit('p1', { kind: 'doc.closed', docId: 'd1', reason: 'disabled', transient: true });
    assert.deepStrictEqual(a.frames.at(-1), { kind: 'doc.closed', payload: { docId: 'd1', reason: 'detached', cause: 'disabled' } });
});
