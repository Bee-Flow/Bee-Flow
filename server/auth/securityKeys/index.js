// @typecheck
/**
 * Security keys (WebAuthn / FIDO2 — YubiKey and the like) as a second factor.
 * Wires the real dependencies into the two routers:
 *
 *   managementRouter  mounted at /auth/mfa (index.js), next to the TOTP routes
 *   loginRouter       mounted at /auth (loginRoutes.js), next to /mfa/verify-login
 *
 * The routers themselves are factories (managementRoutes.js, loginRoutes.js)
 * so their tests inject fakes instead of patching the module system.
 */

const userStore = require('../../stores/userStore');
const mfa = require('../mfa');
// The TOTP router owns the admin-row materialisation and builds the proof
// check; the key routes share both rather than keep copies.
const { ensureUserRow, secondFactorProof } = require('../mfaRoutes');
const { requireAuth } = require('../permissions');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { recordAuthEvent } = require('../../telemetry/metrics');
const { auditLoginFailure } = require('../loginAudit');
const { finalizeLogin } = require('../login/finalizeLogin');
const log = require('../../telemetry/log');
const ceremony = require('./ceremony');
const { resolveRelyingParty } = require('./relyingParty');
const { createSecurityKeyManagementRouter } = require('./managementRoutes');
const { createSecurityKeyLoginRouter } = require('./loginRoutes');

/** The relying party this request's ceremony is for (see relyingParty.js). */
const relyingPartyOf = (req) => resolveRelyingParty(req.headers.origin);

const managementRouter = createSecurityKeyManagementRouter({
    userStore,
    mfa,
    ceremony,
    proof: secondFactorProof,
    ensureUserRow,
    relyingPartyOf,
    requireAuth,
    // Twice the TOTP routes' budget: adding a key while 2FA is on takes three
    // requests (proof challenge, registration options, registration verify).
    codeLimiter: perUserRateLimit({ windowMs: 15 * 60_000, max: 20 }),
    log,
});

const loginRouter = createSecurityKeyLoginRouter({
    userStore,
    ceremony,
    relyingPartyOf,
    finalizeLogin,
    recordAuthEvent,
    auditLoginFailure,
    // Keyed by the pending user, like /mfa/verify-login, so an office behind
    // one NAT address is not locked out together.
    limiter: perUserRateLimit({
        windowMs: 15 * 60_000,
        max: 10,
        keyFn: (req) => req.session?.mfaPending?.userId || null,
    }),
    maxAttempts: mfa.MFA_LOGIN_MAX_ATTEMPTS,
    log,
});

module.exports = { managementRouter, loginRouter };
