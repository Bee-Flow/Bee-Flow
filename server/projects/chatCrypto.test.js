/**
 * projects/chatCrypto.js — sealing team chat titles and messages with the
 * project key, with the key lookup injected (no module mocking, no database).
 *
 * Proven:
 *   - a title and a message round-trip, and what is stored is an envelope with
 *     no trace of the plaintext;
 *   - a flipped byte, a ciphertext moved to another message, another chat,
 *     the title slot or another project all fail loudly;
 *   - a stored value that is not an envelope is refused, never passed through;
 *   - a key lookup that throws, or answers something that is not a 32-byte
 *     key, is a 503 PROJECT_KEY_UNAVAILABLE with a readable message.
 *
 * Run: cd server && node --test projects/chatCrypto.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeChatCrypto, chatKey } = require('./chatCrypto');

const KEYS = new Map();
const keyOf = (projectId) => {
    if (!KEYS.has(projectId)) KEYS.set(projectId, crypto.randomBytes(32));
    return KEYS.get(projectId);
};
const seen = [];
const chatCrypto = makeChatCrypto({
    getProjectKey: async (projectId, orgId) => { seen.push([projectId, orgId]); return keyOf(projectId); },
});

const P1 = { id: 'p1', organizationId: 'org1' };
const P2 = { id: 'p2', organizationId: 'org1' };

test('a title and a message round-trip, and the stored form is an envelope', async () => {
    const box = await chatCrypto.forProject(P1);
    assert.deepStrictEqual(seen.at(-1), ['p1', 'org1'], 'the key is asked for with the project and its org');
    const title = box.sealTitle('c1', 'Launch plan');
    const body = box.sealContent('c1', 'm1', 'Anna, can you send the draft? 🚀');
    for (const stored of [title, body]) {
        const env = JSON.parse(stored);
        assert.strictEqual(env._bfenc, 1);
        assert.strictEqual(env.alg, 'A256GCM');
        assert.ok(!stored.includes('Launch') && !stored.includes('Anna'), 'no plaintext in the stored value');
    }
    assert.strictEqual(box.openTitle('c1', title), 'Launch plan');
    assert.strictEqual(box.openContent('c1', 'm1', body), 'Anna, can you send the draft? 🚀');
    assert.notStrictEqual(box.sealContent('c1', 'm1', 'same'), box.sealContent('c1', 'm1', 'same'), 'a fresh IV per seal');
});

test('tampering and misplacement fail loudly', async () => {
    const box = await chatCrypto.forProject(P1);
    const body = box.sealContent('c1', 'm1', 'the budget is 40k');
    const env = JSON.parse(body);
    const flipped = JSON.stringify({ ...env, ct: (env.ct[0] === 'a' ? 'b' : 'a') + env.ct.slice(1) });
    assert.throws(() => box.openContent('c1', 'm1', flipped), { code: 'FIELD_DECRYPT_FAILED' });
    assert.throws(() => box.openContent('c1', 'm2', body), { code: 'FIELD_DECRYPT_FAILED' }, 'moved to another message');
    assert.throws(() => box.openContent('c2', 'm1', body), { code: 'FIELD_DECRYPT_FAILED' }, 'moved to another chat');
    assert.throws(() => box.openTitle('c1', body), { code: 'FIELD_DECRYPT_FAILED' }, 'moved into the title');
    const other = await chatCrypto.forProject(P2);
    assert.throws(() => other.openContent('c1', 'm1', body), { code: 'FIELD_DECRYPT_FAILED' }, 'read with another project key');
});

test('a value that is not an envelope is refused, never read as the message', async () => {
    const box = await chatCrypto.forProject(P1);
    assert.throws(() => box.openContent('c1', 'm1', 'plain words'), { code: 'FIELD_DECRYPT_FAILED' });
    assert.throws(() => box.openTitle('c1', ''), { code: 'FIELD_DECRYPT_FAILED' });
});

test('a key that cannot be produced is a 503, not a plaintext write', async () => {
    const failing = makeChatCrypto({ getProjectKey: async () => { throw new Error('org_root_key could not be decrypted'); } });
    await assert.rejects(() => failing.forProject(P1), (err) => {
        assert.strictEqual(err.status, 503);
        assert.strictEqual(err.code, 'PROJECT_KEY_UNAVAILABLE');
        assert.strictEqual(err.expose, true);
        assert.match(err.message, /encryption key could not be loaded/);
        assert.doesNotMatch(err.message, /org_root_key/, 'the internal reason stays in the log');
        return true;
    });
    const wrongShape = makeChatCrypto({ getProjectKey: async () => Buffer.alloc(16) });
    await assert.rejects(() => wrongShape.forProject(P1), { status: 503, code: 'PROJECT_KEY_UNAVAILABLE' });
});

test('the chat key is bound to the chat', () => {
    const k = crypto.randomBytes(32);
    assert.notDeepStrictEqual(chatKey(k, 'c1'), chatKey(k, 'c2'));
    assert.deepStrictEqual(chatKey(k, 'c1'), chatKey(k, 'c1'));
    assert.throws(() => chatKey(Buffer.alloc(8), 'c1'));
});

test('a project key zeroed after forProject (an expired escrow cache entry) cannot change what gets sealed', async () => {
    // The escrow cache clears its Buffer when the entry expires. A request that
    // got the key just before, then awaited a mention lookup, used to derive
    // the chat key from 32 zero bytes: unreadable for members, readable for
    // anyone who knows the ids.
    const real = crypto.randomBytes(32);
    const handedOut = Buffer.from(real);
    const box = await makeChatCrypto({ getProjectKey: async () => handedOut }).forProject(P1);
    handedOut.fill(0);
    const body = box.sealContent('c1', 'm1', 'secret text');
    const reader = await makeChatCrypto({ getProjectKey: async () => Buffer.from(real) }).forProject(P1);
    assert.strictEqual(reader.openContent('c1', 'm1', body), 'secret text');
    const zeroBox = await makeChatCrypto({ getProjectKey: async () => crypto.randomBytes(32) }).forProject(P1);
    assert.throws(() => zeroBox.openContent('c1', 'm1', body), { code: 'FIELD_DECRYPT_FAILED' });
});

test('an all-zero project key is refused as unavailable, never used to seal', async () => {
    const zeroed = makeChatCrypto({ getProjectKey: async () => Buffer.alloc(32) });
    await assert.rejects(() => zeroed.forProject(P1), { status: 503, code: 'PROJECT_KEY_UNAVAILABLE' });
});
