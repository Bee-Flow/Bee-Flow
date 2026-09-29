// @typecheck
/**
 * MFA (TOTP) management endpoints — mounted at /auth/mfa.
 *
 * Enrollment is two-step: /setup mints a pending secret (kept in the session,
 * NOT persisted) and returns a QR + otpauth URL; /enable verifies a code
 * against that pending secret before it's persisted (encrypted) and recovery
 * codes are issued once. Login-time verification lives in loginRoutes.js
 * (/auth/mfa/verify-login) so it can reuse the session-completion path.
 */
const express = require('express');
const userStore = require('../stores/userStore');
const { requireAuth, loadConfig } = require('./permissions');
const mfa = require('./mfa');
const ceremony = require('./securityKeys/ceremony');
const { createSecondFactorProof } = require('./securityKeys/proof');
const { credentialJson } = require('./securityKeys/schemas');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const log = require('../telemetry/log');

const router = express.Router();

// BFSF-274: brute-force protection on the code-verifying endpoints. Keyed by
// the authenticated user (these routes sit behind requireAuth), IP fallback.
// 10 attempts / 15 min leaves ample room for fat-fingered codes while making
// a 6-digit search infeasible.
const mfaCodeLimiter = perUserRateLimit({ windowMs: 15 * 60_000, max: 10 });

// How long a pending setup secret stays reusable. Within this window /setup
// returns the SAME secret instead of minting a new one — re-mounting the
// settings screen (or cancelling and reopening setup) must never silently
// desync the QR on screen from the secret in the session (BFSF-274: that
// desync makes every entered code "Invalid").
const SETUP_SECRET_TTL_MS = 10 * 60_000;

// Ensure a users-table row exists for the caller (the config admin may not
// have one yet if encryption was never initialised). Returns the row or null.
async function ensureUserRow(userId) {
    let row = await userStore.getUser(userId);
    if (!row && userId === 'admin') {
        try {
            const cfg = await loadConfig();
            await userStore.createUser({
                id: 'admin', username: 'admin', displayName: 'Administrator',
                passwordHash: cfg.admin.passwordHash, role: 'admin', groups: [],
                // Materialising the row, not setting a password: the hash comes
                // straight from the config. See finalizeLogin.js for the same
                // flag and the same reason.
                credentialUnchanged: true,
            });
            row = await userStore.getUser('admin');
        } catch (_) { /* fall through */ }
    }
    return row;
}

// Current MFA state for the security settings UI.
const { validate } = require('../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/**
 * `force` means "throw away the secret I am already showing and mint a new
 * one", and it was read as `!req.body?.force` — so EVERY truthy value forced a
 * fresh secret, the string "false" included. Somebody who had already scanned
 * the QR code into their authenticator lost it to a value that says not to.
 * A mis-spelled key did the opposite: "start over" quietly re-served the old
 * secret.
 */
const SetupBody = z.object({
    force: z.boolean({ invalid_type_error: 'force must be true or false.' }).optional(),
}).strict();

const CODE_TEXT = 'Enter the code from your authenticator app, or one of your recovery codes.';
/**
 * The same `req.body?.code` as the login second factor: read as `undefined`,
 * answered "no" by both verifiers, and counted as a WRONG CODE against the
 * rate limiter — so a request that never named a code at all spent one of the
 * attempts these routes are limited to.
 */
const codeField = worded(CODE_TEXT).trim().min(1, CODE_TEXT).max(64, CODE_TEXT);

/**
 * Proof of a factor the account already has (auth/securityKeys/proof.js): a
 * code (authenticator or recovery), or a security key's answer. An account
 * with only security keys has no authenticator code to give, which is why a
 * code alone is no longer the only way to confirm.
 */
const proofShape = {
    code: codeField.optional(),
    securityKey: credentialJson.optional(),
};
const requireOneProof = (b, ctx) => {
    if (!b.code && !b.securityKey) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: CODE_TEXT });
};
const ProofBody = z.object(proofShape).strict().superRefine(requireOneProof);

// `code` proves the NEW authenticator; `proof` proves an existing factor, and
// is only asked for when two-factor authentication is already on.
const EnableBody = z.object({
    code: codeField,
    proof: z.object(proofShape).strict().superRefine(requireOneProof).optional(),
}).strict();

