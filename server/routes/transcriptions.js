/**
 * Transcriptions API — REST endpoints for meeting transcription history.
 *
 * GET    /api/transcriptions          — List user's transcriptions
 * GET    /api/transcriptions/:id      — Get full transcription with segments
 * POST   /api/transcriptions          — Upload & transcribe an audio file
 * PATCH  /api/transcriptions/:id      — Rename a transcription
 * DELETE /api/transcriptions/:id      — Delete a transcription
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');

// Route logic lives in focused sub-modules under routes/transcriptions/,
// mounted here in the exact order the routes were registered before the split.
// Order is semantics: GET /:id is registered ahead of the static GET routes
// (/nextcloud-talk-recordings, /talk-meetings, /gmeet-*, /teams-*) and lets their literal
// names fall through via RESERVED_GET_PATHS — see ./transcriptions/notes.js.
//
// ── THESE TWO GO FIRST, AND THAT IS CORRECTNESS ─────────────────────
// `./tags` serves the literal `GET /tags`, which is NOT in notes.js's
// RESERVED_GET_PATHS: mounted after ./notes it was swallowed by `GET /:id`
// and answered 404 with "tags" read as a note id. It shipped that way — both
// of its test files drive the sub-router directly, so neither could see it,
// and the client fell back to counting the tags on the page it had loaded.
// `./usage` (M2) is a two-segment path and would survive either order, but it
// is the same class of route and sits beside its sibling so the next one added
// here inherits the safe position rather than the accident.
// transcriptions.mount.test.js drives the COMPOSED router and fails if either
// slips back below ./notes.
router.use('/', require('./transcriptions/tags'));
router.use('/', require('./transcriptions/usage'));
router.use('/', require('./transcriptions/notes'));
router.use('/', require('./transcriptions/report'));
router.use('/', require('./transcriptions/upload'));
router.use('/', require('./transcriptions/reprocess'));
router.use('/', require('./transcriptions/audio'));
router.use('/', require('./transcriptions/noteActions'));
router.use('/', require('./transcriptions/speakers'));
router.use('/', require('./transcriptions/nextcloud'));
router.use('/', require('./transcriptions/gmeet'));
router.use('/', require('./transcriptions/teams'));

// ── Multer error handling ────────────────────────────────

router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 500 MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
});

module.exports = router;
