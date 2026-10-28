// @typecheck
const log = require('../telemetry/log');
const crypto = require('crypto');
const opaque = require('@serenity-kit/opaque');
const { getRedis } = require('../db');
const { z, typeError } = require('../utils/zod');
const { worded } = require('../core/http/schemaParts');

/**
 * Get or create the OPAQUE server setup.
 * Stored in OPAQUE_SERVER_SETUP env var.
 * If not set, generates one and logs a warning.
 */
function getServerSetup() {
    if (process.env.OPAQUE_SERVER_SETUP) {
        return process.env.OPAQUE_SERVER_SETUP;
    }
    // Auto-generate for development — MUST be persisted in production
    if (!global._opaqueServerSetup) {
        global._opaqueServerSetup = opaque.server.createSetup();
        log.warn('[OPAQUE] ⚠️  No OPAQUE_SERVER_SETUP env var found — generated ephemeral setup.');
        log.warn('[OPAQUE] ⚠️  Set OPAQUE_SERVER_SETUP in .env for production. Changing it invalidates all registrations.');
        // The setup IS the server's long-term OPAQUE secret. Printing it
        // here would ship it to the log pipeline (OpenObserve) in
        // cleartext. Write it to stdout only when explicitly asked for during
        // local bootstrap, never by default.
        if (process.env.OPAQUE_PRINT_GENERATED_SETUP === '1') {
            log.warn('[OPAQUE] Generated setup (OPAQUE_PRINT_GENERATED_SETUP=1):', global._opaqueServerSetup);
        } else {
            log.warn('[OPAQUE] Re-run with OPAQUE_PRINT_GENERATED_SETUP=1 to print the generated value for persisting.');
        }
        // A per-replica ephemeral setup also means logins succeed or fail
        // depending on which pod answers, and every restart invalidates all
        // registrations. Make that loud in production rather than a warning
        // buried in startup noise.
        if (process.env.NODE_ENV === 'production') {
            log.error('[OPAQUE] ⚠️  CRITICAL: running with an ephemeral per-replica OPAQUE setup in production. OPAQUE logins will be non-deterministic across replicas and will break on restart. Set OPAQUE_SERVER_SETUP.');
        }
    }
    return global._opaqueServerSetup;
}

// Pending login state — Redis-backed with in-memory fallback
const _pendingFallback = new Map();

const PENDING_TTL = 120; // seconds

async function getPendingLogin(loginId) {
    const r = getRedis();
    if (r) {
        const val = await r.get(`bf:opaque:${loginId}`);
        return val ? JSON.parse(val) : null;
    }
    const entry = _pendingFallback.get(loginId);
    if (entry && Date.now() - entry.created > PENDING_TTL * 1000) {
        _pendingFallback.delete(loginId);
        return null;
    }
    return entry || null;
}

async function setPendingLogin(loginId, data) {
    const r = getRedis();
    if (r) {
        await r.set(`bf:opaque:${loginId}`, JSON.stringify(data), 'EX', PENDING_TTL);
    } else {
        _pendingFallback.set(loginId, { ...data, created: Date.now() });
    }
}

async function deletePendingLogin(loginId) {
    const r = getRedis();
    if (r) {
        await r.del(`bf:opaque:${loginId}`);
    } else {
        _pendingFallback.delete(loginId);
    }
}

// ============================================================
// FAKE CREDENTIALS — the "dummy response" login/start always promised
// ============================================================
//
// An unknown-user branch answering 401 while a registered account gets 200
// with a loginResponse, and a legacy account 400 {useLegacy:true}, makes three
// distinguishable outcomes, one request each: an account-existence oracle that
// needs no timing measurement at all. OPAQUE supports a dummy response via fake
// credentials, which is what the unknown-user branch builds.
//
// OPAQUE is designed for exactly this. server.startLogin masks the envelope with
// a fresh nonce per call, so a response computed from a record the caller cannot
// decrypt is indistinguishable from a real one. Authentication then fails at
// login/finish, which is where a wrong password is supposed to fail.
//
// Synthesising a record costs ~215 ms, far too much to do per request — that
// would trade an oracle for a CPU-exhaustion lever. So a small pool is built
// once and a username is mapped onto it with an HMAC keyed by a process secret:
// the same absent name always yields the same record, and the mapping cannot be
// predicted from outside.
const FAKE_RECORD_POOL_SIZE = 4;

/** @type {Promise<string[]> | null} */
let _fakeRecordsPromise = null;

/** @type {NonSharedBuffer | null} */
let _fakeKey = null;

function fakeKey() {
    if (!_fakeKey) _fakeKey = crypto.randomBytes(32);
    return _fakeKey;
}

function buildFakeRecords() {
    if (!_fakeRecordsPromise) {
        _fakeRecordsPromise = (async () => {
            await opaque.ready;
            const serverSetup = getServerSetup();
            /** @type {string[]} */
            const records = [];
            for (let i = 0; i < FAKE_RECORD_POOL_SIZE; i++) {
                // A password nobody holds. Never stored, never reachable.
                const password = crypto.randomBytes(32).toString('hex');
                const { clientRegistrationState, registrationRequest } =
                    opaque.client.startRegistration({ password });
                const { registrationResponse } = opaque.server.createRegistrationResponse({
                    serverSetup,
                    userIdentifier: `bf:absent:${i}`,
                    registrationRequest,
                });
                const { registrationRecord } = opaque.client.finishRegistration({
                    clientRegistrationState, registrationResponse, password,
                });
                records.push(registrationRecord);
            }
            return records;
        })().catch((err) => {
            // Let a later request retry rather than caching a rejected promise.
            _fakeRecordsPromise = null;
            throw err;
        });
    }
    return _fakeRecordsPromise;
}