const QUESTION_TEXT = 'Question is required';
// `history` is trimmed, filtered and redacted by the handler — that is a
// privacy control, not a shape check, and it stays. What the schema closes is
// the key: a mis-spelled `history` silently dropped the conversation and the
// assistant answered a follow-up as if it were the first question.
const AssistBody = z.object({
    question: worded(QUESTION_TEXT).min(1, QUESTION_TEXT).max(4000, 'That question is too long.'),
    history: z.array(z.unknown(), { invalid_type_error: 'history must be a list of messages.' }).optional(),
}).strict();

router.get('/status', requireAuth, async (req, res) => {
    try {
        const row = await userStore.getUser(req.session.user.id);
        const keys = row?.mfa_enabled ? await userStore.listSecurityKeys(req.session.user.id) : [];
        res.json({
            enabled: !!row?.mfa_enabled,
            recoveryCodesRemaining: mfa.remainingRecoveryCodes(row?.mfa_recovery_codes),
            // Which factors make up that second step. Either may be absent: an
            // account can use an authenticator app, security keys
            // (auth/securityKeys/), or both.
            totpEnabled: !!(row?.mfa_enabled && row.mfa_secret),
            securityKeys: keys.length,
            // The relying parties those keys answer for, so the client can
            // tell whether one works on the address it is on.
            securityKeyRpIds: [...new Set(keys.map((k) => k.rpId))],
            // Whether the account has a password (false for OAuth/SSO-only
            // accounts) — gates the "Change password" card in settings.
            hasPassword: !!row?.passwordHash,
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load MFA status' });
    }
});

// The pending setup secret lives in the session as { secret, mintedAt }.
// Older sessions may still hold a bare string from before BFSF-274 — read
// both shapes so an in-flight enrollment survives a deploy.
function readSetupSecret(session) {
    const v = session.mfaSetupSecret;
    if (!v) return null;
    if (typeof v === 'string') return { secret: v, mintedAt: 0 };
    return (v && typeof v.secret === 'string') ? v : null;
}

// Begin enrollment — mint a pending secret + QR. Not enabled until /enable.
// Idempotent within SETUP_SECRET_TTL_MS: a re-mount/re-open returns the SAME
// secret so the QR on screen always matches the session. `force: true`
// explicitly mints a fresh secret ("start over"). Returns serverTime so the
// client can warn about device clock drift (a ±30s-window TOTP rejects
// otherwise-valid codes when the phone clock is off).
router.post('/setup', requireAuth, validate({ body: SetupBody }), async (req, res) => {
    try {
        const existing = readSetupSecret(req.session);
        const fresh = req.body.force !== true
            && existing
            && existing.mintedAt
            && (Date.now() - existing.mintedAt) < SETUP_SECRET_TTL_MS;
        const secret = fresh ? existing.secret : mfa.generateSecret();
        req.session.mfaSetupSecret = { secret, mintedAt: fresh ? existing.mintedAt : Date.now() };
        const label = req.session.user.displayName || req.session.user.id;
        const otpauthUrl = mfa.otpauthUrl(secret, label);
        const qr = await mfa.qrDataUrl(otpauthUrl);
        req.session.save((err) => {
            if (err) return res.status(500).json({ error: 'Failed to start setup' });
            res.json({ otpauthUrl, qr, secret, serverTime: Date.now() });
        });
    } catch (e) {
        log.error('[MFA] setup error:', e.message);
        res.status(500).json({ error: 'Failed to start MFA setup' });
    }
});

// Confirm enrollment — verify a code against the pending secret, then persist.
// While two-factor authentication is already on (an account that signs in
// with security keys adding an app, or replacing its app), the caller must
// also prove a factor it already has; see auth/securityKeys/proof.js.
router.post('/enable', requireAuth, mfaCodeLimiter, validate({ body: EnableBody }), async (req, res) => {
    try {
        const pendingSetup = readSetupSecret(req.session);
        const pending = pendingSetup?.secret;
        if (!pending) return res.status(400).json({ error: 'Start MFA setup first', code: 'setup_required' });
        if (!mfa.verifyTotp(pending, req.body.code)) {
            return res.status(400).json({ error: 'Invalid code. Check your authenticator app and try again.', code: 'invalid_code' });
        }
        const userId = req.session.user.id;
        const row = await ensureUserRow(userId);
        if (!row) return res.status(400).json({ error: 'User not found' });
        if (row.mfa_enabled) {
            const proven = await proof.verify(req.session, row, req.body.proof || {});
            if (!proven.ok) return refuseProof(res, proven.code, userId);
        }

        const { plain, stored } = await mfa.generateRecoveryCodes();
        const now = new Date().toISOString();
        await userStore.updateUser(userId, {
            mfaEnabled: true,
            mfaSecret: mfa.encryptSecret(pending),
            mfaEnrolledAt: now,
            mfaRecoveryCodes: JSON.stringify(stored),
            mfaRecoveryCodesGeneratedAt: now,
        });
        delete req.session.mfaSetupSecret;
        req.session.save((err) => {
            if (err) log.error('[MFA] session save:', err.message);
            res.json({ success: true, recoveryCodes: plain });
        });
    } catch (e) {
        log.error('[MFA] enable error:', e.message);
        res.status(500).json({ error: 'Failed to enable MFA' });
    }
});

// An enrolled user whose stored secret no longer decrypts (MASTER_ENCRYPTION_KEY
// rotated without re-encrypting users.mfa_secret, or a corrupted row) must be
// told to use a recovery code / contact their admin — a generic "Invalid code"
// sends them into a hopeless retry loop that burns their recovery codes
// (BFSF-274). Specifics go to the server log only.
function unreadableSecret(res, userId) {
    log.error(`[MFA] mfa_secret for user ${userId} is undecryptable — MASTER_ENCRYPTION_KEY mismatch or corrupted row. Run scripts/rotate-master-key.js (now covers users.mfa_secret) or reset the user's 2FA via the admin panel.`);
    return res.status(400).json({
        error: 'Your authenticator can no longer be verified on this server. Use a recovery code, or ask your administrator to reset two-factor authentication.',
        code: 'mfa_secret_unreadable',
    });
}

// Every way proof.verify can say no, as the client sees it.
const PROOF_REFUSALS = {
    proof_required: 'Confirm with a code from your authenticator app, a recovery code or one of your security keys.',
    invalid_code: 'Invalid code',
    security_key_rejected: 'The security key could not be verified.',
    challenge_expired: 'That took too long. Try your security key again.',
};
function refuseProof(res, code, userId) {
    if (code === 'mfa_secret_unreadable') return unreadableSecret(res, userId);
    return res.status(400).json({ error: PROOF_REFUSALS[code] || PROOF_REFUSALS.invalid_code, code: code || 'invalid_code' });
}

// Proof that works on /disable and /regenerate as well as on the security-key
// routes (auth/securityKeys/). Built here with this router's own store and
// helpers, which is also how its tests reach it.
const proof = createSecondFactorProof({ userStore, mfa, ceremony });

// Turn off MFA — requires proof of a current factor: an authenticator code, an
// unused recovery code, or a security key. Takes the security keys with it.
router.post('/disable', requireAuth, mfaCodeLimiter, validate({ body: ProofBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const row = await userStore.getUser(userId);
        if (!row?.mfa_enabled) return res.json({ success: true });

        // A recovery code spent here needs no write: the whole set goes below.
        const proven = await proof.verify(req.session, row, req.body);
        if (!proven.ok) return refuseProof(res, proven.code, userId);

        await userStore.updateUser(userId, {
            mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null,
            mfaRecoveryCodes: null, mfaRecoveryCodesGeneratedAt: null,
        });
        await userStore.deleteAllSecurityKeys(userId);
        res.json({ success: true });
    } catch (e) {
        log.error('[MFA] disable error:', e.message);
        res.status(500).json({ error: 'Failed to disable MFA' });
    }
});

// Re-issue recovery codes (invalidates the old set). Accepts the same proof as
// /disable. BFSF-274: this endpoint was TOTP-only while the UI invited either,
// so users entering a recovery code got "Invalid code" and burned through their
// remaining codes. A recovery code spent as proof is replaced by the new set in
// the same write, so a failure midway never costs the user a code without
// giving new ones.
router.post('/recovery-codes/regenerate', requireAuth, mfaCodeLimiter, validate({ body: ProofBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const row = await userStore.getUser(userId);
        if (!row?.mfa_enabled) return res.status(400).json({ error: 'MFA not enabled', code: 'mfa_not_enabled' });

        const proven = await proof.verify(req.session, row, req.body);
        if (!proven.ok) return refuseProof(res, proven.code, userId);

        const { plain, stored } = await mfa.generateRecoveryCodes();
        await userStore.updateUser(userId, {
            mfaRecoveryCodes: JSON.stringify(stored),
            mfaRecoveryCodesGeneratedAt: new Date().toISOString(),
        });
        res.json({ success: true, recoveryCodes: plain });
    } catch (e) {
        log.error('[MFA] regenerate error:', e.message);
        res.status(500).json({ error: 'Failed to regenerate recovery codes' });
    }
});

// ── AI setup assistant (BFSF-274 follow-up) ─────────────────────────────────
// Answers questions during 2FA enrollment ("which app do I need?", "my code
// keeps being rejected"). SECURITY BOUNDARY: the assistant must never see the
// user's on-screen MFA material. That is enforced structurally — the client
// component receives no secret props so it CANNOT send them — and defensively
// here: anything secret-shaped in the question (otpauth:// URIs, base32 keys)
// is redacted before the text reaches the model. The system prompt additionally
// instructs the model to refuse shared secrets. Codes/secrets are never needed
// to answer setup questions.
const MFA_ASSIST_LIMITER = perUserRateLimit({ windowMs: 60_000, max: 10 });

const MFA_ASSIST_SYSTEM_PROMPT = [
    'You are the Bee Flow two-factor authentication (2FA) setup assistant.',
    'Answer briefly and concretely, in the language the user writes in (Dutch or English).',
    'You help with: choosing and installing an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden, Aegis, FreeOTP — any TOTP app works), scanning the QR code, entering the setup key manually, codes being rejected (most common cause: the phone clock is off — tell them to enable automatic time), recovery codes (one-time use, store safely), and being locked out (use a recovery code, or ask the organization admin to reset 2FA).',
    'SECURITY RULES: You have NO access to the user\'s QR code, secret key, current codes, or recovery codes — and that is by design; say so if asked.',
    'NEVER ask the user to share a secret key, QR content, or recovery code. If the user pastes one anyway, do not repeat it, tell them codes and keys should never be shared, and answer the underlying question without it.',
    'Stay on the topic of 2FA/account security; politely decline unrelated requests.',
].join('\n');

function redactMfaMaterial(text) {
    return String(text || '')
        .replace(/otpauth:\/\/\S+/gi, '[redacted]')
        // Base32 blobs (TOTP setup keys), in the shapes users actually paste:
        // – bare uppercase runs ("JBSWY3DPEHPK3PXP")
        // – grouped, as authenticator apps display them ("JBSW Y3DP EHPK 3PXP")
        // – lowercase runs, but only when they contain a base32 digit (2-7) —
        //   a plain [a-z]{16,} rule would eat ordinary long Dutch words
        //   ("verantwoordelijkheid") out of real questions.
        .replace(/(?:[A-Z2-7]{4}[ -]){3,}[A-Z2-7]{2,}/g, '[redacted]')
        .replace(/[A-Z2-7]{16,}/g, '[redacted]')
        .replace(/(?=[a-z2-7]*[2-7])[a-z2-7]{16,}/g, '[redacted]')
        .slice(0, 1000);
}

router.post('/assist', requireAuth, MFA_ASSIST_LIMITER, validate({ body: AssistBody }), async (req, res) => {
    try {
        const question = redactMfaMaterial(req.body.question);
        if (!question.trim()) return res.status(400).json({ error: QUESTION_TEXT });

        // Short rolling context so follow-ups work. Client history is untrusted
        // input — same redaction, hard caps on turns and length.
        const history = (req.body.history || []).slice(-6);
        const conversationHistory = history
            .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .map(m => ({ role: m.role, content: redactMfaMaterial(m.content) }));
        conversationHistory.push({ role: 'user', content: question });

        // One-shot, TOOL-LESS completion via llmClient.chat. Deliberately NOT
        // the aiAgent._chatLoop path: that loop always attaches the component
        // SYSTEM_TOOLS (execute_component etc.), which a help assistant on the
        // 2FA screen must never be able to invoke. Lazy requires: don't pull
        // the LLM stack into every auth boot.
        const { getAIConfig } = require('../core/aiAgent');
        const llmClient = require('../core/llm/llmClient');
        const config = await getAIConfig();
        if (!config?.model) return res.status(503).json({ error: 'Assistant unavailable', code: 'assist_unavailable' });
        const result = await llmClient.chat(config.model, [
            { role: 'system', content: MFA_ASSIST_SYSTEM_PROMPT },
            ...conversationHistory,
        ], { maxTokens: 700, temperature: 0.3 });

        if (!result?.content) return res.status(503).json({ error: 'Assistant unavailable', code: 'assist_unavailable' });
        res.json({ answer: result.content });
    } catch (e) {
        log.error('[MFA] assist error:', e.message);
        res.status(503).json({ error: 'Assistant unavailable', code: 'assist_unavailable' });
    }
});

module.exports = router;
// For auth/securityKeys/index.js: the first key can be the account's first
// factor, so it needs the same admin-row materialisation and the same proof.
module.exports.ensureUserRow = ensureUserRow;
module.exports.secondFactorProof = proof;
