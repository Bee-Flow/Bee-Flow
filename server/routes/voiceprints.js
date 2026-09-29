/**
 * Voiceprints API — self-enrollment for pyannoteAI speaker identification.
 *
 * A voiceprint is biometric data (GDPR Art. 9), so the authorization model is
 * deliberately narrower than everything else in this codebase:
 *
 *   • WRITES ARE SELF-ONLY, STRUCTURALLY. `POST /me` and `DELETE /me` take the
 *     user from `req.session.user.id` and accept NO user id in the path, query
 *     or body. There is no route shape by which one user creates another's
 *     voiceprint — that is what makes the Art. 9(2)(a) "explicit consent"
 *     basis honest. Never add `POST /org/:orgId/user/:userId`.
 *   • THERE IS NO ADMIN READ PATH. Unlike the transcription routes, no
 *     endpoint here threads `isSuperAdmin` into a read. An org admin gets
 *     coverage counts and the power to revoke; nobody, at any privilege level,
 *     can read a template.
 *   • ENROLLMENT AUDIO IS NEVER PERSISTED. It is held in memory, written to
 *     the OS temp dir only for the ffmpeg hop, and unlinked in a `finally` on
 *     every path including errors. The multer instance is deliberately NOT the
 *     disk-backed one from `routes/transcriptions.js`.
 *
 * Auth shape mirrors `routes/talkNotesSettings.js` (/user/me before /:orgId).
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * POST /me is multipart, so its schema sits BEHIND multer: multer reads the
 * stream and only then puts the text fields on `req.body` (the recording goes
 * to `req.file`), and a validate() in front of it would see an empty body. It
 * is `.strict()`, which makes the self-only rule above visible instead of
 * silent: a `userId` in the form used to be ignored, and is refused now. The
 * fields are the three the enrollment modal sends:
 *
 *   - `consent`: checked in the handler, not the schema, so a deployment
 *     without pyannoteAI still answers 409 first and a missing consent keeps
 *     its own code (`consent_required`) for the modal to translate.
 *   - `language`: the locale the passage was read in. It was cut to eight
 *     characters (`zh-Hant-TW` became `zh-Hant-`), and a misspelled field
 *     name was dropped; it is kept whole up to 16 characters now.
 *   - `duration_seconds`: the modal's own count. The server measures the
 *     audio itself (voiceprintClient), so this is accepted and not trusted.
 *
 * A rejected upload was a 500: multer's errors (a file over 15 MB, a type the
 * filter refuses) carry no status, so the terminal handler answered
 * "internal error" and the modal fell back to its generic text. They are a
 * 413 and a 400 now, each with a code, as in routes/dictate.js.
 *
 * DELETE /me takes no body for the same self-only reason. The org routes read
 * only their path; the admin revoke checks org membership itself.
 */

const express = require('express');
const { z } = require('zod');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const userStore = require('../stores/userStore');
const voiceprintStore = require('../stores/voiceprintStore');
const voiceprintClient = require('../core/voice/voiceprintClient');
const { requireAuth, isOrgAdminForOrg, resolveUserOrgIds } = require('../auth/permissions');
const { VOICEPRINT_CONSENT_ID, VOICEPRINT_CONSENT_VERSION } = require('../legal/documentRegistry');

const CONSENT_DOC_ID = VOICEPRINT_CONSENT_ID;
const CONSENT_VERSION = VOICEPRINT_CONSENT_VERSION;

// Memory only. A ≤30s 16kHz clip is well under a megabyte even as WebM; the
// 15MB ceiling just bounds a malicious upload.
const MAX_ENROLL_BYTES = 15 * 1024 * 1024;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ENROLL_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const allowed = ['.webm', '.mp4', '.m4a', '.ogg', '.opus', '.wav', '.mp3', '.flac'];
        if (allowed.includes(ext) || (file.mimetype || '').startsWith('audio/') || (file.mimetype || '').startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported audio format for a voice profile.'));
        }
    },
});

