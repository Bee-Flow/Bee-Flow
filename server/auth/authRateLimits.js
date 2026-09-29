// @typecheck
/**
 * Rate limiters for the anonymous authentication surface.
 *
 * A pentest sent 190 requests across /auth/admin-login, /auth/signup and
 * /auth/forgot-password and received zero 429s — no throttling of any kind
 * existed on any authentication endpoint. These are the coarse per-source
 * request caps; the fine-grained, failure-counting per-account lockout lives in
 * loginThrottle.js and is the primary control. Both are needed: this one bounds
 * the raw flood, that one bounds guesses against a specific account.
 *
 * Split into its own dependency-free module (only `express-rate-limit`) so it
 * can be unit-tested without importing the full route graph — same rationale as
 * routes/publicShareBridgeRateLimits.js and routes/webpagesPreviewRateLimits.js,
 * whose shape this deliberately copies.
 *
 * THE `skip` ON EVERY LIMITER IS NOT OPTIONAL
 * Each of these is keyed on req.ip. When the peer address is loopback / RFC1918
 * / link-local, it is not a client address — it is either local development or a
 * reverse proxy that is not forwarding the real one. This platform runs behind a
 * Scaleway L4 load balancer that hides the visitor IP unless PROXY protocol is
 * enabled (done on dev, still pending on prod), and in that state EVERY visitor
 * shares one bucket: a 60-per-5-minutes login cap would become a
 * 60-per-5-minutes cap for the entire production tenant base. Skipping
 * non-client addresses makes these limiters a no-op exactly where they would
 * otherwise cause an outage, and leaves them fully active for real internet
 * clients. Fix the proxy chain and they light up on their own.
 *
 * Limits are intentionally well above human behaviour — nobody signs in sixty
 * times in five minutes — and well below attack behaviour: the pentest managed
 * 120 login attempts in about two seconds.
 *
 * No request schema lives here: this file declares no route. `bodyKey` reads
 * the submitted address of the route it guards, and must run before that
 * route's schema — a malformed body has to spend its budget too.
 */

// The CJS build exports the limiter function itself (its .d.cts only describes the namespace).
const rateLimit = /** @type {typeof import('express-rate-limit').rateLimit} */ (/** @type {unknown} */ (require('express-rate-limit')));
const { clientIp, isPrivateIp } = require('./signupGuards');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

/** true when req.ip cannot be trusted to identify a distinct client. */
function skipUntrustedIp(req) {
    try {
        const ip = clientIp(req);
        return !ip || isPrivateIp(ip);
    } catch (_) {
        return true;
    }
}

const num = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : d;
};

/** @param {{ windowMs: number, max: number, message: string, code?: string }} opts */
function make({ windowMs, max, message, code }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skip: skipUntrustedIp,
        message: { error: message, code: code || 'too_many_requests' },
    });
}

/**
 * Sign-in attempts. Complements the per-account lockout: this is what stops one
 * address enumerating a thousand DIFFERENT usernames, which no per-account
 * counter can see.
 */
const loginIpLimiter = make({
    windowMs: 5 * 60_000,
    max: num(process.env.AUTH_LOGIN_IP_MAX, 60),
    message: 'Too many sign-in attempts from this address. Please wait a few minutes and try again.',
    code: 'too_many_attempts',
});

/**
 * Account creation. Thirty concurrent signups from one source produced thirty
 * live tenants during the assessment. Each tenant carries an LLM quota that
 * costs real money, so this is the cap that has a direct financial meaning.
 */
const signupIpLimiter = make({
    windowMs: 60 * 60_000,
    max: num(process.env.AUTH_SIGNUP_IP_MAX, 10),
    message: 'Too many accounts created from this address. Please try again later.',
    code: 'too_many_signups',
});

/**
 * Password-reset requests. The endpoint itself is correctly built (constant
 * response, constant timing, no existence leak) — the risk here is using it as a
 * free e-mail cannon against a known address.
 */
const forgotPasswordIpLimiter = make({
    windowMs: 15 * 60_000,
    max: num(process.env.AUTH_FORGOT_IP_MAX, 20),
    message: 'Too many password-reset requests. Please wait a few minutes and try again.',
});

/** Verification-mail resends — same e-mail-cannon reasoning. */
const resendVerificationIpLimiter = make({
    windowMs: 15 * 60_000,
    max: num(process.env.AUTH_RESEND_IP_MAX, 10),
    message: 'Too many verification e-mails requested. Please wait a few minutes and try again.',
});

/**
 * Reset-token redemption. The token is 32 random bytes so guessing it is not the
 * threat; this bounds the cost of someone trying anyway.
 */
const resetPasswordIpLimiter = make({
    windowMs: 15 * 60_000,
    max: num(process.env.AUTH_RESET_IP_MAX, 20),
    message: 'Too many attempts. Please wait a few minutes and try again.',
});

// ── Target-keyed limiters ─────────────────────────────────────────────────────
//
// The per-IP limiters above go quiet whenever req.ip is not a real client
// address, which — behind an L4 load balancer that is not forwarding it, or on
// localhost — is always. A retest fired forty password-reset requests and saw
// forty 200s for exactly that reason.
//
// These close the gap from the other side: they key on what the caller ASKED
// FOR, which is attacker-supplied but also exactly the thing being abused. An
// e-mail cannon aimed at one address is bounded by a per-address limit no
// matter how many source addresses it comes from, and no matter whether we can
// see them.
//
// Keyed on the SUBMITTED string, never on a resolved account, so an unknown
// address is throttled identically to a real one — the limiter must not become
// the existence oracle that /auth/forgot-password was carefully built to avoid.
// Empty input gets its own bucket rather than falling through to the shared
// per-IP default, which would let malformed requests exhaust everyone's budget.

const bodyKey = (prefix, ...fields) => (req) => {
    for (const f of fields) {
        const v = String(req.body?.[f] ?? '').trim().toLowerCase();
        if (v) return `${prefix}:${v.slice(0, 254)}`;
    }
    return `${prefix}:_empty`;
};

/** One address can be sent at most this many reset mails per hour. */
const forgotPasswordTargetLimiter = perUserRateLimit({
    windowMs: 60 * 60_000,
    max: num(process.env.AUTH_FORGOT_TARGET_MAX, 3),
    name: 'auth-forgot-target',
    keyFn: bodyKey('fp', 'email'),
});

/** Same reasoning for verification mail. */
const resendVerificationTargetLimiter = perUserRateLimit({
    windowMs: 60 * 60_000,
    max: num(process.env.AUTH_RESEND_TARGET_MAX, 3),
    name: 'auth-resend-target',
    keyFn: bodyKey('rv', 'email'),
});

/**
 * Account creation, keyed on the address (falling back to the username). Stops
 * one identity being used to mint tenants in a loop even when every request
 * arrives from a different source.
 */
const signupTargetLimiter = perUserRateLimit({
    windowMs: 60 * 60_000,
    max: num(process.env.AUTH_SIGNUP_TARGET_MAX, 5),
    name: 'auth-signup-target',
    keyFn: bodyKey('su', 'email', 'username'),
});

module.exports = {
    skipUntrustedIp,
    loginIpLimiter,
    signupIpLimiter,
    forgotPasswordIpLimiter,
    resendVerificationIpLimiter,
    resetPasswordIpLimiter,
    forgotPasswordTargetLimiter,
    resendVerificationTargetLimiter,
    signupTargetLimiter,
};
