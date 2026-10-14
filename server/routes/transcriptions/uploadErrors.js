'use strict';
/**
 * The transcriptions router's error middleware.
 *
 * Only the upload's own refusals are answered here (a multer limit, or the
 * audio-format filter in ./upload.js), with the 400 the client has always
 * read. Everything else, including a deliberate HttpError 5xx or a database
 * failure, goes on to the terminal handler (core/http/terminalErrorHandler.js),
 * which never echoes an internal message. This handler used to answer every
 * error as 400 { error: err.message }, which handed SQL text to the client.
 */

const multer = require('multer');

/** Set on the fileFilter's rejection in ./upload.js. */
const UNSUPPORTED_AUDIO_FORMAT = 'UNSUPPORTED_AUDIO_FORMAT';

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

module.exports = { uploadErrorHandler, UNSUPPORTED_AUDIO_FORMAT };
