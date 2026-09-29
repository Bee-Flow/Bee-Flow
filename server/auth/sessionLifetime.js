// @typecheck
/**
 * How long a session lasts, and whether the clock restarts on activity.
 *
 * Extracted from index.js so it can be tested without starting the server, and
 * because these two values are the ones an organisation has to be able to state
 * in its ISO access-control policy (A.5.17, A.8.5).
 *
 * WHAT WAS ACTUALLY TRUE, AND WHAT THE DOCUMENTATION CLAIMED
 * The API reference said "14 days, sliding, refreshed on every successful API
 * call". The cookie was set to 30 days and `rolling` was never enabled, so the
 * window ran from sign-in and did not extend with use: sign in on the 1st and
 * you sign in again on the 31st however much you used it, while a session
 * untouched since the 1st is still valid on the 30th. Wrong on the number, on
 * the behaviour, and on the mechanism (it is a server-side session, not a JWT).
 *
 * That is not a documentation nit. An organisation writing "sessions expire
 * after 14 days of inactivity" into its ISMS on the strength of that page is
 * documenting a control it does not have, and finds out when an auditor samples
 * it.
 *
 * The default is deliberately unchanged. Shortening it for every installation
 * has a real cost — people signed out sooner — and that trade is the operator's
 * to make, not the vendor's. What changes is that they now CAN make it.
 */
const logger = require('../telemetry/log');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/**
 * Session lifetime in milliseconds from SESSION_MAX_AGE_DAYS.
 *
 * Unparseable, zero or negative input falls back to the default and says so on
 * the console. A mistyped policy value must never become "no timeout at all":
 * that is the one direction of failure an audit punishes, so the unknown case
 * narrows to the known default rather than widening to forever.
 *
 * Capped at a year — beyond that it is a typo, not a policy.
 */
function sessionMaxAgeMs(env = process.env, log = logger.warn) {
    const raw = env.SESSION_MAX_AGE_DAYS;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    }
    const days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) {
        log(`[Session] SESSION_MAX_AGE_DAYS=${JSON.stringify(raw)} is not a positive number — using the ${DEFAULT_DAYS}-day default.`);
        return DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    }
    if (days > MAX_DAYS) {
        log(`[Session] SESSION_MAX_AGE_DAYS=${days} exceeds the ${MAX_DAYS}-day ceiling — using ${MAX_DAYS}.`);
    }
    return Math.min(days, MAX_DAYS) * 24 * 60 * 60 * 1000;
}

/**
 * Whether the lifetime is an INACTIVITY timeout (true) or a fixed window from
 * sign-in (false).
 *
 * Opt-in, so nothing changes for an existing installation. Most written
 * access-control policies describe the inactivity version, so an organisation
 * matching its policy to the product will usually want this on.
 *
 * Strictly 'true' — an env var carrying '1', 'yes' or 'TRUE' is a config the
 * operator believes is on. Rather than guess at which spellings to honour, the
 * one accepted spelling is documented and anything else is reported.
 */
function sessionRolling(env = process.env, log = logger.warn) {
    const raw = env.SESSION_ROLLING;
    if (raw === undefined || raw === null || String(raw).trim() === '') return false;
    const v = String(raw).trim();
    if (v === 'true') return true;
    if (v !== 'false') {
        log(`[Session] SESSION_ROLLING=${JSON.stringify(raw)} is not 'true' or 'false' — treating it as false (a fixed window from sign-in).`);
    }
    return false;
}

module.exports = { sessionMaxAgeMs, sessionRolling, DEFAULT_DAYS, MAX_DAYS };
