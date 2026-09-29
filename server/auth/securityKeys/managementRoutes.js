// @typecheck
/**
 * Security-key management — mounted at /auth/mfa next to the TOTP routes.
 *
 *   GET    /security-keys                        the caller's keys
 *   POST   /security-keys/proof/options          a challenge an existing key answers as proof
 *   POST   /security-keys/registration/options   start adding a key
 *   POST   /security-keys/registration/verify    finish adding it
 *   PATCH  /security-keys/:id                    rename
 *   DELETE /security-keys/:id                    remove
 *
 * A security key is a second factor in its own right: an account can have an
 * authenticator app, security keys, or both. The FIRST factor an account gets
 * turns two-factor authentication on, whichever kind it is; so adding a key to
 * an account without 2FA turns it on and hands out recovery codes, exactly as
 * enabling the app does.
 *
 * While 2FA is on, adding a key needs proof of a factor the account already
 * has (auth/securityKeys/proof.js): without it a hijacked session could plant
 * its own key and sign in later with only the password. Removing a key needs
 * none, as it only takes a way in away, with one exception: the account's
 * LAST factor. Removing that is turning 2FA off, which /disable does, with
 * proof.
 *
 * Built by a factory so the tests inject their own store instead of reaching
 * into the module system; ./index.js wires the real dependencies.
 */

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { credentialJson } = require('./schemas');

const MAX_KEYS_PER_USER = 10;
const NAME_MAX = 60;
const DEFAULT_NAME = 'Security key';
const CODE_TEXT = 'Enter a code from your authenticator app, or a recovery code.';
const NAME_TEXT = `A name is at most ${NAME_MAX} characters.`;

const nameField = z.string({ invalid_type_error: NAME_TEXT }).trim().max(NAME_MAX, NAME_TEXT);

const OptionsBody = z.object({
    name: nameField.optional(),
    // Proof of an existing factor; only asked for while 2FA is on.
    code: z.string({ invalid_type_error: CODE_TEXT }).trim().min(1, CODE_TEXT).max(64, CODE_TEXT).optional(),
    securityKey: credentialJson.optional(),
}).strict();
const VerifyBody = z.object({ response: credentialJson }).strict();
const EmptyBody = z.object({}).strict();
const RenameBody = z.object({ name: nameField.min(1, 'Give the key a name.') }).strict();
const IdParams = z.object({ id: z.string().min(1).max(64) }).strict();

// Every way proof.verify can say no.
const PROOF_REFUSALS = {
    proof_required: 'Confirm with a code from your authenticator app, a recovery code or one of your security keys.',
    invalid_code: 'Invalid code. Check your authenticator app and try again.',
    mfa_secret_unreadable: 'Your authenticator can no longer be verified on this server. Use a recovery code or one of your security keys.',
    security_key_rejected: 'The security key could not be verified.',
    challenge_expired: 'That took too long. Try your security key again.',
};

/** What the client may see of a key: never the public key or credential id. */
function publicView(key) {
    return {
        id: key.id,
        name: key.name,
        rpId: key.rpId,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
    };
}

const unavailable = () => new HttpError(400, 'webauthn_unavailable',
    'Security keys cannot be used from this address. Open Bee Flow on its own HTTPS address and try again.');
const tooMany = () => new HttpError(409, 'too_many_keys', `You can register up to ${MAX_KEYS_PER_USER} security keys. Remove one first.`);

/**
 * @param {{
 *   userStore: { getUser: Function, updateUser: Function, listSecurityKeys: Function, addSecurityKey: Function,
 *     renameSecurityKey: Function, deleteSecurityKey: Function, logAccessAudit: Function },
 *   mfa: { generateRecoveryCodes: Function },
 *   ceremony: typeof import('./ceremony'),
 *   proof: ReturnType<typeof import('./proof').createSecondFactorProof>,
 *   ensureUserRow: (userId: string) => Promise<any>,
 *   relyingPartyOf: (req: any) => ({ rpID: string, origin: string } | null),
 *   requireAuth: import('express').RequestHandler,
 *   codeLimiter: import('express').RequestHandler,
 *   log: { warn: Function },
 * }} deps
 */
