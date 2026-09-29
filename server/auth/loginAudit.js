// @typecheck
/**
 * loginAudit.js — the ISO A.8.15 / A.5.16 record of who signed in, when, from
 * where, and what happened when they failed.
 *
 * WHAT WAS THERE BEFORE, AND WHY IT IS NOT THIS
 * telemetry/metrics.recordAuthEvent() counts logins by (kind, status) and its
 * doc comment says, correctly, NEVER pass a user id. That is a metric: it
 * answers "are logins failing more than usual" and it is exported to whoever
 * runs the dashboards. It cannot answer "did this account sign in on the 14th,
 * and from where" — which is the question an auditor, a DPA and an incident
 * responder all ask, and the question A.8.15 exists for. Both are kept; they
 * are different instruments and neither replaces the other.
 *
 * WHY THE SUBMITTED IDENTIFIER IS NEVER STORED
 * The obvious design writes the attempted username into the failure row. Two
 * things go wrong with it, and both happen in practice:
 *   • People type their password into the username field. That row is then a
 *     cleartext password in a table org admins can read and support can export.
 *   • The identifier of a failed login against an account that does NOT exist
 *     is personal data about someone who is not a user, retained indefinitely,
 *     and it turns the audit view into an account-enumeration oracle for
 *     everyone who can read it.
 * So a failure row carries a keyed FINGERPRINT of the identifier instead: it
 * correlates "the same name was tried nine times tonight" without being
 * reversible and without being comparable across installations. The account id
 * is recorded only when the identifier resolved to a real account, and that is
 * decided by the caller, which did the lookup — this module never looks one up
 * (a lookup here would be exactly the enumeration step the login path spends a
 * dummy bcrypt to hide).
 *
 * WHY THE IP IS STORED
 * A.8.15 asks for network addresses; an "unauthorised sign-in" investigation is
 * not possible without them. It is personal data and it stays inside Bee Flow —
 * BFSF-441 governs data LEAVING the product, and this row never leaves.
 *
 * BEST-EFFORT, ALWAYS
 * Nothing here may break or slow an authentication. logAccessAudit swallows its
 * own errors; the wrappers below add a second net so a caller can never be hit
 * by a throw from the audit path. A missing row is a gap in a log; a throw here
 * would be an outage of the login.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');

// Actions are a closed vocabulary — the audit view and any future SIEM export
// filter on them, and a typo'd action string is a row nobody ever finds again.
const LOGIN_ACTIONS = Object.freeze({
    SUCCEEDED: 'login_succeeded',
    FAILED: 'login_failed',
    BLOCKED: 'login_blocked',
});

// target_type for a failure that never named a real account. Distinct from
// 'user' so a query for one account's history cannot accidentally sweep in
// attempts that merely resembled it.
const UNKNOWN_TARGET_TYPE = 'login_identifier';

let _fingerprintKey = null;
let _fingerprintVersion = 'v1';

/**
 * HMAC key for identifier fingerprints.
 *
 * Keyed, not a bare hash: an unkeyed sha256 of an email address is trivially
 * reversed from a wordlist, so the table would still be a list of who tried to
 * sign in. Salted per feature in the house style (stores/integrationCacheStore),
 * so a compromise of one derived key does not extend to the others.
 *
 * With no MASTER_ENCRYPTION_KEY configured the key is random per process and the rows
 * are tagged `v1-ephemeral`. That is deliberate: correlation then only holds
 * within one process lifetime, and the tag says so on the row rather than
 * letting an auditor read process-scoped counts as installation-wide ones.
 * The alternative — a hardcoded fallback secret — would make every install's
 * fingerprints identical and therefore comparable, which is worse than useless.
 */
function fingerprintKey() {
    if (_fingerprintKey) return _fingerprintKey;
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (master) {
        _fingerprintKey = crypto.createHmac('sha256', master).update('beeflow:login-audit:v1').digest();
        _fingerprintVersion = 'v1';
    } else {
        _fingerprintKey = crypto.randomBytes(32);
        _fingerprintVersion = 'v1-ephemeral';
        log.warn('[LoginAudit] No MASTER_ENCRYPTION_KEY — identifier fingerprints correlate within this process only.');
    }
    return _fingerprintKey;
}

/**
 * Keyed, truncated fingerprint of a submitted identifier. Returns null for a
 * missing one rather than a fingerprint of the empty string, so "nothing was
 * submitted" and "something was submitted" stay distinguishable in the table.
 *
 * Lower-cased and trimmed so `Tom@x.nl` and ` tom@x.nl ` correlate, matching
 * how loginThrottle keys its counters. 16 bytes is far past collision relevance
 * at audit-table scale and keeps the row small.
 */
function identifierFingerprint(identifier) {
    if (typeof identifier !== 'string') return null;
    const norm = identifier.trim().toLowerCase();
    if (!norm) return null;
    const hex = crypto.createHmac('sha256', fingerprintKey()).update(norm).digest('hex').slice(0, 32);
    return `${_fingerprintVersion}:${hex}`;
}