// Each enrollment costs a pyannote job. Bound the damage from a stuck client
// or a curious user hammering re-record.
const enrollLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    // Per user, not per IP: a whole office behind one NAT must not share a
    // budget. `requireAuth` runs first so the fallback is unreachable — it is
    // a constant rather than req.ip because express-rate-limit rejects raw IPs
    // from a custom keyGenerator (IPv6 subnet handling).
    keyGenerator: (req) => req.session?.user?.id || 'anon',
    message: { error: 'Too many voice-profile attempts. Try again later.', code: 'rate_limited' },
});

/**
 * multer, with its refusals answered as refusals. Its errors carry no status,
 * so passed on as they were they became a 500 (see the header).
 */
function receiveRecording(req, res, next) {
    upload.single('audio')(req, res, (err) => {
        if (!err) return next();
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
            error: tooBig
                ? `That recording is too large (max ${Math.round(MAX_ENROLL_BYTES / 1024 / 1024)} MB).`
                : (err.message || 'That upload was not accepted.'),
            code: tooBig ? 'recording_too_large' : 'bad_upload',
        });
    });
}

/** A string whose every refusal, including "you left it out", is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

// The multipart text fields of POST /me (see the header).
const EnrollFields = bodyOf({
    consent: worded('consent is the text true.').optional(),
    language: worded('language is a language code, like nl or en.').trim()
        .max(16, 'language is a language code, like nl or en.').optional(),
    duration_seconds: worded('duration_seconds is a number of seconds.')
        .regex(/^\d{1,4}(\.\d+)?$/, 'duration_seconds is a number of seconds.').optional(),
});

const NoBody = bodyOf({});

/** Client IP for the consent ledger, honouring the proxy chain like consentGuards does. */
function clientIp(req) {
    try {
        const { auditClientIp } = require('../auth/consentGuards');
        return auditClientIp(req);
    } catch (_) {
        return req.ip || null;
    }
}

/**
 * Re-read the user from the DB rather than trusting the session snapshot: a
 * recording takes ~30 seconds, during which the account could have been
 * suspended or moved between organisations.
 */
async function freshUser(req) {
    return userStore.getUser(req.session.user.id);
}

// ── Self (the only write surface) ────────────────────────────────────
// Declared before /org/:orgId so "me" can never be captured as an org id.

/**
 * Whether the feature is usable, plus this user's own status. Drives a
 * settings section that renders NOTHING when unavailable — someone on a
 * Voxtral deployment should never learn the feature exists.
 */
router.get('/availability', requireAuth, async (req, res) => {
    try {
        const user = await freshUser(req);
        if (!user) return res.status(401).json({ error: 'Not authenticated' });

        const availability = await voiceprintClient.isVoiceprintAvailable(user);
        const payload = {
            ...availability,
            enrolled: false,
            voiceprint: null,
            coverage: { enrolled: 0, members: 0 },
            limits: voiceprintClient.LIMITS,
            consentVersion: CONSENT_VERSION,
        };
        if (availability.available) {
            const meta = await voiceprintStore.getVoiceprintForUser(user.id);
            payload.voiceprint = meta;
            payload.enrolled = !!(meta && meta.status === 'ready');
            payload.coverage = await voiceprintStore.countOrgCoverage(user.organizationId);
        }
        res.json(payload);
    } catch (e) {
        log.error('[Voiceprints] availability error:', e.message);
        res.status(500).json({ error: 'Could not load voice profile status' });
    }
});

/** The caller's own voiceprint — metadata only, never the template. */
router.get('/me', requireAuth, async (req, res) => {
    try {
        const meta = await voiceprintStore.getVoiceprintForUser(req.session.user.id);
        res.json({ voiceprint: meta, enrolled: !!(meta && meta.status === 'ready') });
    } catch (e) {
        log.error('[Voiceprints] GET /me error:', e.message);
        res.status(500).json({ error: 'Could not load your voice profile' });
    }
});

/**
 * Record (or replace) the caller's own voice profile.
 *
 * Synchronous: a ≤30s clip enrolls in seconds, and returning the final state
 * directly halves the client's state machine.
 */
