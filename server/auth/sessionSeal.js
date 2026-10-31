// @typecheck strict
/**
 * What a session carries that must not be readable where sessions are stored.
 *
 * A session row holds the data-encryption key of the signed-in person for the
 * life of the session, the OAuth access and refresh tokens of their provider,
 * and — between the password step and the second factor — what the pending
 * login still needs. All of it sat in `user_sessions` and in the Redis cache
 * as plain JSON, so a copy of either (a backup, a replica, a read anywhere)
 * held every live key.
 *
 * Here those fields are sealed on the way INTO the store and opened on the
 * way OUT, under a key derived from MASTER_ENCRYPTION_KEY and the session id:
 * the master key never reaches the database, and a sealed value lifted from
 * one row does not open under another session's id. Every reader of
 * `req.session.encryptionKey` and friends sees the plain value as before; the
 * seal lives at the store boundary (boot/session.js, utils/sessionToken.js),
 * not at the twenty places that read the fields.
 *
 * A row holding a plain value (no seal on it) is read as it is and sealed on
 * its next write, so nothing has to be migrated.
 */

const crypto = require('crypto');
const { fallback } = require('../utils/bestEffort');

const PREFIX = 'sealed:v1:';
const SALT = 'beeflow-session-seal-v1';
/** GCM's full tag; a shorter one is refused before it is even compared. */
const TAG_BYTES = 16;

/** The session fields that are sealed. `mfaPending` is an object: sealed whole. */
const SEALED_FIELDS = Object.freeze(['encryptionKey', 'accessToken', 'refreshToken', 'mfaPending']);

/**
 * @typedef {{
 *   seal(context: string, value: unknown): string,
 *   unseal(context: string, stored: unknown): unknown,
 *   sealFields(context: string, session: Record<string, any>): Record<string, any>,
 *   unsealFields(context: string, session: Record<string, any>): Record<string, any>,
 *   isSealed(value: unknown): boolean,
 *   enabled: boolean,
 * }} SessionSealer
 */