/** Bounded user-agent. A UA header is attacker-controlled and unbounded; the
 *  audit row is not the place to find that out. */
function shortUserAgent(req) {
    const ua = req?.headers?.['user-agent'];
    if (typeof ua !== 'string' || !ua) return null;
    return ua.length > 256 ? `${ua.slice(0, 256)}…` : ua;
}

// Lazy — consentGuards pulls in the document registry and the user store, and
// this module is required from the session-establishment path. Same reasoning
// as telemetry/metrics.js: stay load-order safe.
function auditIp(req) {
    try {
        return require('./consentGuards').auditClientIp(req) || null;
    } catch { return null; }
}

function orgOf(user) {
    if (!user || typeof user !== 'object') return null;
    return user.organizationId || user.organization_id || user.orgId || null;
}

async function write(action, { targetType, targetId, organizationId, changedBy, details }) {
    try {
        const userStore = require('../stores/userStore');
        await userStore.logAccessAudit(
            action,
            targetType,
            targetId,
            changedBy,
            null,            // old_values — an authentication event has no prior state
            details,
            organizationId || null,
        );
    } catch (e) {
        // logAccessAudit already catches; this is the net for a failure to even
        // reach it (a require that throws during shutdown, a mocked store).
        log.error('[LoginAudit] could not record', action, '-', e.message);
    }
}

/**
 * A session was established for `user`. Recorded for every path that mints an
 * authenticated session, including the ones that are not quite a login (a fresh
 * signup, a session held at pending-approval) — `method` and `details` say
 * which. Recording those too is the point: "an authenticated session appeared
 * for this account" is the event an incident responder reconstructs, and a
 * signup that immediately holds a session is exactly as interesting as a login.
 * @param req
 * @param {{ user?: {id?: string, uid?: string, [key: string]: any}, method?: string, organizationId?: string|null, details?: object }} [opts]
 */
async function auditLoginSuccess(req, { user, method = 'unknown', organizationId = null, details = {} } = {}) {
    const userId = (user && (user.id || user.uid)) || null;
    await write(LOGIN_ACTIONS.SUCCEEDED, {
        targetType: 'user',
        targetId: userId || 'unknown',
        organizationId: organizationId || orgOf(user),
        changedBy: userId || 'system',
        details: {
            method,
            ip: auditIp(req),
            userAgent: shortUserAgent(req),
            ...details,
        },
    });
}

/**
 * An authentication attempt was refused.
 *
 * `userId` is the account the identifier resolved to, or null when it resolved
 * to nothing — the caller knows, this module deliberately does not look it up.
 * `reason` is a short stable code ('bad_password', 'suspended', 'mfa_failed'),
 * never a message meant for a person: it is queried, not read aloud.
 */
async function auditLoginFailure(req, { userId = null, identifier = null, method = 'unknown', reason = 'invalid_credentials', organizationId = null, details = {} } = {}) {
    await write(LOGIN_ACTIONS.FAILED, {
        targetType: userId ? 'user' : UNKNOWN_TARGET_TYPE,
        targetId: userId || identifierFingerprint(identifier) || 'unknown',
        organizationId,
        changedBy: userId || 'anonymous',
        details: {
            method,
            reason,
            knownAccount: !!userId,
            identifierFingerprint: identifierFingerprint(identifier),
            ip: auditIp(req),
            userAgent: shortUserAgent(req),
            ...details,
        },
    });
}

/**
 * An attempt was refused BEFORE credentials decided it — the abuse lockout, or
 * an account whose status revokes access. Separate from a plain failure because
 * these are the rows an auditor asks about by name: a lockout is the control
 * working, and a suspended account still being tried is a signal about the
 * person holding the password.
 */
async function auditLoginBlocked(req, { userId = null, identifier = null, method = 'unknown', reason = 'blocked', organizationId = null, details = {} } = {}) {
    await write(LOGIN_ACTIONS.BLOCKED, {
        targetType: userId ? 'user' : UNKNOWN_TARGET_TYPE,
        targetId: userId || identifierFingerprint(identifier) || 'unknown',
        organizationId,
        changedBy: userId || 'anonymous',
        details: {
            method,
            reason,
            knownAccount: !!userId,
            identifierFingerprint: identifierFingerprint(identifier),
            ip: auditIp(req),
            userAgent: shortUserAgent(req),
            ...details,
        },
    });
}

/** Test seam only — drops the derived key so a test can change the env. */
function _resetFingerprintKey() {
    _fingerprintKey = null;
    _fingerprintVersion = 'v1';
}

module.exports = {
    LOGIN_ACTIONS,
    UNKNOWN_TARGET_TYPE,
    auditLoginSuccess,
    auditLoginFailure,
    auditLoginBlocked,
    identifierFingerprint,
    _resetFingerprintKey,
};
