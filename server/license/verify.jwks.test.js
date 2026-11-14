'use strict';

/**
 * license/verify.js resolvePublicKeyByKid against a key set (JWKS): which key
 * answers for a key id, how long a fetched key set is trusted, and what is
 * remembered for the day the key set no longer serves a key. The key set is a
 * stand-in `fetch`; the remembered keys go to a stand-in config store.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test license/verify.jwks.test.js
 */

process.env.NODE_ENV = 'test';
process.env.LICENSE_JWKS_URL = 'https://license.example.test/v1/jwks.json';
delete process.env.LICENSE_JWKS_CACHE_SECONDS;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeSwaps } = require('../testUtils/swaps');

const configStore = require('../stores/configStore');
const verify = require('./verify');
const { publicKey } = require('./licenseJwt.testkit');

const CACHE_MS = 300 * 1000;
/** A key the key set can serve under `kid`, and its PEM. @param {string} kid */
function servedKey(kid) {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid }, pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}
const pemOf = (/** @type {any} */ key) => (typeof key === 'string' ? key : key.export({ type: 'spki', format: 'pem' }).toString());

/** What the key set answers next, how often it was asked, and the config store's content. */
let keySet = { keys: /** @type {object[]} */ ([]) };
let fetches = 0;
/** @type {Map<string, any>} */
const config = new Map();
let clock = Date.now();

const { swap, restore } = makeSwaps();
before(() => {
    swap(globalThis, 'fetch', async () => { fetches++; return new Response(JSON.stringify(keySet), { status: 200 }); });
    swap(configStore, 'getConfig', async (/** @type {string} */ key) => config.get(key) ?? null);
    swap(configStore, 'setConfig', async (/** @type {string} */ key, /** @type {any} */ value) => { config.set(key, value); });
    swap(Date, 'now', () => clock);
    verify._setPublicKeyForTesting(publicKey);
});
after(() => { restore(); verify._setPublicKeyForTesting(null); });
// Each test starts past the previous one's key set: the first lookup asks again.
beforeEach(() => { clock += 2 * CACHE_MS; fetches = 0; config.clear(); });

/** Let the remembered-keys write, which is not awaited by the lookup, land. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a key id the key set serves answers with that key, and the key is remembered', async () => {
    const k1 = servedKey('kid-1');
    keySet = { keys: [k1.jwk, { ...servedKey('no-kid').jwk, kid: undefined }] };
    assert.equal(pemOf(await verify.resolvePublicKeyByKid('kid-1')), k1.pem);
    await settled();
    const known = config.get('beeflow_hub_known_signing_keys');
    assert.deepEqual(Object.keys(known), ['kid-1'], 'only a key with an id is remembered');
    assert.equal(known['kid-1'].pem, k1.pem);
});

test('a fetched key set answers for five minutes, then it is asked again', async () => {
    const k1 = servedKey('kid-1');
    keySet = { keys: [k1.jwk] };
    await verify.resolvePublicKeyByKid('kid-1');
    clock += CACHE_MS - 1;
    await verify.resolvePublicKeyByKid('kid-1');
    assert.equal(fetches, 1, 'inside the window: not asked again');

    const k2 = servedKey('kid-2');
    keySet = { keys: [k2.jwk] };
    clock += 1;
    assert.equal(pemOf(await verify.resolvePublicKeyByKid('kid-2')), k2.pem, 'at the end of the window the new key set is read');
    assert.equal(fetches, 2);
});

test('an empty key set is not trusted for the window: the next lookup asks again', async () => {
    keySet = { keys: [] };
    await verify.resolvePublicKeyByKid('kid-late');
    const late = servedKey('kid-late');
    keySet = { keys: [late.jwk] };
    assert.equal(pemOf(await verify.resolvePublicKeyByKid('kid-late')), late.pem);
    assert.equal(fetches, 2);
});

test('a key id nobody knows, and a token without a key id, fall back to the configured key', async () => {
    keySet = { keys: [servedKey('kid-1').jwk] };
    assert.equal(await verify.resolvePublicKeyByKid('kid-unknown'), publicKey);
    assert.equal(await verify.resolvePublicKeyByKid(''), publicKey);
});

test('a key the key set no longer serves is answered from memory, unless the key set revoked it', async () => {
    const rotated = servedKey('kid-rotated');
    config.set('beeflow_hub_known_signing_keys', { 'kid-rotated': { pem: rotated.pem, firstSeenAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() } });
    keySet = { keys: [servedKey('kid-current').jwk] };
    assert.equal(await verify.resolvePublicKeyByKid('kid-rotated'), rotated.pem);

    clock += 2 * CACHE_MS;
    keySet = /** @type {any} */ ({ keys: [servedKey('kid-current').jwk], revoked_kids: ['kid-rotated'] });
    assert.equal(await verify.resolvePublicKeyByKid('kid-rotated'), publicKey, 'revoked: the remembered key is not used');
    await settled();
    assert.equal('kid-rotated' in config.get('beeflow_hub_known_signing_keys'), false, 'and it is forgotten');
});
