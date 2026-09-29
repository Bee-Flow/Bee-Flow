/**
 * Dictation — speak instead of type, anywhere in the product.
 *
 * POST /api/dictate   multipart: audio=<blob>, [language]
 *   -> 200 { text, provider, durationSec }
 *
 * Deliberately NOT mounted under /api/transcriptions: that whole router sits
 * behind requireModule('meetingNotes') + requireCapability('meeting_notes'),
 * and dictating into a composer has nothing to do with owning the Meeting Notes
 * module. Gating it there would silently switch the microphone off for exactly
 * the installs most likely to want it.
 *
 * Local-only by design. Dictation is short, constant, and full of whatever the
 * user happens to be saying — shipping every utterance to a cloud ASR vendor is
 * the opposite of what this product is for, and it would add round-trip latency
 * to a control that has to feel instant. `transcribeLocally` prefers the NPU
 * (Whisper large-v3-turbo, ~7x realtime) and falls back to the in-process CPU
 * model, so this endpoint works on any install and gets fast on one with an NPU.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Multipart, so the schema sits BEHIND multer: multer reads the stream and
 * only then puts the text fields on `req.body` (the recording goes to
 * `req.file`, not the body), and a validate() in front of it would see an
 * empty one. There is one text field, `language`, and it is `.strict()`
 * because it decides what the recording is heard AS: `languge=en` was
 * dropped, and an English sentence came back transcribed as Dutch. The code
 * is no longer cut to eight characters either — 'portuguese' became
 * 'portugue', a hint neither engine knows.
 *
 * A tag with a region or script (`en-US`, `pt_BR`, `zh-Hant-TW`) is reduced to
 * its language (`en`, `pt`, `zh`): that is all either engine takes. The CPU
 * model refused 'en-us' outright, transcribeLocally reports an inference
 * failure as "no engine", and the answer was a 503 "not available on this
 * server" for a language it knows perfectly well.
 */

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { z } = require('zod');

const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const log = require('../telemetry/log');

const router = express.Router();

const LANGUAGE_TEXT = 'language is a language code, like nl or en.';
const DictateFields = z.preprocess(
    // A request that is not multipart at all reaches here with no body.
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
        language: z.string({ invalid_type_error: LANGUAGE_TEXT }).trim().max(16, LANGUAGE_TEXT)
            // The primary subtag of a BCP-47 tag; a bare code or name passes as it is.
            .transform((v) => v.split(/[-_]/)[0].toLowerCase())
            .optional(),
    }).strict(),
);

// A dictated phrase is seconds long. The cap is generous enough for a long
// paragraph and small enough that this can never be used to push a media file
// through an endpoint that does no virus scanning and no quota accounting.
const MAX_BYTES = 25 * 1024 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        const ok = /^audio\//i.test(file.mimetype || '') || /^video\/webm/i.test(file.mimetype || '');
        // MediaRecorder in Chrome labels its output video/webm even for an
        // audio-only track, so that one non-audio type has to be allowed.
        cb(ok ? null : new Error('Only audio uploads are accepted'), ok);
    },
});

router.post('/', requireAuth, (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
        if (!err) return next();
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
            error: tooBig
                ? `That recording is too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB). Dictate in shorter bursts.`
                : (err.message || 'Upload rejected'),
            code: tooBig ? 'recording_too_large' : 'bad_upload',
        });
    });
}, validate({ body: DictateFields }), async (req, res) => {
    if (!req.file || !req.file.buffer?.length) {
        return res.status(400).json({ error: 'No audio received', code: 'no_audio' });
    }

    const language = req.body.language || 'nl';
    // transcribeLocally reads from a path (it transcodes with ffmpeg), so the
    // buffer is staged to a temp file and removed in `finally` whatever happens.
    const ext = path.extname(req.file.originalname || '') || '.webm';
    const tmpPath = path.join(os.tmpdir(), `dictate-${crypto.randomUUID()}${ext}`);

    try {
        await fs.promises.writeFile(tmpPath, req.file.buffer);
        const { transcribeLocally } = require('../core/voice/localWhisper');
        const result = await transcribeLocally(tmpPath, { language });

        if (!result) {
            return res.status(503).json({
                error: 'Speech recognition is not available on this server right now.',
                code: 'dictation_unavailable',
            });
        }
        return res.json({
            text: result.text || '',
            provider: result.provider || 'local',
            durationSec: result.durationSec ?? null,
        });
    } catch (err) {
        if (err?.code === 'local_whisper_too_long' || err?.code === 'npu_whisper_too_long') {
            return res.status(413).json({ error: err.message, code: 'recording_too_long' });
        }
        log.error('[Dictate] failed:', err.message);
        return res.status(500).json({ error: 'Could not transcribe that recording.', code: 'dictation_failed' });
    } finally {
        try { await fs.promises.unlink(tmpPath); } catch (_) { /* never written */ }
    }
});

/** Whether the UI should offer a microphone at all. */
router.get('/status', requireAuth, async (_req, res) => {
    let npu = false;
    try {
        const { isAvailable } = require('../core/voice/npuWhisper');
        npu = await isAvailable();
    } catch (_) { npu = false; }
    // The CPU model is always a possibility, so dictation is always offered —
    // `engine` only says which one will answer, for the tooltip.
    res.json({ available: true, engine: npu ? 'npu' : 'cpu' });
});

module.exports = router;
