// @typecheck
/**
 * Send a readable (storage object, file) to an HTTP response without leaking it.
 *
 * `source.pipe(res)` does not destroy the source when the client goes away. For an
 * S3 GetObject body that keeps the socket checked out of the SDK's pool until the
 * pool is empty and every storage call waits forever. `pipeline` destroys both ends
 * on an error or a premature close, so the socket returns to the pool.
 */
const { pipeline } = require('stream');

/**
 * @param {import('stream').Readable} source
 * @param {import('http').ServerResponse} res
 * @param {(err: Error) => void} [onError] called for a real stream error only
 *   (not for a client that went away)
 */
function sendStream(source, res, onError) {
    pipeline(source, res, (err) => {
        if (!err) return;
        // The client closed the connection (seek, preload, navigation): normal.
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        if (onError) onError(err);
    });
}

module.exports = { sendStream };
