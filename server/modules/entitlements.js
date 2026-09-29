/**
 * Module entitlement grant verification.
 *
 * A "module grant" is an RS256-signed JWT issued by license.beeflow.nl that
 * proves an install/license is entitled to run a specific importable module.
 * It is a SEPARATE token from the tier license (server/license/verify.js) with
 * its own audience (`beeflow-module`) and token_use (`module_grant`), but it is
 * signed by the SAME key infrastructure — so this verifier deliberately reuses
 * verify.js's key resolution + signature primitives rather than forking them.
 *
 * Grant token contract (payload claims):
 *   iss          'license.beeflow.nl' | 'license.beeflow.nl/internal'
 *   aud          'beeflow-module'
 *   token_use    'module_grant'
 *   sub          <license_id | install_id>
 *   subject_type 'license' | 'install'
 *   module_id    <slug>
 *   entitlement_id, purchase_id
 *   kind         'free' | 'one_time' | 'subscription' | 'admin_granted'
 *   iat, nbf, exp
 */

const verify = require('../license/verify');

const MODULE_AUDIENCE = 'beeflow-module';
const MODULE_TOKEN_USE = 'module_grant';
const SKEW_SECONDS = 60;

/**
 * Decode a grant's payload WITHOUT verifying the signature. Returns the payload
 * object, or null if the token is unparseable. For logging/diagnostics only —
 * never trust these claims for authorization.
 * @param {string} token
 * @returns {object|null}
 */
function decodeGrantUnverified(token) {
    try {
        return verify.decodeJwtUnverified(token).payload;
    } catch (e) {
        return null;
    }
}

/**
 * Verify a module entitlement grant.
 *
 * @param {string} token  compact JWS module-grant token
 * @param {object} opts
 * @param {string} opts.moduleId            slug the grant must be scoped to
 * @param {string[]} [opts.subjectIds]      if provided, payload.sub must be one of these
 * @param {number} [opts.now]               unix seconds (defaults to real clock)
 * @param {function} [opts.publicKeyResolver] (kid) => key | Promise<key>; when
 *        omitted, falls back to verify.js's JWKS/bundled key resolution
 * @returns {Promise<{valid:true, payload:object} | {valid:false, error:string}>}
 */
async function verifyModuleGrant(token, {
    moduleId,
    subjectIds,
    now = Math.floor(Date.now() / 1000),
    publicKeyResolver,
} = {}) {
    let decoded;
    try {
        decoded = verify.decodeJwtUnverified(token);
    } catch (e) {
        return { valid: false, error: 'malformed' };
    }
    const { header, payload, parts } = decoded;

    if (!header || header.alg !== 'RS256') {
        return { valid: false, error: 'bad_alg' };
    }

    // Resolve the verification key by kid — inject a resolver for tests/custom
    // key sources, otherwise reuse the license verifier's JWKS→bundled chain.
    let publicKey = null;
    try {
        publicKey = typeof publicKeyResolver === 'function'
            ? await publicKeyResolver(header.kid)
            : await verify.resolvePublicKeyByKid(header.kid);
    } catch (e) {
        publicKey = null;
    }

    const signingInput = `${parts[0]}.${parts[1]}`;
    if (!verify.verifyCompactRs256(signingInput, parts[2], publicKey)) {
        return { valid: false, error: 'invalid_signature' };
    }

    if (!verify.isExpectedIssuer(payload.iss)) {
        return { valid: false, error: 'bad_issuer' };
    }
    if (payload.aud !== MODULE_AUDIENCE) {
        return { valid: false, error: 'bad_audience' };
    }
    if (payload.token_use !== MODULE_TOKEN_USE) {
        return { valid: false, error: 'bad_token_use' };
    }
    if (payload.module_id !== moduleId) {
        return { valid: false, error: 'module_mismatch' };
    }
    if (Array.isArray(subjectIds) && !subjectIds.includes(payload.sub)) {
        return { valid: false, error: 'subject_mismatch' };
    }
    if (typeof payload.exp !== 'number' || payload.exp <= now) {
        return { valid: false, error: 'expired' };
    }
    if (typeof payload.nbf === 'number' && payload.nbf > now + SKEW_SECONDS) {
        return { valid: false, error: 'not_yet_valid' };
    }

    return { valid: true, payload };
}

module.exports = {
    verifyModuleGrant,
    decodeGrantUnverified,
    MODULE_AUDIENCE,
    MODULE_TOKEN_USE,
};
