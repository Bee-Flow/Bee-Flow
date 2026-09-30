/**
 * projects/comments/commentCrypto.js — sealing thread anchors and comment
 * bodies with the project key, with the key lookup injected (no module
 * mocking, no database).
 *
 * Proven:
 *   - an anchor and a comment round-trip, the stored form is an envelope with
 *     no trace of the plaintext, and a whole-item comment keeps a null anchor;
 *   - a flipped byte, a ciphertext moved to another comment, another thread,
 *     the anchor slot or another project all fail loudly;
 *   - the thread key differs from the team chat key for the same id;
 *   - a stored value that is not an envelope is refused, never passed through;
 *   - a key lookup that throws, or answers something that is not a 32-byte
 *     key, is a 503 PROJECT_KEY_UNAVAILABLE with a readable message.
 *
 * Run: cd server && node --test projects/comments/commentCrypto.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeCommentCrypto, threadKey } = require('./commentCrypto');
const { chatKey } = require('../chatCrypto');

const KEYS = new Map();
const keyOf = (projectId) => {
    if (!KEYS.has(projectId)) KEYS.set(projectId, crypto.randomBytes(32));
    return KEYS.get(projectId);
};
const asked = [];
const commentCrypto = makeCommentCrypto({
    getProjectKey: async (projectId, orgId) => { asked.push([projectId, orgId]); return keyOf(projectId); },
});

const P1 = { id: 'p1', organizationId: 'org1' };
const P2 = { id: 'p2', organizationId: 'org1' };
const ANCHOR = { quote: 'the budget is 40k', prefix: 'We agreed ', suffix: ' for Q3', blockIndex: 4 };

test('an anchor and a comment round-trip, and the stored form is an envelope', async () => {
    const box = await commentCrypto.forProject(P1);
    assert.deepStrictEqual(asked.at(-1), ['p1', 'org1'], 'the key is asked for with the project and its org');
    const anchor = box.sealAnchor('t1', ANCHOR);
    const body = box.sealContent('t1', 'c1', 'Is 40k still right, Anna? 🤔');
    for (const stored of [anchor, body]) {
        const env = JSON.parse(stored);
        assert.strictEqual(env._bfenc, 1);
        assert.strictEqual(env.alg, 'A256GCM');
        assert.ok(!stored.includes('budget') && !stored.includes('Anna'), 'no plaintext in the stored value');
    }
    assert.deepStrictEqual(box.openAnchor('t1', anchor), ANCHOR);
    assert.strictEqual(box.openContent('t1', 'c1', body), 'Is 40k still right, Anna? 🤔');
    assert.strictEqual(box.sealAnchor('t1', null), null, 'a comment on the whole item has no anchor');
    assert.strictEqual(box.openAnchor('t1', null), null);
    assert.notStrictEqual(box.sealContent('t1', 'c1', 'same'), box.sealContent('t1', 'c1', 'same'), 'a fresh IV per seal');
});

test('tampering and misplacement fail loudly', async () => {
    const box = await commentCrypto.forProject(P1);
    const body = box.sealContent('t1', 'c1', 'the budget is 40k');
    const env = JSON.parse(body);
    const flipped = JSON.stringify({ ...env, ct: (env.ct[0] === 'a' ? 'b' : 'a') + env.ct.slice(1) });
    assert.throws(() => box.openContent('t1', 'c1', flipped), { code: 'FIELD_DECRYPT_FAILED' });
    assert.throws(() => box.openContent('t1', 'c2', body), { code: 'FIELD_DECRYPT_FAILED' }, 'moved to another comment');
    assert.throws(() => box.openContent('t2', 'c1', body), { code: 'FIELD_DECRYPT_FAILED' }, 'moved to another thread');
    const anchorSlot = box.sealContent('t1', 't1', JSON.stringify(ANCHOR));
    assert.throws(() => box.openAnchor('t1', anchorSlot), { code: 'FIELD_DECRYPT_FAILED' }, 'a comment body is not an anchor');
    const other = await commentCrypto.forProject(P2);
    assert.throws(() => other.openContent('t1', 'c1', body), { code: 'FIELD_DECRYPT_FAILED' }, 'another project');
});

test('the thread key is its own, apart from the team chat key', () => {
    const key = crypto.randomBytes(32);
    assert.notDeepStrictEqual(threadKey(key, 'x1'), chatKey(key, 'x1'));
    assert.notDeepStrictEqual(threadKey(key, 'x1'), threadKey(key, 'x2'));
    assert.throws(() => threadKey(Buffer.alloc(16), 'x1'), /32 bytes/);
    assert.throws(() => threadKey(key, ''), /threadId/);
});

test('a stored value that is not an envelope is refused', async () => {
    const box = await commentCrypto.forProject(P1);
    assert.throws(() => box.openContent('t1', 'c1', 'plain words'), { code: 'FIELD_DECRYPT_FAILED' });
    assert.throws(() => box.openAnchor('t1', '{"quote":"x"}'), { code: 'FIELD_DECRYPT_FAILED' });
});

test('a key that cannot be produced is a 503 with a readable message', async () => {
    const throwing = makeCommentCrypto({ getProjectKey: async () => { throw new Error('vault sealed'); } });
    await assert.rejects(throwing.forProject(P1), (err) => {
        assert.strictEqual(err.status, 503);
        assert.strictEqual(err.code, 'PROJECT_KEY_UNAVAILABLE');
        assert.match(err.message, /Nothing was read or saved/);
        assert.doesNotMatch(err.message, /vault sealed/, 'the cause stays in the log');
        return true;
    });
    const short = makeCommentCrypto({ getProjectKey: async () => Buffer.alloc(8) });
    await assert.rejects(short.forProject(P1), { code: 'PROJECT_KEY_UNAVAILABLE' });
    await assert.rejects(commentCrypto.forProject(null), /project is required/);
});

test('a project key zeroed after forProject (an expired escrow cache entry) cannot change what gets sealed', async () => {
    // A reply or a new thread awaits a mention lookup before it seals; the
    // escrow cache may clear the Buffer it handed out in the meantime.
    const real = crypto.randomBytes(32);
    const handedOut = Buffer.from(real);
    const box = await makeCommentCrypto({ getProjectKey: async () => handedOut }).forProject(P1);
    handedOut.fill(0);
    const body = box.sealContent('t1', 'c1', 'secret comment');
    const anchor = box.sealAnchor('t1', ANCHOR);
    const reader = await makeCommentCrypto({ getProjectKey: async () => Buffer.from(real) }).forProject(P1);
    assert.strictEqual(reader.openContent('t1', 'c1', body), 'secret comment');
    assert.deepStrictEqual(reader.openAnchor('t1', anchor), ANCHOR);
});

test('an all-zero project key is refused as unavailable, never used to seal', async () => {
    const zeroed = makeCommentCrypto({ getProjectKey: async () => Buffer.alloc(32) });
    await assert.rejects(zeroed.forProject(P1), { status: 503, code: 'PROJECT_KEY_UNAVAILABLE' });
});