async function fakeRecordFor(username) {
    const pool = await buildFakeRecords();
    const digest = crypto.createHmac('sha256', fakeKey()).update(String(username)).digest();
    return pool[digest[0] % pool.length];
}

/**
 * A wrapped-DEK blob of the right shape for an account that does not exist.
 * Returning null here instead would re-open the oracle one field further in:
 * the client reads {iv, authTag, data} hex (see agent-hub/src/lib/opaque.ts
 * wrapDEK), so absence has to look like presence at this level too.
 */
function fakeWrappedDEK(username, context) {
    /**
     * @param {string} label
     * @param {number} bytes
     */
    const stretch = (label, bytes) => crypto
        .createHmac('sha256', fakeKey())
        .update(`${context}:${label}:${username}`)
        .digest()
        .subarray(0, bytes)
        .toString('hex');
    return {
        iv: stretch('iv', 12),
        authTag: stretch('tag', 16),
        data: stretch('data', 32),
    };
}

/**
 * Read an envelope column (wrappedDEK / recoveryWrappedDEK) off a user row.
 *
 * userStore.getUser()/getUserByEmail() ALREADY run these columns through
 * parseJSON, so a real row carries an OBJECT `{iv, authTag, data}` — never a
 * JSON string. Calling JSON.parse() on that object stringifies it to
 * "[object Object]" and throws, and the bare empty catch around it turned
 * every genuine account's envelope into `null`: the client then never unwrapped
 * its DEK, and a real OPAQUE account answered `wrappedDEK: null` where an
 * absent username answers a well-formed fake blob — the very oracle the fake
 * record pool above exists to close.
 *
 * Accept both shapes, because parseJSON falls back to the RAW value when the
 * column holds something unparseable, and older/hand-written rows may still be
 * strings.
 * @param {string} value
 */
function readEnvelope(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

/**
 * The OPAQUE protocol messages, and the key envelopes that ride with them.
 *
 * Every field here is either an opaque-ke blob the library parses itself or an
 * envelope the client built, so the schema pins the TYPE and the presence and
 * leaves the contents to the crypto — a shape this route does not own.
 *
 * `confirmReplace` already had to be literally `true` before an existing
 * wrapped DEK could be overwritten, which is the right way round: everything
 * else fails closed. What was open is the KEY, and on these routes a key the
 * server drops is a key envelope the client believes it stored.
 * @param {string} name
 */
const blob = (name) => worded(`${name} must be text.`).min(1, `${name} required`).max(8192, `That ${name} is too long.`);

/**
 * @param {string} name
 */
const envelope = (name) => z.record(z.string(), z.unknown(), { error: typeError({ invalid: `${name} must be an encryption envelope.` }) });

// `username` is ACCEPTED AND IGNORED. The shipped web client sends it on both
// registration steps, and the server deliberately takes the account from the
// session instead — that substitution is the fix for the takeover this route
// would otherwise allow. Refusing the key would break that client for no gain; the
// client should stop sending it, and then it can come out of here.
const RegisterStartBody = z.object({
    username: worded('A username must be text.').max(200, 'That username is too long.').optional(),
    registrationRequest: blob('registrationRequest'),
}).strict();

const RegisterFinishBody = z.object({
    username: worded('A username must be text.').max(200, 'That username is too long.').optional(),
    registrationRecord: blob('registrationRecord'),
    wrappedDEK: envelope('wrappedDEK'),
    recoveryWrappedDEK: envelope('recoveryWrappedDEK').optional(),
    kekSalt: worded('kekSalt must be text.').max(512, 'That kekSalt is too long.').optional(),
    confirmReplace: z.boolean({ error: typeError({ invalid: 'confirmReplace must be true or false.' }) }).optional(),
}).strict();

const LOGIN_START_TEXT = 'username and startLoginRequest required';

const LoginStartBody = z.object({
    username: worded(LOGIN_START_TEXT).min(1, LOGIN_START_TEXT).max(200, LOGIN_START_TEXT),
    startLoginRequest: blob('startLoginRequest'),
}).strict();

const LOGIN_FINISH_TEXT = 'loginId and finishLoginRequest required';

const LoginFinishBody = z.object({
    loginId: worded(LOGIN_FINISH_TEXT).min(1, LOGIN_FINISH_TEXT).max(200, LOGIN_FINISH_TEXT),
    finishLoginRequest: blob('finishLoginRequest'),
    // The AES envelope the client built for the server's own session copy of
    // the DEK, read field by field below; `null` is how a login with no DEK to
    // hand over says so.
    encryptedDEK: envelope('encryptedDEK').nullable().optional(),
}).strict();

const PinRegisterFinishBody = z.object({
    registrationRecord: blob('registrationRecord'),
    wrappedDEK: envelope('wrappedDEK'),
    recoveryWrappedDEK: envelope('recoveryWrappedDEK').optional(),
    confirmReplace: z.boolean({ error: typeError({ invalid: 'confirmReplace must be true or false.' }) }).optional(),
}).strict();

const PinLoginStartBody = z.object({
    startLoginRequest: blob('startLoginRequest'),
}).strict();

module.exports = { getServerSetup, _pendingFallback, PENDING_TTL, getPendingLogin, setPendingLogin, deletePendingLogin, fakeKey, buildFakeRecords, fakeRecordFor, fakeWrappedDEK, readEnvelope, RegisterStartBody, RegisterFinishBody, LoginStartBody, LoginFinishBody, PinRegisterFinishBody, PinLoginStartBody };