router.post('/me', requireAuth, enrollLimiter, receiveRecording, validate({ body: EnrollFields }), async (req, res) => {
    let tempPath = null;
    try {
        const user = await freshUser(req);
        if (!user) return res.status(401).json({ error: 'Not authenticated' });

        const availability = await voiceprintClient.isVoiceprintAvailable(user);
        if (!availability.available) {
            return res.status(409).json({ error: 'Voice profiles are not available on this deployment.', code: availability.reason });
        }
        // Art. 9(2)(a): explicit, unticked-by-default, per enrollment.
        if (req.body.consent !== 'true') {
            return res.status(400).json({ error: 'Consent is required to record a voice profile.', code: 'consent_required' });
        }
        if (!req.file?.buffer?.length) {
            return res.status(400).json({ error: 'No audio received.', code: 'enroll_failed' });
        }

        const language = req.body.language || null;
        const consent = { at: new Date(), version: CONSENT_VERSION, ip: clientIp(req), userAgent: req.get('user-agent') || null };

        // Visible state before the job runs, so a crash mid-enrollment leaves a
        // "failed" the user can retry rather than a silent nothing.
        await voiceprintStore.markPending({ userId: user.id, organizationId: user.organizationId, language, consent });

        tempPath = path.join(os.tmpdir(), `voiceprint-${crypto.randomUUID()}${path.extname(req.file.originalname || '') || '.webm'}`);
        await fs.promises.writeFile(tempPath, req.file.buffer);

        let created;
        try {
            created = await voiceprintClient.createVoiceprint(tempPath, { language });
        } catch (err) {
            const mapped = voiceprintClient.mapEnrollError(err);
            await voiceprintStore.markFailed(user.id, voiceprintStore.DEFAULT_PROVIDER, mapped.code);
            // Log the UNDERLYING message, not just the code we mapped it to.
            // The code is a guess at what the user should be told; when the
            // guess is wrong (and it will be), this line is the only way to
            // find out what pyannoteAI actually objected to.
            log.warn(`[Voiceprints] Enrollment failed for ${user.id}: ${mapped.code} — ${err.message}`);
            return res.status(mapped.status).json({ error: err.message, code: mapped.code });
        }

        const meta = await voiceprintStore.upsertVoiceprint({
            userId: user.id,
            organizationId: user.organizationId,
            model: created.model,
            voiceprintBase64: created.voiceprint,
            durationSeconds: created.durationSeconds,
            language,
            jobId: created.jobId,
            consent,
        });

        // Consent ledger. Uses the same shape as POST /auth/consents/optional,
        // which records directly instead of going through consentGuards — that
        // is deliberate: consentGuards is cloud-only, and a self-hoster
        // collecting biometric data still needs consent evidence.
        try {
            await userStore.recordConsentAcceptance({
                userId: user.id,
                email: user.email,
                accountType: user.organizationId ? 'org' : 'consumer',
                docId: CONSENT_DOC_ID,
                docVersion: CONSENT_VERSION,
                docSha256: null,
                method: 'consent_grant',
                route: req.originalUrl,
                ip: consent.ip,
                userAgent: consent.userAgent,
                organizationId: user.organizationId || null,
            });
            const state = await userStore.getOptionalConsents(user.id);
            state[CONSENT_DOC_ID] = { granted: true, version: CONSENT_VERSION, updatedAt: new Date().toISOString() };
            await userStore.setOptionalConsents(user.id, state);
        } catch (e) {
            log.warn('[Voiceprints] consent ledger write failed:', e.message);
        }

        res.json({ status: 'ready', voiceprint: meta, enrolled: true });
    } catch (e) {
        log.error('[Voiceprints] POST /me error:', e.message);
        res.status(500).json({ error: 'Could not record your voice profile', code: 'enroll_failed' });
    } finally {
        // Unconditional: the enrollment recording must not survive the request.
        if (tempPath) { try { await fs.promises.unlink(tempPath); } catch (_) {} }
        if (req.file) req.file.buffer = null;
    }
});

