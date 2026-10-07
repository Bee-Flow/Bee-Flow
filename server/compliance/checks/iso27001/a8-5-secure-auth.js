/**
 * ISO 27001 A.8.5 — Secure authentication mechanisms are in place.
 *
 * Signals:
 *   1. LOCKOUT — the DEK brute-force lockout in auth/encryption.js
 *      (dekUnwrapFailures counter + dekLockoutUntil backoff, hard lockout).
 *      Verified by requiring the module (unlockUserDEK exported) and scanning
 *      its source for the lockout fields — the fields live inside the function
 *      body, so the export alone would not prove the mechanism.
 *   2. SESSION — requireAuth re-checks on every request that the account still
 *      exists and destroys the session otherwise (auth/permissions.js).
 *      permissions.js is deliberately NOT required here (it pulls in db/redis
 *      wiring); the source marker is enough for a static architecture fact.
 *   3. PASSWORD POLICY — auth/passwordPolicy.js MIN_PASSWORD_LENGTH >= 8.
 *   4. SSO — at least one identity provider is configured (configStore
 *      'providers' google/microsoft, or 'oauth' Nextcloud). Password-only
 *      sign-in degrades to warn: accounts are then managed per-app instead of
 *      by a central identity provider. "Configured" is what the SSO screen
 *      calls enabled (auth/oauth/ssoConfigRoutes.js): a client id AND a
 *      client secret. No writer ever sets a provider's `enabled` flag, so
 *      requiring it read every working SSO setup as password-only.
 */

const fs = require('fs');
const path = require('path');
const configStore = require('../../../stores/configStore');
const { configuredSsoProviders } = require('../../lib/ssoProviders');
// Cached boot-time verdict on OPAQUE_SERVER_SETUP; never loads the WASM.
const { getServerSetupStatus } = require('../../../auth/opaqueSetup');

const AUTH_DIR = path.join(__dirname, '..', '..', '..', 'auth');

function _sourceHas(file, patterns) {
    try {
        const src = fs.readFileSync(path.join(AUTH_DIR, file), 'utf-8');
        return patterns.every(p => src.includes(p));
    } catch {
        return null; // source not readable — unverifiable, not proven absent
    }
}

module.exports = {
    id: 'ISO27001-A.8.5-secure-auth',
    regulation: 'ISO27001',
    article: 'A.8.5',
    controls: ['A.8.5'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(j)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_secure_auth.title',
    descriptionKey: 'compliance.checks.iso_secure_auth.desc',
    remediationKey: 'compliance.checks.iso_secure_auth.fix',
    remediationLink: 'admin/security/sso',
    async evaluate() {
        let encryption = null;
        let encryptionError = null;
        try {
            encryption = require(path.join(AUTH_DIR, 'encryption'));
        } catch (e) {
            encryptionError = e.message;
        }

        const lockoutSource = _sourceHas('encryption.js', ['dekUnwrapFailures', 'dekLockoutUntil']);
        const lockoutActive =
            !!encryption && typeof encryption.unlockUserDEK === 'function' && lockoutSource !== false;

        const sessionRevalidation = _sourceHas('permissions.js', ['requireAuth', 'User no longer exists']);

        let minPasswordLength = null;
        try {
            minPasswordLength = require(path.join(AUTH_DIR, 'passwordPolicy')).MIN_PASSWORD_LENGTH;
        } catch { /* policy module missing — reported below */ }

        // One predicate with NIS2 Art. 21(2)(j): lib/ssoProviders.js.
        const ssoProviders = configuredSsoProviders(
            await configStore.getConfig('providers'),
            await configStore.getConfig('oauth'),
        );

        const evidence = {
            lockout_mechanism: lockoutActive,
            session_user_revalidation: sessionRevalidation === true,
            min_password_length: minPasswordLength,
            sso_providers_enabled: ssoProviders,
            // Set AND not known to be unreadable by the OPAQUE library; the
            // readability verdict itself is null until the boot check ran.
            opaque_configured: !!process.env.OPAQUE_SERVER_SETUP && getServerSetupStatus()?.valid !== false,
            opaque_setup_readable: process.env.OPAQUE_SERVER_SETUP ? (getServerSetupStatus()?.valid ?? null) : null,
        };
        if (encryptionError) evidence.encryption_load_error = encryptionError;

        if (!lockoutActive || sessionRevalidation === false) {
            const missing = [];
            if (!lockoutActive) missing.push('brute-force lockout (auth/encryption.js)');
            if (sessionRevalidation === false) missing.push('per-request account revalidation (auth/permissions.js)');
            return {
                status: 'fail',
                evidence,
                details: `Core authentication protections could not be confirmed: ${missing.join('; ')}. This build deviates from the shipped auth layer.`,
            };
        }
        if (typeof minPasswordLength !== 'number' || minPasswordLength < 8) {
            return {
                status: 'warn',
                evidence,
                details: `The password policy allows fewer than 8 characters (found: ${minPasswordLength === null ? 'no policy module' : minPasswordLength}). Restore auth/passwordPolicy.js to the shipped minimum.`,
            };
        }
        if (ssoProviders.length === 0) {
            return {
                status: 'warn',
                evidence,
                details: 'Lockout and session revalidation are active, but no SSO provider is configured — accounts are managed per-app instead of by your identity provider. Configure Google, Microsoft or Nextcloud under Security → SSO.',
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Brute-force lockout, per-request account revalidation and a ${minPasswordLength}-character password minimum are active; SSO configured via ${ssoProviders.join(', ')}.`,
        };
    },
};
