// @typecheck
/**
 * Proof of a second factor the account ALREADY has, asked before any change
 * to its second factors while two-factor authentication is on: adding a
 * security key, adding an authenticator app, new recovery codes, turning 2FA
 * off. Without it a hijacked session could plant a factor of its own and sign
 * in later with nothing but the password.
 *
 * Three forms are accepted, whichever the account has:
 *   { code }         a current authenticator code, or an unused recovery code
 *   { securityKey }  a key's answer to the challenge from proofOptions()
 *
 * A recovery code that proves something is spent. The caller gets the updated
 * list back and persists it, so a route that replaces the whole set anyway
 * (regenerate, disable) can skip the write.
 *
 * Built by a factory: mfaRoutes.js and the security-key routes each hand it
 * their own userStore and mfa helpers, which is also how their tests inject
 * fakes.
 */

const PROOF_FIELD = 'securityKeyProof';

/**
 * @typedef {{ code?: string, securityKey?: any }} ProofBody
 * @typedef {{ ok: boolean, code?: string, recoveryCodes?: any[] }} ProofResult
 *   `code` is the refusal code when not ok; `recoveryCodes` is the list after
 *   a recovery code was spent (persist it), absent otherwise.
 */

/**
 * @param {{
 *   userStore: { listSecurityKeys: Function, recordSecurityKeyUse: Function },
 *   mfa: { decryptSecret: Function, verifyTotp: Function, consumeRecoveryCode: Function },
 *   ceremony: typeof import('./ceremony'),
 * }} deps
 */
function createSecondFactorProof({ userStore, mfa, ceremony }) {
    /**
     * Challenge a key may answer as proof. Stored in the session, single use.
     * @returns {Promise<any|null>} the options, or null when no key of this
     *   account works on this relying party
     */
    async function proofOptions(session, userId, rp) {
        const keys = (await userStore.listSecurityKeys(userId)).filter((k) => k.rpId === rp.rpID);
        if (keys.length === 0) return null;
        const options = await ceremony.authenticationOptions({ rp, keys });
        session[PROOF_FIELD] = ceremony.challengeRecord(options, rp);
        return options;
    }

    /**
     * @param {any} session
     * @param {{ id: string, mfa_secret?: string|null, mfa_recovery_codes?: any }} row
     * @param {ProofBody} body
     * @returns {Promise<ProofResult>}
     */
    async function verify(session, row, body) {
        if (body?.securityKey) {
            const record = ceremony.takeChallenge(session, PROOF_FIELD);
            if (!record) return { ok: false, code: 'challenge_expired' };
            const response = body.securityKey;
            const keys = await userStore.listSecurityKeys(row.id);
            const key = keys.find((k) => k.rpId === record.rpID && k.credentialId === response.id);
            if (!key) return { ok: false, code: 'security_key_rejected' };
            const result = await ceremony.verifyAuthentication({ response, record, key });
            if (!result.ok) return { ok: false, code: 'security_key_rejected' };
            await userStore.recordSecurityKeyUse(row.id, key.id, result.newCounter);
            return { ok: true };
        }

        const code = typeof body?.code === 'string' ? body.code : '';
        if (!code) return { ok: false, code: 'proof_required' };
        // An account may have no authenticator app at all (security keys
        // only). Only a secret that is THERE and does not decrypt is
        // "unreadable"; an absent one just means recovery codes are the only
        // codes this account has.
        const hasTotp = !!row.mfa_secret;
        const secret = hasTotp ? mfa.decryptSecret(row.mfa_secret) : null;
        if (secret && mfa.verifyTotp(secret, code)) return { ok: true };
        const spent = await mfa.consumeRecoveryCode(row.mfa_recovery_codes, code);
        if (spent) return { ok: true, recoveryCodes: spent };
        return { ok: false, code: hasTotp && !secret ? 'mfa_secret_unreadable' : 'invalid_code' };
    }

    return { proofOptions, verify };
}

module.exports = { createSecondFactorProof, PROOF_FIELD };
