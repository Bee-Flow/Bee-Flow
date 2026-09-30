/**
 * What the server accepts from a co-editing client (core/collab/wire.js).
 *
 * Proven: strict base64; per-update and per-batch caps with 413 codes; a
 * truncated or random buffer is refused; batches merge and report the client
 * ids with their end clocks; a delete-only update is not "empty"; state
 * vectors are validated; awareness is re-stamped with the session user
 * whatever the client claimed, capped, limited to one state, and leaves
 * produce a removal one clock ahead.
 *
 * Run: cd server && node --test core/collab/wire.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');
const W = require('./wire');

const b64 = (u) => Buffer.from(u).toString('base64');
const CAPS = { maxUpdateBytes: 1024, maxBatchBytes: 2048 };

function typedUpdates(text = 'hello') {
    const doc = new Y.Doc();
    const out = [];
    doc.on('update', (u) => out.push(u));
    const el = new Y.XmlElement('textblock');
    el.setAttribute('type', 'paragraph');
    const t = new Y.XmlText();
    el.insert(0, [t]);
    doc.getXmlFragment('content').insert(0, [el]);
    t.insert(0, text);
    return { doc, out, t };
}

test('base64 is strict', () => {
    assert.deepStrictEqual([...W.decodeB64('AAE=', 'x')], [0, 1]);
    for (const bad of ['AA E=', 'A', '!!!!', 12, null]) {
        assert.throws(() => W.decodeB64(bad, 'An update'), (e) => e.code === 'INVALID_ENCODING' && e.status === 400);
    }
});

test('a batch merges and reports each client id with its end clock', () => {
    const { doc, out, t } = typedUpdates();
    t.delete(0, 2);
    const batch = W.readUpdateBatch(out.map(b64), CAPS);
    assert.strictEqual(batch.empty, false);
    assert.deepStrictEqual(batch.clients, [{ clientId: doc.clientID, to: 8 }]);
    const replay = new Y.Doc();
    Y.applyUpdate(replay, batch.merged);
    assert.strictEqual(replay.getXmlFragment('content').toString(), doc.getXmlFragment('content').toString());
    // A delete-only update carries no structs but is a real change.
    const deleteOnly = W.readUpdateBatch([b64(out[out.length - 1])], CAPS);
    assert.strictEqual(deleteOnly.empty, false);
    assert.deepStrictEqual(deleteOnly.clients, []);
    // The empty update is empty.
    assert.strictEqual(W.readUpdateBatch([b64(Y.encodeStateAsUpdate(new Y.Doc()))], CAPS).empty, true);
});

test('caps: one change, and the batch together', () => {
    const { out } = typedUpdates('x'.repeat(1500));
    assert.throws(() => W.readUpdateBatch(out.map(b64), CAPS), (e) => e.code === 'UPDATE_TOO_LARGE' && e.status === 413);
    const small = typedUpdates('y'.repeat(700)).out;
    const batch = [...small, ...typedUpdates('z'.repeat(700)).out, ...typedUpdates('w'.repeat(700)).out].map(b64);
    assert.throws(() => W.readUpdateBatch(batch, CAPS), (e) => e.code === 'UPDATE_TOO_LARGE' && /together/.test(e.message));
});

test('a truncated or random buffer is refused', () => {
    const { out } = typedUpdates();
    const truncated = out[0].slice(0, out[0].length - 4);
    for (const bad of [truncated, new Uint8Array([5, 3, 200, 1]), new Uint8Array([255, 255, 255])]) {
        assert.throws(() => W.readUpdateBatch([b64(bad)], CAPS), (e) => e.code === 'INVALID_UPDATE' && e.status === 400);
    }
});

test('state vectors are validated; empty means "nothing yet"', () => {
    const { doc } = typedUpdates();
    const sv = Y.encodeStateVector(doc);
    assert.deepStrictEqual([...W.readStateVector(b64(sv), 1000)], [...sv]);
    assert.deepStrictEqual([...W.readStateVector('', 1000)], [0]);
    assert.throws(() => W.readStateVector(b64(new Uint8Array([3, 1])), 1000), (e) => e.code === 'INVALID_STATE_VECTOR');
    assert.throws(() => W.readStateVector(b64(sv), 1), (e) => e.code === 'INVALID_STATE_VECTOR');
});

function awarenessUpdate(state, doc = new Y.Doc()) {
    const aw = new awarenessProtocol.Awareness(doc);
    aw.setLocalState(state);
    const u = awarenessProtocol.encodeAwarenessUpdate(aw, [doc.clientID]);
    aw.destroy();
    return { u, clientId: doc.clientID };
}

test('awareness is re-stamped with the session user, whatever the client claimed', () => {
    const { u, clientId } = awarenessUpdate({ user: { id: 'mallory', name: 'Alice', color: '#123' }, cursor: { anchor: 'x' } });
    const stamped = W.stampAwareness(u, { userId: 'bob', maxStateBytes: 2048 });
    assert.strictEqual(stamped.clientId, clientId);
    const [entry] = W.decodeAwareness(stamped.update);
    assert.deepStrictEqual(entry.state.user, { id: 'bob', name: 'Alice', color: '#123' });
    assert.deepStrictEqual(entry.state.cursor, { anchor: 'x' });
    // Peers applying it see the stamped id.
    const peer = new awarenessProtocol.Awareness(new Y.Doc());
    awarenessProtocol.applyAwarenessUpdate(peer, stamped.update, 'remote');
    assert.strictEqual(peer.getStates().get(clientId).user.id, 'bob');
    peer.destroy();
    // A state with no user object gets one.
    const bare = W.stampAwareness(awarenessUpdate({ cursor: null }).u, { userId: 'bob', maxStateBytes: 2048 });
    assert.deepStrictEqual(W.decodeAwareness(bare.update)[0].state.user, { id: 'bob' });
});

test('awareness: size cap, one state per update, garbage refused, leaves one clock ahead', () => {
    assert.throws(() => W.stampAwareness(awarenessUpdate({ blob: 'x'.repeat(3000) }).u, { userId: 'bob', maxStateBytes: 2048 }),
        (e) => e.code === 'AWARENESS_TOO_LARGE' && e.status === 413);
    const two = W.encodeAwareness([{ clientId: 1, clock: 1, state: {} }, { clientId: 2, clock: 1, state: {} }]);
    assert.throws(() => W.stampAwareness(two, { userId: 'bob', maxStateBytes: 2048 }), /exactly one state/);
    assert.throws(() => W.stampAwareness(new Uint8Array([1, 2]), { userId: 'bob', maxStateBytes: 2048 }), (e) => e.code === 'INVALID_AWARENESS');
    assert.throws(() => W.stampAwareness(W.encodeAwareness([{ clientId: 1, clock: 1, state: [1] }]), { userId: 'b', maxStateBytes: 99 }), (e) => e.code === 'INVALID_AWARENESS');

    const removal = W.stampAwareness(W.encodeAwareness([{ clientId: 4, clock: 3, state: null }]), { userId: 'bob', maxStateBytes: 2048 });
    assert.strictEqual(removal.removed, true);

    const { u, clientId } = awarenessUpdate({ user: {} });
    const peer = new awarenessProtocol.Awareness(new Y.Doc());
    awarenessProtocol.applyAwarenessUpdate(peer, u, 'remote');
    assert.ok(peer.getStates().has(clientId));
    const [entry] = W.decodeAwareness(u);
    awarenessProtocol.applyAwarenessUpdate(peer, W.leaveAwareness(clientId, entry.clock), 'remote');
    assert.ok(!peer.getStates().has(clientId), 'the leave removes the state on peers');
    peer.destroy();
});
