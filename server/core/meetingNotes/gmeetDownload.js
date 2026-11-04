// @typecheck strict
/**
 * The Drive download of a Meet recording (gmeetArtifacts.downloadRecordingToFile):
 * the classified errors a download ends in, and the stream to disk with its
 * stall watchdog. Also the time limits of the download and of the audio
 * extraction, both from the environment.
 */

const fs = require('fs');
const { pipeline } = require('stream/promises');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * The part of a Drive v3 client the download uses.
 * @typedef {{ files: { get: (params: object, opts?: object) => Promise<{ data: unknown }> } }} DriveFiles
 */

// HTTP status off a gaxios error (`.status` on current gaxios, `.response.status`
// always, numeric `.code` on older versions).
/**
 * @param {unknown} err
 * @returns {number | null}
 */
function errStatus(err) {
    const e = /** @type {{ status?: unknown, code?: unknown, response?: { status?: unknown } } | null | undefined} */ (err);
    if (typeof e?.status === 'number') return e.status;
    if (typeof e?.response?.status === 'number') return e.response.status;
    if (typeof e?.code === 'number') return e.code;
    return null;
}

/**
 * @param {string} message
 * @param {string} code
 */
function codedError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

// 403/404 on the recording file both mean "this account can't fetch it" —
// usually only the organizer's Drive has the MP4 (expected terminal state).
/** @param {unknown} err */
function driveAccessError(err) {
    const status = errStatus(err);
    if (status === 403 || status === 404) {
        return codedError('Recording file is not accessible with this Google account (organizer-only Drive access)', 'no_drive_access');
    }
    return codedError(`Recording download failed: ${/** @type {Error} */ (err)?.message}`, 'download_failed');
}

/**
 * A stall watchdog: abort `controller` once `idleTimeoutMs` passes without a
 * `kick()`. 0 disables it.
 * @param {AbortController} controller
 * @param {number} idleTimeoutMs
 */
function idleWatchdog(controller, idleTimeoutMs) {
    /** @type {NodeJS.Timeout | null} */
    let idle = null;
    const stalled = () => controller.abort(new Error(`no data for ${Math.round(idleTimeoutMs / 1000)} s`));
    return {
        kick() {
            if (!idleTimeoutMs) return;
            if (idle) clearTimeout(idle);
            idle = setTimeout(stalled, idleTimeoutMs);
        },
        stop() { if (idle) clearTimeout(idle); },
    };
}

/**
 * Request the recording's media and stream it to `destPath`. A media stream
 * that goes silent while the connection stays open would otherwise hang this
 * await, and with it the pod's whole Meet import tick (nonOverlapping) and the
 * user's manual-import slot. A stall of `idleTimeoutMs` without a byte aborts
 * the download as download_failed.
 * @param {DriveFiles} drive
 * @param {string} driveFileId
 * @param {string} destPath
 * @param {number} idleTimeoutMs
 */
async function streamMediaToFile(drive, driveFileId, destPath, idleTimeoutMs) {
    const controller = new AbortController();
    const watchdog = idleWatchdog(controller, idleTimeoutMs);
    let res;
    try {
        watchdog.kick();
        res = await drive.files.get(
            { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
            { responseType: 'stream', signal: controller.signal },
        );
    } catch (err) {
        watchdog.stop();
        if (controller.signal.aborted) throw codedError(`Recording download failed: ${controller.signal.reason?.message || 'stalled'}`, 'download_failed');
        throw driveAccessError(err);
    }
    try {
        const body = /** @type {import('stream').Readable} */ (res.data);
        body.on('data', () => watchdog.kick());
        controller.signal.addEventListener('abort', () => body.destroy(controller.signal.reason), { once: true });
        watchdog.kick();
        await pipeline(body, fs.createWriteStream(destPath));
    } catch (err) {
        try { fs.unlinkSync(destPath); } catch (unlinkErr) {
            if (/** @type {NodeJS.ErrnoException} */ (unlinkErr).code !== 'ENOENT') bestEffort('core/meetingNotes/gmeetDownload:streamMediaToFile', unlinkErr);
        }
        throw codedError(`Recording download failed: ${/** @type {Error} */ (err).message}`, 'download_failed');
    } finally {
        watchdog.stop();
    }
}

/** How long a Drive download may go without a byte (ms); 0 = no limit. */
function downloadIdleTimeoutMs() {
    const raw = process.env.GMEET_DOWNLOAD_IDLE_TIMEOUT_MS;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 5 * 60_000;
}

/** How long one audio extraction may run (ms); 0 = no limit. */
function extractTimeoutMs() {
    const raw = process.env.MEETING_AUDIO_EXTRACT_TIMEOUT_MS;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 2 * 3600_000;
}

module.exports = { errStatus, codedError, driveAccessError, idleWatchdog, streamMediaToFile, downloadIdleTimeoutMs, extractTimeoutMs };
