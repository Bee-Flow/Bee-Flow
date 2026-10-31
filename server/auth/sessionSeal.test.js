// @typecheck strict
/**
 * The seal on what a session row holds (auth/sessionSeal.js).
 *
 * Run: cd server && node --test auth/sessionSeal.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionSealer, sealSessionStore, unsealedStoreView, isSealed, SEALED_FIELDS } = require('./sessionSeal');

const MASTER = 'a-master-key-of-at-least-thirty-two-characters';
const sealer = createSessionSealer(MASTER);

test('the four sensitive fields seal on the way in and open on the way out; the rest is untouched', () => {
    const session = {
        cookie: { maxAge: 1 }, user: { id: 'u1' }, isAuthenticated: true,
        encryptionKey: 'dek-base64', accessToken: 'at', refreshToken: 'rt',
        mfaPending: { userId: 'u1', derived: { encryptionKey: 'k' } },
    };
    const sealed = sealer.sealFields('sid-1', session);
    for (const f of SEALED_FIELDS) assert.ok(isSealed(sealed[f]), f);
    assert.deepEqual(sealed.user, { id: 'u1' });
    assert.equal(sealed.isAuthenticated, true);
    assert.notEqual(sealed, session, 'a copy: the live req.session keeps its plain values');
    assert.equal(session.encryptionKey, 'dek-base64');

    assert.deepEqual(sealer.unsealFields('sid-1', sealed), session);
});

test('a sealed value from one session does not open under another session id', () => {
    const sealed = sealer.sealFields('sid-1', { encryptionKey: 'dek' });
    const opened = sealer.unsealFields('sid-2', sealed);
    assert.equal(opened.encryptionKey, undefined, 'the field is absent, not wrong');
});

test('a row written before the seal existed is read as it is', () => {
    const plain = { user: { id: 'u1' }, encryptionKey: 'dek', accessToken: 'at' };
    assert.deepEqual(sealer.unsealFields('sid-1', plain), plain);
});

test('sealing twice is sealing once', () => {
    const once = sealer.sealFields('sid-1', { encryptionKey: 'dek' });
    const twice = sealer.sealFields('sid-1', once);
    assert.equal(twice.encryptionKey, once.encryptionKey);
});

test('two seals of the same value differ (a fresh nonce each time) and both open', () => {
    const a = sealer.seal('ctx', 'v');
    const b = sealer.seal('ctx', 'v');
    assert.notEqual(a, b);
    assert.equal(sealer.unseal('ctx', a), 'v');
    assert.equal(sealer.unseal('ctx', b), 'v');
});

test('a damaged seal opens to undefined', () => {
    const a = sealer.seal('ctx', { k: 1 });
    assert.equal(sealer.unseal('ctx', a.slice(0, -4) + 'AAAA'), undefined);
});

test('a seal with a truncated tag is refused before the tag is compared', () => {
    const a = sealer.seal('ctx', { k: 1 });
    const [iv, tag, data] = a.slice('sealed:v1:'.length).split('.');
    assert.equal(Buffer.from(tag, 'base64url').length, 16, 'the full GCM tag is written');
    const shortTag = Buffer.from(tag, 'base64url').subarray(0, 12).toString('base64url');
    assert.equal(sealer.unseal('ctx', `sealed:v1:${iv}.${shortTag}.${data}`), undefined);
    assert.equal(sealer.unseal('ctx', `sealed:v1:${iv}..${data}`), undefined);
});

test('without a master key the sealer is the identity', () => {
    const none = createSessionSealer(undefined);
    assert.equal(none.enabled, false);
    const s = { encryptionKey: 'dek' };
    assert.equal(none.sealFields('sid', s), s);
    assert.equal(none.unsealFields('sid', s), s);
});

/** A store that remembers what it was handed. */
function fakeStore() {
    /** @type {Record<string, any>} */
    const rows = {};
    return {
        rows,
        get(/** @type {string} */ sid, /** @type {Function} */ cb) { cb(null, rows[sid] || null); },
        set(/** @type {string} */ sid, /** @type {any} */ sess, /** @type {Function} */ cb) { rows[sid] = sess; cb(null); },
        touch(/** @type {string} */ sid, /** @type {any} */ sess, /** @type {Function} */ cb) { rows[sid] = sess; cb(null); },
        destroy(/** @type {string} */ sid, /** @type {Function} */ cb) { delete rows[sid]; cb(null); },
    };
}

test('a sealed store writes sealed rows, reads them open, and keeps a view of its unsealed methods', async () => {
    const store = fakeStore();
    sealSessionStore(store, sealer);
    await new Promise((resolve) => store.set('s1', { user: { id: 'u1' }, encryptionKey: 'dek', cookie: {} }, resolve));
    assert.ok(isSealed(store.rows.s1.encryptionKey), 'what hit the store is sealed');
    assert.deepEqual(store.rows.s1.user, { id: 'u1' });

    const read = await new Promise((resolve) => store.get('s1', (/** @type {unknown} */ _e, /** @type {any} */ s) => resolve(s)));
    assert.equal(read.encryptionKey, 'dek');

    await new Promise((resolve) => store.touch('s1', { user: { id: 'u1' }, encryptionKey: 'dek', cookie: {} }, resolve));
    assert.ok(isSealed(store.rows.s1.encryptionKey), 'touch seals too');

    // The unsealed view hands back what the row holds, sealed — what a cache
    // between the seal and the store must see.
    const view = unsealedStoreView(store);
    const raw = await new Promise((resolve) => view.get('s1', (/** @type {unknown} */ _e, /** @type {any} */ s) => resolve(s)));
    assert.ok(isSealed(raw.encryptionKey));
    // The store's own get, sealed again over new methods, still opens.
    sealSessionStore(store, sealer);
    const again = await new Promise((resolve) => store.get('s1', (/** @type {unknown} */ _e, /** @type {any} */ s) => resolve(s)));
    assert.equal(again.encryptionKey, 'dek');
});

test('a missing row and a store error pass through the sealed get unchanged', async () => {
    const store = fakeStore();
    sealSessionStore(store, sealer);
    const missing = await new Promise((resolve) => store.get('nope', (/** @type {unknown} */ e, /** @type {any} */ s) => resolve([e, s])));
    assert.deepEqual(missing, [null, null]);
});
