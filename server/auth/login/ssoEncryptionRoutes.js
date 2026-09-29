// @typecheck
/**
 * Login Routes — the SSO user's encryption PIN: first-time setup, unlock,
 * PIN change and recovery-key rescue of the DEK. Split out of
 * auth/loginRoutes.js.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const { setupSSOUserDEK, unlockSSOUserDEK, unlockWithRecoveryKey, secureClear } = require('../encryption');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const MIN_PIN = 6;
const PIN_TEXT = `Encryption PIN must be at least ${MIN_PIN} characters`;
const NEW_PIN_TEXT = `New PIN must be at least ${MIN_PIN} characters`;
const RECOVERY_TEXT = 'Enter your recovery key.';

/**
 * The PIN must be a STRING before its length means anything.
 *
 * Every gate here was `!pin || pin.length < 6`, and `.length` is `undefined`
 * on anything that is not a string or array — so a JSON number sailed through
 * both this check and validateEncryptionPin() in encryption.js. `pin: 5`
 * reached Argon2 (which refuses a number, so it surfaced as a 500 on the
 * user's own key setup); `pin: ["a","b","c","d","e","f"]` passed the length
 * check AND Argon2, where Buffer.from() coerces each element to a number and
 * every non-numeric one becomes a zero byte — so distinct six-element arrays
 * derive the SAME key. On the DEK that wraps everything this product stores,
 * a length gate that can be stepped over by changing the JSON type is not a
 * length gate.
 *
 * A PIN is never trimmed: the user typed it, and the bytes they typed are the
 * ones that have to unwrap the key again tomorrow.
 */
const pin = (message) => worded(message).min(MIN_PIN, message);

const SetupBody = z.object({ pin: pin(PIN_TEXT) }).strict();
// Unlock deliberately does NOT enforce the minimum: an account set up before
// the rule can still hold a shorter PIN, and refusing it here would lock its
// owner out of their own data instead of letting them in to change it.
const UnlockBody = z.object({ pin: worded('PIN is required').min(1, 'PIN is required') }).strict();
const ChangePinBody = z.object({
    oldPin: worded('Both old and new PIN are required').min(1, 'Both old and new PIN are required'),
    newPin: pin(NEW_PIN_TEXT),
}).strict();
const RecoveryBody = z.object({
    recoveryKey: worded(RECOVERY_TEXT).trim().min(1, RECOVERY_TEXT).max(512, RECOVERY_TEXT),
    newPin: pin(NEW_PIN_TEXT),
}).strict();

// SSO Encryption PIN Setup — first-time SSO user sets their encryption PIN
router.post('/sso-encryption-setup', validate({ body: SetupBody }), async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { pin } = req.body;
    try {
        const userId = req.session.user.id;

        // Check if session already has a legacy DEK (from master-key unlock)
        let existingDEK = null;
        if (req.session.encryptionKey) {
            existingDEK = Buffer.from(req.session.encryptionKey, 'base64');
            log.info(`[Auth] SSO migration: re-wrapping existing DEK for user ${userId} with new PIN`);
        } else {
            log.info(`[Auth] SSO setup: creating new DEK for user ${userId}`);
        }

        const { dek, recoveryKey } = await setupSSOUserDEK(userId, pin, existingDEK);
        req.session.encryptionKey = dek.toString('base64');
        req.session.needsEncryptionSetup = false;
        req.session.needsEncryptionPin = false;
        secureClear(dek);
        if (existingDEK) secureClear(existingDEK);

        log.info(`[Auth] SSO encryption setup complete for user ${userId} (migration: ${!!existingDEK})`);

        req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ success: true, recoveryKey });
        });
    } catch (err) {
        log.error('[Auth] SSO encryption setup failed:', err.message);
        res.status(500).json({ error: 'Encryption setup failed' });
    }
});

// SSO Encryption PIN Unlock — returning SSO user enters their PIN
router.post('/sso-encryption-unlock', validate({ body: UnlockBody }), async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { pin } = req.body;
    try {
        const result = await unlockSSOUserDEK(req.session.user.id, pin);
        if (result.needsSetup) {
            return res.json({ needsSetup: true });
        }
        if (result.wrongPin) {
            return res.status(401).json({ error: 'Incorrect PIN' });
        }
        req.session.encryptionKey = result.dek.toString('base64');
        req.session.needsEncryptionPin = false;
        req.session.needsEncryptionSetup = false;
        secureClear(result.dek);
        log.info(`[Auth] SSO encryption unlocked for user ${req.session.user.id}`);
        req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ success: true });
        });
    } catch (err) {
        log.error('[Auth] SSO encryption unlock failed:', err.message);
        res.status(500).json({ error: 'Encryption unlock failed' });
    }
});

// SSO Encryption PIN Change — re-wrap DEK with new PIN
router.post('/sso-change-pin', validate({ body: ChangePinBody }), async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { oldPin, newPin } = req.body;
    try {
        const userId = req.session.user.id;

        // Unlock DEK with old PIN
        const unlockResult = await unlockSSOUserDEK(userId, oldPin);
        if (unlockResult.wrongPin) {
            return res.status(401).json({ error: 'Current PIN is incorrect' });
        }
        if (unlockResult.needsSetup) {
            return res.status(400).json({ error: 'Encryption not set up yet' });
        }

        // Re-wrap DEK with new PIN
        log.info(`[Auth] SSO PIN change: re-wrapping DEK for user ${userId}`);
        const { dek, recoveryKey } = await setupSSOUserDEK(userId, newPin, unlockResult.dek);
        secureClear(unlockResult.dek);

        // Update session with new key
        req.session.encryptionKey = dek.toString('base64');
        secureClear(dek);

        log.info(`[Auth] SSO PIN change complete for user ${userId}`);
        req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ success: true, recoveryKey });
        });
    } catch (err) {
        log.error('[Auth] SSO PIN change failed:', err.message);
        res.status(500).json({ error: 'PIN change failed' });
    }
});

// SSO Recovery — unlock with recovery key and set new PIN
router.post('/sso-recovery', validate({ body: RecoveryBody }), async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { recoveryKey, newPin } = req.body;
    try {
        const userId = req.session.user.id;

        // Unlock DEK with recovery key
        const dek = await unlockWithRecoveryKey(userId, recoveryKey);
        if (!dek) {
            return res.status(401).json({ error: 'Invalid recovery key' });
        }

        // Re-wrap DEK with new PIN
        log.info(`[Auth] SSO recovery: re-wrapping DEK for user ${userId}`);
        const result = await setupSSOUserDEK(userId, newPin, dek);
        secureClear(dek);

        // Update session with new key
        req.session.encryptionKey = result.dek.toString('base64');
        req.session.needsEncryptionSetup = false;
        req.session.needsEncryptionPin = false;
        secureClear(result.dek);

        log.info(`[Auth] SSO recovery complete for user ${userId}`);
        req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ success: true, recoveryKey: result.recoveryKey });
        });
    } catch (err) {
        log.error('[Auth] SSO recovery failed:', err.message);
        res.status(500).json({ error: 'Recovery failed' });
    }
});

module.exports = router;
