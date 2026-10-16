'use strict';
/**
 * The audio upload of POST /api/transcriptions (./upload.js): the multer
 * instance, and the transcriptions router's error middleware.
 *
 * Only the upload's own refusals are answered by the middleware (a multer
 * limit, or the audio-format filter below), with the 400 the client has always
 * read. Everything else, including a deliberate HttpError 5xx or a database
 * failure, goes on to the terminal handler (core/http/terminalErrorHandler.js),
 * which never echoes an internal message. This handler used to answer every
 * error as 400 { error: err.message }, which handed SQL text to the client.
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');

/** Set on the fileFilter's rejection below. */
const UNSUPPORTED_AUDIO_FORMAT = 'UNSUPPORTED_AUDIO_FORMAT';

// Multer for audio file upload. Scratch in /tmp; the kept copies are
// saved-recordings and RustFS, made by ./upload.js.
const { AUDIO_SCRATCH_DIR: uploadsDir } = require('../../core/meetingNotes/savedAudioStore');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const allowed = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg', '.aac'];
        if (allowed.includes(ext) || file.mimetype?.startsWith('audio/')) {
            cb(null, true);
        } else {
            // The code lets uploadErrorHandler below answer this one 400 itself.
            const err = new Error('Unsupported audio format. Supported: MP3, WAV, M4A, OGG, WEBM, FLAC, MP4, AAC');
            err.code = UNSUPPORTED_AUDIO_FORMAT;
            cb(err);
        }
    },
});

function uploadErrorHandler(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 500 MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err?.code === UNSUPPORTED_AUDIO_FORMAT) return res.status(400).json({ error: err.message });
    next(err);
}

module.exports = { upload, uploadErrorHandler, UNSUPPORTED_AUDIO_FORMAT };
