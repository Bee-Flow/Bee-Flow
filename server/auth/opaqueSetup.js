// @typecheck
'use strict';
/**
 * Can the OPAQUE library this server runs actually read OPAQUE_SERVER_SETUP?
 *
 * Presence was the only thing anyone checked. On dev and prod the configured
 * value could not be deserialized by @serenity-kit/opaque 1.1.0, so every
 * OPAQUE registration and login died with a protocol error (a 500 on the
 * registration routes), the fake-credential pool never built, and the admin
 * surfaces still said OPAQUE was configured. The one sign was a warning about
 * the fake-credential pool in the boot log.
 *
 * This module answers the question once, at boot: one client registration
 * start plus one server registration response against the configured setup
 * (the same round trip buildFakeRecords makes, about half a millisecond). The
 * answer is cached as { valid, reason } and read by:
 *
 *   - the OPAQUE routes, which answer 503 opaque_setup_invalid instead of
 *     failing inside the protocol (auth/opaqueRoutes.js ensureReady);
 *   - the encryption readiness shown to admins
 *     (stores/encryptionAvailability.js tierReadiness);
 *   - the ISO 27001 A.8.5 / A.8.24 compliance evidence.
 *
 * Those readers must not load the WASM module, so nothing here requires
 * @serenity-kit/opaque at import time.
 *
 * The cache is tied to the value it judged (by SHA-256, kept in memory only):
 * a status is reported only while OPAQUE_SERVER_SETUP still holds that value,
 * so a verdict can never be applied to a different setup. The value itself and
 * its length are never logged.
 *
 * To mint a readable value: node server/scripts/generate-opaque-setup.js
 */

const crypto = require('crypto');
const defaultLog = require('../telemetry/log');

/** @typedef {{ valid: boolean, reason: string|null }} SetupStatus */

/** @type {SetupStatus|null} */
let _status = null;
/** @type {string|null} */
let _checkedDigest = null;

function _digest(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

/** The installed library version, for the one log line that names it. */
function libraryVersion() {
    try {
        return require('@serenity-kit/opaque/package.json').version || 'unknown';
    } catch (_) {
        return 'unknown';
    }
}

/**
 * The library's error text, minus anything that could be the setup. Its
 * messages name the failing step ('deserialize serverSetup', 'base64 decoding
 * failed at "serverSetup"'), not the input, but that is its choice and not a
 * contract: drop the message entirely if it ever contains the value.
 *
 * @param {any} err
 * @param {string} serverSetup
 * @returns {string}
 */
function _safeReason(err, serverSetup) {
    const msg = String((err && err.message) || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 200);
    const WINDOW = 12;
    for (let i = 0; serverSetup && i + WINDOW <= serverSetup.length; i++) {
        if (msg.includes(serverSetup.slice(i, i + WINDOW))) return 'the library rejected the value';
    }
    return msg;
}

/**
 * One registration round trip against `serverSetup`. Synchronous; the caller
 * must have awaited `opaqueLib.ready`. Never throws.
 *
 * @param {any} opaqueLib the loaded @serenity-kit/opaque module
 * @param {string} serverSetup
 * @returns {SetupStatus}
 */
function probeServerSetup(opaqueLib, serverSetup) {
    if (!serverSetup) return { valid: false, reason: 'empty' };
    try {
        // A throwaway password: nothing here is stored or sent anywhere.
        const password = crypto.randomBytes(16).toString('hex');
        const { registrationRequest } = opaqueLib.client.startRegistration({ password });
        opaqueLib.server.createRegistrationResponse({
            serverSetup,
            userIdentifier: 'bf:setup-probe',
            registrationRequest,
        });
        return { valid: true, reason: null };
    } catch (err) {
        return { valid: false, reason: _safeReason(err, serverSetup) };
    }
}

/**
 * Judge the configured OPAQUE_SERVER_SETUP and cache the verdict. Synchronous,
 * so the routes can flip to "ready" in the same tick they learn the verdict;
 * the caller must have awaited `opaqueLib.ready` (validateServerSetup does).
 *
 * With no value configured there is nothing to judge: the routes then mint an
 * ephemeral setup with this same library, and the missing variable is reported
 * as such elsewhere. On an unreadable value, logs ONE error. Never throws.
 *
 * @param {{ opaqueLib: any, serverSetup?: string, log?: { error: (...args: any[]) => void } }} opts
 * @returns {SetupStatus}
 */
function checkServerSetup({ opaqueLib, serverSetup = process.env.OPAQUE_SERVER_SETUP || '', log = defaultLog }) {
    const setup = String(serverSetup || '');
    /** @type {SetupStatus} */
    const status = setup ? probeServerSetup(opaqueLib, setup) : { valid: true, reason: 'not_configured' };
    return _record(setup, status, log);
}

/**
 * @param {string} setup
 * @param {SetupStatus} status
 * @param {{ error: (...args: any[]) => void }} log
 * @returns {SetupStatus}
 */
function _record(setup, status, log) {
    _status = status;
    _checkedDigest = _digest(setup);
    if (!status.valid) {
        log.error(`[OPAQUE] OPAQUE_SERVER_SETUP cannot be read by @serenity-kit/opaque ${libraryVersion()}: ${status.reason}. OPAQUE registration/login are unavailable until it is replaced (see server/scripts/generate-opaque-setup.js). Password logins are unaffected.`);
    }
    return { ...status };
}

/**
 * checkServerSetup after the WASM is ready. Loads the library only when none
 * is passed in. Never rejects.
 *
 * @param {{ opaqueLib?: any, serverSetup?: string, log?: { error: (...args: any[]) => void } }} [opts]
 * @returns {Promise<SetupStatus>}
 */
async function validateServerSetup(opts = {}) {
    const setup = String((opts.serverSetup !== undefined ? opts.serverSetup : process.env.OPAQUE_SERVER_SETUP) || '');
    const log = opts.log || defaultLog;
    let lib = opts.opaqueLib;
    if (setup) {
        try {
            lib = lib || require('@serenity-kit/opaque');
            await lib.ready;
        } catch (err) {
            return _record(setup, { valid: false, reason: `the library failed to load (${_safeReason(err, setup)})` }, log);
        }
    }
    return checkServerSetup({ opaqueLib: lib, serverSetup: setup, log });
}

/**
 * The cached verdict for the CURRENT OPAQUE_SERVER_SETUP, or null when this
 * process has not judged that value (not validated yet, or the variable
 * changed since).
 *
 * @returns {SetupStatus|null}
 */
function getServerSetupStatus() {
    if (!_status || _checkedDigest !== _digest(process.env.OPAQUE_SERVER_SETUP || '')) return null;
    return { ..._status };
}

/** False only when the current value is known to be unreadable. */
function isServerSetupUsable() {
    const s = getServerSetupStatus();
    return !(s && s.valid === false);
}

/** What the OPAQUE routes answer while the setup is unreadable. */
const SETUP_INVALID_BODY = Object.freeze({
    error: 'OPAQUE is not available on this server',
    code: 'opaque_setup_invalid',
});

/** Test hook: forget the cached verdict. */
function _resetForTests() {
    _status = null;
    _checkedDigest = null;
}

module.exports = {
    probeServerSetup,
    checkServerSetup,
    validateServerSetup,
    getServerSetupStatus,
    isServerSetupUsable,
    libraryVersion,
    SETUP_INVALID_BODY,
    _resetForTests,
};