function createSecurityKeyManagementRouter(deps) {
    const { userStore, mfa, ceremony, proof, ensureUserRow, relyingPartyOf, requireAuth, codeLimiter, log } = deps;
    const router = express.Router();

    const audit = (req, action, before, after) => userStore.logAccessAudit(
        action, 'user', req.session.user.id, req.session.user.id, before, after,
        req.session.user.organizationId || null,
    );

    /** Save the session, then answer; a lost challenge would only fail later. */
    const saveThen = (req, res, body) => req.session.save((err) => {
        if (err) {
            log.warn('[SecurityKeys] session save failed:', err.message);
            return res.status(503).json({ error: 'Could not start the security key check. Try again.', code: 'session_unavailable' });
        }
        res.json(body);
    });

    router.get('/security-keys', requireAuth, async (req, res) => {
        const keys = await userStore.listSecurityKeys(req.session.user.id);
        res.json({ keys: keys.map(publicView) });
    });

    router.post('/security-keys/proof/options', requireAuth, codeLimiter, validate({ body: EmptyBody }), async (req, res) => {
        const rp = relyingPartyOf(req);
        if (!rp) throw unavailable();
        const options = await proof.proofOptions(req.session, req.session.user.id, rp);
        if (!options) {
            throw new HttpError(409, 'no_security_key_here', 'None of your security keys is registered for this address.');
        }
        saveThen(req, res, { options });
    });

    router.post('/security-keys/registration/options', requireAuth, codeLimiter, validate({ body: OptionsBody }), async (req, res) => {
        const userId = req.session.user.id;
        const rp = relyingPartyOf(req);
        if (!rp) throw unavailable();
        const row = await ensureUserRow(userId);
        if (!row) throw new HttpError(400, 'user_not_found', 'User not found');
        const keys = await userStore.listSecurityKeys(userId);
        if (keys.length >= MAX_KEYS_PER_USER) throw tooMany();

        const proven = !!row.mfa_enabled;
        if (proven) {
            const result = await proof.verify(req.session, row, req.body);
            if (!result.ok) {
                throw new HttpError(400, result.code || 'invalid_code', PROOF_REFUSALS[result.code] || PROOF_REFUSALS.invalid_code);
            }
            if (result.recoveryCodes) {
                await userStore.updateUser(userId, { mfaRecoveryCodes: JSON.stringify(result.recoveryCodes) });
            }
        }

        const options = await ceremony.registrationOptions({
            rp,
            userName: row.username || row.email || userId,
            displayName: row.displayName || undefined,
            existingKeys: keys,
        });
        req.session.securityKeyRegistration = {
            ...ceremony.challengeRecord(options, rp),
            name: req.body.name || DEFAULT_NAME,
            proven,
        };
        saveThen(req, res, { options });
    });

    router.post('/security-keys/registration/verify', requireAuth, codeLimiter, validate({ body: VerifyBody }), async (req, res) => {
        const userId = req.session.user.id;
        const record = ceremony.takeChallenge(req.session, 'securityKeyRegistration');
        if (!record) {
            throw new HttpError(400, 'registration_expired', 'That took too long. Start adding the key again.');
        }
        const rp = relyingPartyOf(req);
        if (!rp || rp.origin !== record.origin) {
            throw new HttpError(400, 'webauthn_unavailable', 'Finish adding the key on the page where you started.');
        }

        const result = await ceremony.verifyRegistration({ response: req.body.response, record });
        if (!result.ok) {
            log.warn(`[SecurityKeys] registration refused for user ${userId}: ${result.reason}`);
            throw new HttpError(400, 'security_key_rejected', 'The security key could not be verified. Try again.');
        }
        // Checked again: two tabs could each have been given options, and
        // 2FA could have been turned on in the other one without this
        // registration having proved anything.
        if ((await userStore.listSecurityKeys(userId)).length >= MAX_KEYS_PER_USER) throw tooMany();
        const before = await userStore.getUser(userId);
        if (before?.mfa_enabled && !record.proven) {
            throw new HttpError(400, 'proof_required', 'Two-factor authentication was turned on meanwhile. Start adding the key again.');
        }

        let key;
        try {
            key = await userStore.addSecurityKey({
                userId, ...result.key, rpId: record.rpID, name: record.name || DEFAULT_NAME,
            });
        } catch (err) {
            if (err?.code === '23505') {
                throw new HttpError(409, 'already_registered', 'This security key is already registered.');
            }
            throw err;
        }
        await audit(req, 'user.security_key_added', null, { keyId: key.id, name: key.name });

        // The account's first factor: this key turns two-factor
        // authentication on, with recovery codes shown once, as /enable does.
        let recoveryCodes;
        if (!before?.mfa_enabled) {
            const { plain, stored } = await mfa.generateRecoveryCodes();
            const now = new Date().toISOString();
            await userStore.updateUser(userId, {
                mfaEnabled: true,
                mfaEnrolledAt: now,
                mfaRecoveryCodes: JSON.stringify(stored),
                mfaRecoveryCodesGeneratedAt: now,
            });
            recoveryCodes = plain;
        }
        res.json({ key: publicView(key), ...(recoveryCodes ? { recoveryCodes } : {}) });
    });

    router.patch('/security-keys/:id', requireAuth, validate({ params: IdParams, body: RenameBody }), async (req, res) => {
        const ok = await userStore.renameSecurityKey(req.session.user.id, req.params.id, req.body.name);
        if (!ok) throw new HttpError(404, 'not_found', 'Security key not found.');
        res.json({ success: true });
    });

    router.delete('/security-keys/:id', requireAuth, validate({ params: IdParams }), async (req, res) => {
        const userId = req.session.user.id;
        const [row, keys] = await Promise.all([userStore.getUser(userId), userStore.listSecurityKeys(userId)]);
        if (!keys.some((k) => k.id === req.params.id)) throw new HttpError(404, 'not_found', 'Security key not found.');
        if (row?.mfa_enabled && !row.mfa_secret && keys.length === 1) {
            throw new HttpError(409, 'last_factor',
                'This key is your only second factor. Add another one first, or turn two-factor authentication off.');
        }
        await userStore.deleteSecurityKey(userId, req.params.id);
        await audit(req, 'user.security_key_removed', { keyId: req.params.id }, null);
        res.json({ success: true });
    });

    return router;
}

module.exports = { createSecurityKeyManagementRouter, MAX_KEYS_PER_USER };
