/**
 * Framing and sealing of stored co-editing bytes (core/collab/frame.js).
 *
 * Proven: a sealed frame round-trips; the header is 0x01 and the payload is
 * not the plaintext; the binding (document, seq, slot) and the key are part of
 * the tag, so a frame moved or tampered with does not open; a plaintext frame
 * is refused; snapshots deflate and inflation is capped; a missing project key
 * is a 503 with a code and no plaintext fallback; 'e2e' documents are refused.
 *
 * Run: cd server && node --test core/collab/frame.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const zlib = require('zlib');
const F = require('./frame');

const KEY = crypto.randomBytes(32);
const DOC = { id: 'doc-1', projectId: 'p1', orgId: 'org1' };

test('a sealed frame round-trips, and the header names the format', () => {
    const plain = Buffer.from('some yjs bytes');
    const frame = F.sealFrame(plain, KEY, F.updateAad('d', 3));
    assert.strictEqual(frame[0], F.FRAME_AES_GCM_V1);
    assert.strictEqual(F.frameFormat(frame), 'aes-gcm-v1');
    assert.ok(!frame.includes(plain), 'the payload is not the plaintext');
    assert.deepStrictEqual(F.openFrame(frame, { key: KEY, aad: F.updateAad('d', 3) }), plain);
    assert.strictEqual(F.frameFormat(Buffer.from([0x00, 1])), 'plain');
    assert.strictEqual(F.frameFormat(Buffer.from([0x07])), 'unknown');
});

test('the binding, the key and every byte are part of the tag', () => {
    const frame = F.sealFrame(Buffer.from('x'), KEY, F.updateAad('d', 3));
    assert.throws(() => F.openFrame(frame, { key: KEY, aad: F.updateAad('d', 4) }), F.CollabFrameError, 'another seq');
    assert.throws(() => F.openFrame(frame, { key: KEY, aad: F.updateAad('e', 3) }), F.CollabFrameError, 'another document');
    assert.throws(() => F.openFrame(frame, { key: KEY, aad: F.snapshotAad('d', 3) }), F.CollabFrameError, 'another slot');
    assert.throws(() => F.openFrame(frame, { key: crypto.randomBytes(32), aad: F.updateAad('d', 3) }), F.CollabFrameError, 'another key');
    const tampered = Buffer.from(frame);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => F.openFrame(tampered, { key: KEY, aad: F.updateAad('d', 3) }), F.CollabFrameError);
    assert.throws(() => F.openFrame(frame.subarray(0, 10), { key: KEY, aad: F.updateAad('d', 3) }), /too short/);
});

test('a plaintext or unknown frame is refused unless explicitly allowed', () => {
    const plain = Buffer.from([F.FRAME_PLAIN, 1, 2, 3]);
    assert.throws(() => F.openFrame(plain, { key: KEY, aad: 'a' }), /plaintext frame is not accepted/);
    assert.deepStrictEqual([...F.openFrame(plain, { key: KEY, aad: 'a', allowPlain: true })], [1, 2, 3]);
    assert.throws(() => F.openFrame(Buffer.from([0x09, 1]), { key: KEY, aad: 'a' }), /Unknown frame format/);
    assert.throws(() => F.openFrame(Buffer.alloc(0), { key: KEY, aad: 'a' }), /Empty frame/);
});

test('document keys are per document and distinct from the project key', () => {
    const a = F.docKey(KEY, 'd1');
    const b = F.docKey(KEY, 'd2');
    assert.strictEqual(a.length, 32);
    assert.notDeepStrictEqual(a, b);
    assert.notDeepStrictEqual(a, KEY);
    assert.deepStrictEqual(F.docKey(KEY, 'd1'), a, 'deterministic');
    assert.throws(() => F.docKey(Buffer.alloc(16), 'd1'), /32 bytes/);
});

test('forDoc seals updates, snapshots and checkpoints under their own bindings', async () => {
    const c = await F.makeCollabCrypto({ getProjectKey: async () => KEY }).forDoc(DOC);
    const update = Buffer.from('update-bytes');
    assert.deepStrictEqual(c.openUpdate(5, c.sealUpdate(5, update)), update);
    assert.throws(() => c.openUpdate(6, c.sealUpdate(5, update)), F.CollabFrameError);

    const state = Buffer.alloc(50_000, 7);
    const snap = c.sealSnapshot(9, state);
    assert.ok(snap.length < 2_000, 'a repetitive state deflates before sealing');
    assert.deepStrictEqual(c.openSnapshot(9, snap), state);
    assert.throws(() => c.openCheckpoint(9, snap), F.CollabFrameError, 'a snapshot is not a checkpoint');
    assert.deepStrictEqual(c.openCheckpoint(2, c.sealCheckpoint(2, state)), state);

    // The same bytes under another document's key do not open.
    const other = await F.makeCollabCrypto({ getProjectKey: async () => KEY }).forDoc({ ...DOC, id: 'doc-2' });
    assert.throws(() => other.openUpdate(5, c.sealUpdate(5, update)), F.CollabFrameError);
});

test('inflation is capped, so a crafted snapshot cannot expand without bound', async () => {
    const c = await F.makeCollabCrypto({ getProjectKey: async () => KEY }).forDoc(DOC);
    const bomb = zlib.deflateRawSync(Buffer.alloc(F.MAX_INFLATED_BYTES + 1024));
    const frame = F.sealFrame(bomb, F.docKey(KEY, DOC.id), F.snapshotAad(DOC.id, 1));
    assert.throws(() => c.openSnapshot(1, frame), /could not be inflated/);
});

test('no project key is a 503 with a code, before anything is sealed', async () => {
    const failing = F.makeCollabCrypto({ getProjectKey: async () => { throw new Error('vault down'); } });
    await assert.rejects(failing.forDoc(DOC), (err) => err.status === 503 && err.code === F.KEY_UNAVAILABLE_CODE && !/vault/.test(err.message));
    const short = F.makeCollabCrypto({ getProjectKey: async () => Buffer.alloc(8) });
    await assert.rejects(short.forDoc(DOC), (err) => err.status === 503);
});

test('an all-zero project key (a cleared cache Buffer) is a 503, never a key to seal with', async () => {
    const zeroed = F.makeCollabCrypto({ getProjectKey: async () => Buffer.alloc(32) });
    await assert.rejects(zeroed.forDoc(DOC), (err) => err.status === 503 && err.code === F.KEY_UNAVAILABLE_CODE);
});

test('the key comes from the project and its organisation; e2e documents are refused', async () => {
    const asked = [];
    const cc = F.makeCollabCrypto({ getProjectKey: async (projectId, orgId) => { asked.push([projectId, orgId]); return KEY; } });
    await cc.forDoc(DOC);
    assert.deepStrictEqual(asked, [['p1', 'org1']]);
    await assert.rejects(cc.forDoc({ ...DOC, keyScope: 'e2e' }), (err) => err.status === 409 && err.code === 'COLLAB_UNSUPPORTED');
    await assert.rejects(cc.forDoc({ id: 'x' }), /with a project is required/);
});
