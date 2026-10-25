// @typecheck strict
'use strict';
/**
 * Save the session that now holds a WebAuthn challenge, before the options go
 * out: an unsaved challenge would only fail later, at verification, with a
 * confusing "expired". A failed save is a 503 the client can simply retry.
 */
const { HttpError } = require('../../shared/httpErrors');

/**
 * @param {{ session: { save: (cb: (err?: Error) => void) => unknown } }} req
 * @param {{ warn: Function }} log
 * @returns {Promise<void>}
 */
function saveChallenge(req, log) {
    return new Promise((resolve, reject) => {
        req.session.save((err) => {
            if (!err) return resolve();
            log.warn('[SecurityKeys] session save failed:', err.message);
            reject(new HttpError(503, 'session_unavailable', 'Could not start the security key check. Try again.'));
        });
    });
}

module.exports = { saveChallenge };
