// @typecheck strict
/**
 * What resolveCrypto says when the key it was asked for is not there: the two
 * tagged errors a write gets, and the throttled operator warning a read logs.
 * Kept apart from messageCrypto.js so that file stays about keys.
 */

const log = require('../../telemetry/log');
const { storeError } = require('../lib/storeError');

/**
 * Tag on an error thrown when a shared project's key cannot be produced.
 * Routes map it to a 503 with an operator-facing message; the outer catch in
 * resolveCrypto uses it to know this is the one failure it must not absorb.
 */
const PROJECT_KEY_UNAVAILABLE = 'PROJECT_KEY_UNAVAILABLE';

/**
 * Code on the error a WRITE gets when the org's policy asks for encryption and
 * the policy or the key cannot be produced. Carries status 503 and `expose`,
 * so the terminal handler passes the message through as it is.
 */
const ENCRYPTION_KEY_UNAVAILABLE = 'ENCRYPTION_KEY_UNAVAILABLE';
const KEY_UNAVAILABLE_TEXT = 'Encryption is switched on for your organisation, but its key cannot be '
    + 'reached right now. Nothing was saved; please try again shortly. If this keeps happening, '
    + 'ask your administrator to check the encryption settings.';

/** @param {unknown} [cause] */
function keyUnavailable(cause) {
    const err = storeError(503, ENCRYPTION_KEY_UNAVAILABLE, KEY_UNAVAILABLE_TEXT);
    if (cause) err.cause = cause;
    return err;
}

// Throttled so a busy org cannot flood the log with one line per message —
// the signal we need is "this is happening", not the count.
const _warnedNoKey = new Map(); // orgId|tier|kind -> last logged at (ms)
const NO_KEY_WARN_INTERVAL_MS = 60_000;

const _NO_KEY_HINT = {
    // No session DEK. On zk that is the only source for message content.
    messages: 'Message content stays PLAINTEXT. On zk the content key is derived at login: '
        + 'the user must sign in again (sessions created before the tier change carry no DEK).',
    // No escrow. Everything a background job touches falls back to plaintext.
    background: 'The Privacy Shield token map and conversation meta stay PLAINTEXT. '
        + 'These use the org escrow — check MASTER_ENCRYPTION_KEY and organizations.org_root_key.',
    all: 'NOTHING is being encrypted. Check MASTER_ENCRYPTION_KEY, the org escrow key, '
        + 'and that the org is entitled to the encryption feature.',
};

/**
 * The org asked for encryption and a key is missing: say so, with what to
 * check, once a minute per org, tier and kind.
 * @param {string | null | undefined} orgId
 * @param {string} tier
 * @param {string | null | undefined} userId
 * @param {'messages' | 'background' | 'all'} [kind]
 */
function warnNoKey(orgId, tier, userId, kind = 'all') {
    const k = `${orgId}|${tier}|${kind}`;
    const now = Date.now();
    const last = _warnedNoKey.get(k) || 0;
    if (now - last < NO_KEY_WARN_INTERVAL_MS) return;
    _warnedNoKey.set(k, now);
    log.error(
        `[MessageCrypto] Org '${orgId}' is on encryption tier '${tier}' but no ${kind === 'all' ? '' : kind + ' '}key ` +
        `is available (user=${userId || 'none'}). ${_NO_KEY_HINT[kind] || _NO_KEY_HINT.all}`
    );
}

module.exports = { PROJECT_KEY_UNAVAILABLE, ENCRYPTION_KEY_UNAVAILABLE, keyUnavailable, warnNoKey };
