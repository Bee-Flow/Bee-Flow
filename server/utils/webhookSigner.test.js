/**
 * getOrCreateSigningKey (utils/webhookSigner.js): reuse a stored key, and
 * when one has to be created lazily, audit it with the context configStore
 * actually reads.
 *
 * setSecret's third argument IS the audit context ({ orgId, userId,
 * integration }). This call used to pass { auditCtx: { … } }, so the audit
 * row got none of it. Found by the server typecheck.
 *
 * Run: cd server && node --test utils/webhookSigner.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getOrCreateSigningKey } = require('./webhookSigner');

function fakeStore(initial = {}) {
    const values = { ...initial };
    const writes = [];
    return {
        writes,
        async getSecret(key) { return values[key] ?? null; },
        async setSecret(key, value, auditCtx) { values[key] = value; writes.push({ key, value, auditCtx }); return true; },
    };
}

test('an existing key is returned and nothing is written', async () => {
    const stored = 'a'.repeat(64);
    const store = fakeStore({ org_webhook_signing_key_org1: stored });
    assert.strictEqual(await getOrCreateSigningKey('org1', { store }), stored);
    assert.deepStrictEqual(store.writes, []);
});

test('a missing key is created, stored, and audited with the context setSecret reads', async () => {
    const store = fakeStore();
    const key = await getOrCreateSigningKey('org1', { store });
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.strictEqual(store.writes.length, 1);
    const [{ key: name, value, auditCtx }] = store.writes;
    assert.strictEqual(name, 'org_webhook_signing_key_org1');
    assert.strictEqual(value, key);
    assert.deepStrictEqual(auditCtx, { orgId: 'org1', integration: 'webhook_signer' });
});

test('a too-short stored value is replaced, and no org id is refused', async () => {
    const store = fakeStore({ org_webhook_signing_key_org1: 'short' });
    assert.notStrictEqual(await getOrCreateSigningKey('org1', { store }), 'short');
    await assert.rejects(() => getOrCreateSigningKey('', { store }), /orgId required/);
});