/**
 * @typedef {(err: unknown, session?: Record<string, any> | null) => void} GetCallback
 * @typedef {(err?: unknown) => void} DoneCallback
 * @typedef {{
 *   get: (sid: string, cb: GetCallback) => void,
 *   set: (sid: string, session: Record<string, any>, cb: DoneCallback) => void,
 *   touch?: (sid: string, session: Record<string, any>, cb: DoneCallback) => void,
 *   destroy?: (sid: string, cb: DoneCallback) => void,
 * }} SealableStore
 */

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isSealed(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * The sealer. Without a master key (a test, or a tool run outside the server)
 * it is the identity: values pass through unchanged in both directions, which
 * is what the server itself never runs with — boot refuses to start without
 * the key.
 *
 * @param {string | undefined} masterKey
 * @returns {SessionSealer}
 */
function createSessionSealer(masterKey) {
    if (!masterKey) {
        return {
            enabled: false,
            isSealed,
            seal: (_c, value) => /** @type {string} */ (value),
            unseal: (_c, stored) => stored,
            sealFields: (_c, s) => s,
            unsealFields: (_c, s) => s,
        };
    }
    const ikm = Buffer.from(masterKey, 'utf8');

    /** @param {string} context */
    function keyFor(context) {
        return Buffer.from(crypto.hkdfSync('sha256', ikm, SALT, `session:${context}`, 32));
    }

    /**
     * @param {string} context
     * @param {unknown} value
     */
    function seal(context, value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(context), iv, { authTagLength: TAG_BYTES });
        const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        return `${PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
    }

    /**
     * A sealed value under the wrong context, or a damaged one, opens to
     * `undefined`: the field is then absent, which every reader already
     * handles as "no key / no token", rather than a value that is wrong.
     * @param {string} context
     * @param {unknown} stored
     */
    function unseal(context, stored) {
        if (!isSealed(stored)) return stored;
        try {
            const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split('.');
            const tag = Buffer.from(tagB64, 'base64url');
            if (tag.length !== TAG_BYTES) return undefined;
            const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(context), Buffer.from(ivB64, 'base64url'), { authTagLength: TAG_BYTES });
            decipher.setAuthTag(tag);
            const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
            return JSON.parse(plain.toString('utf8'));
        } catch (e) {
            // Logged, not thrown: the field is dropped and the session goes on
            // without it, which every reader already handles.
            return fallback('sessionSeal:unseal', e, undefined);
        }
    }

    /**
     * A copy of the session with the sensitive fields sealed. A copy, not the
     * object itself: express-session keeps using the live `req.session` after
     * the store write, and a sealed value there would be read back as a key.
     * @param {string} context
     * @param {Record<string, any>} session
     */
    function sealFields(context, session) {
        if (!session || typeof session !== 'object') return session;
        /** @type {Record<string, any>} */
        const out = { ...session };
        for (const field of SEALED_FIELDS) {
            const value = out[field];
            if (value === undefined || value === null || isSealed(value)) continue;
            out[field] = seal(context, value);
        }
        return out;
    }

    /**
     * @param {string} context
     * @param {Record<string, any>} session
     */
    function unsealFields(context, session) {
        if (!session || typeof session !== 'object') return session;
        /** @type {Record<string, any>} */
        const out = { ...session };
        for (const field of SEALED_FIELDS) {
            if (!isSealed(out[field])) continue;
            const value = unseal(context, out[field]);
            if (value === undefined) delete out[field];
            else out[field] = value;
        }
        return out;
    }

    return { enabled: true, isSealed, seal, unseal, sealFields, unsealFields };
}

/**
 * Put the seal on a session store, outermost: `set` and `touch` seal what
 * they are handed, `get` opens what comes back. Installed on the object in
 * place, the way the Redis cache is (auth/sessionCache.js), so express-session
 * keeps the store it was given. The context is the session id.
 *
 * @param {SealableStore} store
 * @param {SessionSealer} sealer
 */
function sealSessionStore(store, sealer) {
    if (!sealer.enabled) return store;
    const _get = store.get.bind(store);
    const _set = store.set.bind(store);
    const _touch = typeof store.touch === 'function' ? store.touch.bind(store) : null;
    // The methods as they were BEFORE the first seal: what a layer that wants
    // to sit under the seal (the Redis cache) wraps, so that it caches sealed
    // rows and never sees an opened one. Recorded once; a later re-seal (after
    // the cache was put in) wraps the then-current methods and leaves this.
    if (!RAW.has(store)) {
        RAW.set(store, {
            get: _get, set: _set, touch: _touch,
            destroy: typeof store.destroy === 'function' ? store.destroy.bind(store) : undefined,
        });
    }

    store.set = function set(/** @type {string} */ sid, /** @type {Record<string, any>} */ session, /** @type {DoneCallback} */ cb) {
        return _set(sid, sealer.sealFields(sid, session), cb);
    };
    store.get = function get(/** @type {string} */ sid, /** @type {GetCallback} */ cb) {
        return _get(sid, (/** @type {unknown} */ err, /** @type {Record<string, any> | null | undefined} */ session) => {
            if (err || !session) return cb(err, session);
            cb(null, sealer.unsealFields(sid, session));
        });
    };
    if (_touch) {
        store.touch = function touch(/** @type {string} */ sid, /** @type {Record<string, any>} */ session, /** @type {DoneCallback} */ cb) {
            return _touch(sid, sealer.sealFields(sid, session), cb);
        };
    }
    return store;
}

/** @type {WeakMap<object, { get: SealableStore['get'], set: SealableStore['set'], touch: SealableStore['touch'] | null, destroy?: SealableStore['destroy'] }>} */
const RAW = new WeakMap();

/**
 * The store's methods as they were under the seal, as a store-shaped object —
 * or the store itself when no seal is on it.
 * @param {SealableStore} store
 * @returns {SealableStore}
 */
function unsealedStoreView(store) {
    const raw = RAW.get(store);
    if (!raw) return store;
    return {
        get: raw.get, set: raw.set,
        ...(raw.touch ? { touch: raw.touch } : {}),
        ...(raw.destroy ? { destroy: raw.destroy } : {}),
    };
}

/** @type {SessionSealer | null} */
let _default = null;

/** The server's own sealer, keyed by MASTER_ENCRYPTION_KEY. Built once. */
function defaultSealer() {
    if (!_default) _default = createSessionSealer(process.env.MASTER_ENCRYPTION_KEY);
    return _default;
}

/** FOR TESTS: forget the cached default so a changed environment is picked up. */
function _resetDefaultSealerForTests() {
    _default = null;
}

module.exports = { createSessionSealer, sealSessionStore, unsealedStoreView, defaultSealer, isSealed, SEALED_FIELDS, _resetDefaultSealerForTests };