/** Delete the caller's own voice profile. Also withdraws the recorded consent. */
router.delete('/me', requireAuth, validate({ body: NoBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const removed = await voiceprintStore.deleteVoiceprintForUser(userId);
        if (removed) await recordConsentWithdrawal(req, userId);
        res.json({ ok: true, removed });
    } catch (e) {
        log.error('[Voiceprints] DELETE /me error:', e.message);
        res.status(500).json({ error: 'Could not delete your voice profile' });
    }
});

/**
 * Mirror a deletion into the consent ledger + optional-consent state, so
 * "granted" can never outlive the data it authorised.
 */
async function recordConsentWithdrawal(req, userId) {
    try {
        const user = await userStore.getUser(userId);
        if (!user) return;
        await userStore.recordConsentAcceptance({
            userId,
            email: user.email,
            accountType: user.organizationId ? 'org' : 'consumer',
            docId: CONSENT_DOC_ID,
            docVersion: CONSENT_VERSION,
            docSha256: null,
            method: 'consent_withdraw',
            route: req.originalUrl,
            ip: clientIp(req),
            userAgent: req.get('user-agent') || null,
            organizationId: user.organizationId || null,
        });
        const state = await userStore.getOptionalConsents(userId);
        state[CONSENT_DOC_ID] = { granted: false, version: CONSENT_VERSION, updatedAt: new Date().toISOString() };
        await userStore.setOptionalConsents(userId, state);
    } catch (e) {
        log.warn('[Voiceprints] consent withdrawal ledger write failed:', e.message);
    }
}

// ── Organisation (read-only coverage + revoke) ───────────────────────

/**
 * Enrollment coverage. Plain members see the counts only — who has recorded a
 * voice profile is not org-wide public information; org admins additionally
 * get the per-member list so they can chase up adoption and offboarding.
 */
router.get('/org/:orgId/coverage', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const orgIds = await resolveUserOrgIds(req);
        const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

        const coverage = await voiceprintStore.countOrgCoverage(orgId);
        if (!(await isOrgAdminForOrg(req, orgId))) return res.json({ ...coverage, members: coverage.members, enrolledUsers: null });

        const meta = await voiceprintStore.listOrgVoiceprintMeta(orgId);
        res.json({
            ...coverage,
            enrolledUsers: meta.map(m => ({
                userId: m.userId,
                name: voiceprintClient.displayNameFor(m),
                createdAt: m.createdAt,
                lastMatchedAt: m.lastMatchedAt,
            })),
        });
    } catch (e) {
        log.error('[Voiceprints] coverage error:', e.message);
        res.status(500).json({ error: 'Could not load voice profile coverage' });
    }
});

/**
 * Revoke a member's voice profile (offboarding, or an erasure request the
 * member can no longer action themselves).
 *
 * Deliberately the ONLY thing an admin may do to someone else's voiceprint —
 * there is no corresponding create, and no read.
 */
router.delete('/org/:orgId/user/:userId', requireAuth, async (req, res) => {
    try {
        const { orgId, userId } = req.params;
        if (!(await isOrgAdminForOrg(req, orgId))) {
            return res.status(403).json({ error: 'Only organization admins can revoke voice profiles' });
        }
        const target = await userStore.getUser(userId);
        if (!target || target.organizationId !== orgId) {
            return res.status(404).json({ error: 'User not found in this organization' });
        }
        const removed = await voiceprintStore.deleteVoiceprintForUser(userId);
        if (removed) {
            log.info(`[Voiceprints] ${req.session.user.id} revoked the voice profile of ${userId} (org ${orgId})`);
            await userStore.logAccessAudit(
                'voiceprint.revoke', 'user', userId, req.session.user.id,
                { enrolled: true }, { enrolled: false }, orgId,
            );
        }
        res.json({ ok: true, removed });
    } catch (e) {
        log.error('[Voiceprints] revoke error:', e.message);
        res.status(500).json({ error: 'Could not revoke the voice profile' });
    }
});

module.exports = router;
