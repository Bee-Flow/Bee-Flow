// @typecheck
/**
 * Google Meet artifact helpers — Meet REST API v2 + Drive download.
 *
 * Resolves a meeting code → space → conference record → generated recording,
 * and streams the recording MP4 out of the organizer's Drive (size pre-check
 * first, never buffered in memory). Audio is then extracted with ffmpeg so the
 * video never has to be kept.
 *
 * All functions take a session-shaped `{ accessToken, refreshToken }` first
 * arg (live session or vault shim) and go through the shared
 * `createGoogleApiClient`. Errors that callers must branch on carry stable
 * `.code`s / classified strings — see `downloadRecordingToFile` and
 * `setAutoRecording`.
 */

const fs = require('fs');
const { pipeline } = require('stream/promises');
const { createGoogleApiClient } = require('../../integrations/googleClient');
const log = require('../../telemetry/log');

const NOT_CONNECTED_ERROR = 'Not connected to Google — user must log in with Google';

// Conference-record match window around the calendar slot: meetings often start
// a bit early and Meet keeps a conference alive well past the scheduled end.
const MATCH_PRE_MS = 15 * 60_000;
const MATCH_POST_MS = 6 * 3600_000;

const AUTO_RECORDING_MASK = 'config.artifactConfig.recordingConfig.autoRecordingGeneration';

async function createMeetClient(session) {
    return createGoogleApiClient(session, { api: 'meet', version: 'v2', notConnectedError: NOT_CONNECTED_ERROR });
}

async function createDriveClient(session) {
    return createGoogleApiClient(session, { api: 'drive', version: 'v3', notConnectedError: NOT_CONNECTED_ERROR });
}

// HTTP status off a gaxios error (`.status` on current gaxios, `.response.status`
// always, numeric `.code` on older versions).
function errStatus(err) {
    if (typeof err?.status === 'number') return err.status;
    if (typeof err?.response?.status === 'number') return err.response.status;
    if (typeof err?.code === 'number') return err.code;
    return null;
}

function codedError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

/**
 * Look up a meeting space by its typeable meeting code (`abc-defg-hij` —
 * spaces.get accepts the code as an alias of the space name). Returns the
 * space (with the immutable `name: 'spaces/{space}'`) or null on 404.
 */
async function getSpaceByMeetingCode(session, meetingCode) {
    const meet = await createMeetClient(session);
    try {
        const res = await meet.spaces.get({ name: `spaces/${meetingCode}` });
        return res.data || null;
    } catch (err) {
        if (errStatus(err) === 404) return null;
        throw err;
    }
}

/**
 * Find the conference record for one meeting occurrence: list records of the
 * space and pick the one that best matches [meetingStart, meetingEnd].
 *
 * "Latest start wins" was wrong on the case this feature exists for: a standing
 * Meet link. The candidate window runs to `meetingEnd + 6h`, so the 14:00
 * stand-up's job would happily pick up the 16:00 meeting's conference record on
 * the same link — the later start always won, overlap or not — and file that
 * recording, transcript and summary under the 14:00 meeting. Two teams'
 * meetings, one note, and the 14:00 attendees get a note about the 16:00 call.
 *
 * Score by actual temporal overlap with the calendar slot instead, and only
 * fall back to proximity when nothing overlaps at all (a meeting that ran
 * entirely outside its booked slot is still the right answer when it is the
 * only candidate). Returns the record (consumers key on `record.name`) or null.
 * @param session
 * @param {{ spaceName?: string, meetingStart?: string|Date, meetingEnd?: string|Date }} [opts]
 */
async function findConferenceRecord(session, { spaceName, meetingStart, meetingEnd } = {}) {
    if (!spaceName || !meetingStart) return null;
    // spaceName is interpolated into the API filter string below; it comes from
    // Google's own Calendar API, but validate the expected shape anyway so a
    // malformed value can never smuggle quotes into the filter.
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(String(spaceName))) return null;
    const meet = await createMeetClient(session);

    const startMs = new Date(meetingStart).getTime();
    const endMs = meetingEnd ? new Date(meetingEnd).getTime() : startMs;
    const windowStart = startMs - MATCH_PRE_MS;
    const windowEnd = endMs + MATCH_POST_MS;

    let best = null;
    // Overlap in ms with the booked slot. 0 means "in the window but not
    // overlapping"; anything overlapping outranks everything that doesn't.
    let bestOverlap = -1;
    let bestDistance = Infinity;
    let pageToken;
    for (let page = 0; page < 3; page++) {
        const res = await meet.conferenceRecords.list({
            filter: `space.name = "${spaceName}"`,
            pageSize: 50,
            ...(pageToken ? { pageToken } : {}),
        });
        for (const record of res.data?.conferenceRecords || []) {
            const recStart = new Date(record.startTime || 0).getTime();
            // Ongoing conferences have no endTime yet — treat as "still running".
            const recEnd = record.endTime ? new Date(record.endTime).getTime() : Date.now();
            if (recStart > windowEnd || recEnd < windowStart) continue;

            const overlap = Math.max(0, Math.min(recEnd, endMs) - Math.max(recStart, startMs));
            // How far the conference sits from the booked slot, for the
            // non-overlapping fallback only.
            const distance = recStart >= endMs ? recStart - endMs
                : recEnd <= startMs ? startMs - recEnd
                    : 0;

            if (overlap > bestOverlap) {
                best = record; bestOverlap = overlap; bestDistance = distance;
            } else if (overlap === bestOverlap && overlap === 0 && distance < bestDistance) {
                // Nothing overlaps yet — keep the nearest, not the latest.
                best = record; bestDistance = distance;
            } else if (overlap === bestOverlap && overlap > 0 && recStart > new Date(best.startTime || 0).getTime()) {
                // Genuinely equal overlap (a rejoin splits one meeting into two
                // records): the later one is the live continuation.
                best = record; bestDistance = distance;
            }
        }
        pageToken = res.data?.nextPageToken || null;
        if (!pageToken) break;
    }
    return best;
}

/**
 * Find the generated recording of a conference record.
 * → { recordingName, driveFileId }  when a FILE_GENERATED recording exists
 * → { notReady: true }              recordings exist but no file yet
 * → { none: true }                  the conference has no recordings at all
 */
async function findGeneratedRecording(session, conferenceRecordName) {
    const meet = await createMeetClient(session);
    const res = await meet.conferenceRecords.recordings.list({
        parent: conferenceRecordName,
        pageSize: 10,
    });
    const recordings = res.data?.recordings || [];
    if (!recordings.length) return { none: true };
    const generated = recordings.find(r => r.state === 'FILE_GENERATED' && r.driveDestination?.file);
    if (generated) return { recordingName: generated.name, driveFileId: generated.driveDestination.file };
    return { notReady: true };
}

/**
 * Display names of everyone in a conference (signed-in, anonymous and phone
 * participants), for roster-anchored speaker naming. Best-effort: [] on error.
 */
async function listParticipantNames(session, conferenceRecordName) {
    try {
        const meet = await createMeetClient(session);
        const names = [];
        let pageToken;
        do {
            const res = await meet.conferenceRecords.participants.list({
                parent: conferenceRecordName,
                pageSize: 100,
                ...(pageToken ? { pageToken } : {}),
            });
            for (const p of res.data?.participants || []) {
                const name = p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || null;
                if (name && !names.includes(name)) names.push(name);
            }
            pageToken = res.data?.nextPageToken || null;
        } while (pageToken && names.length < 200);
        return names;
    } catch (err) {
        log.warn(`[GmeetArtifacts] participants list failed for ${conferenceRecordName}: ${err.message}`);
        return [];
    }
}

function classifyAutoRecordingError(err) {
    const status = errStatus(err);
    if (status === 400) return 'unsupported_edition';
    if (status === 403) {
        const data = err?.response?.data?.error;
        const reasons = [
            ...(Array.isArray(data?.errors) ? data.errors : []),
            ...(Array.isArray(data?.details) ? data.details : []),
        ].map(d => String(d?.reason || '').toUpperCase());
        const message = String(data?.message || err?.message || '').toLowerCase();
        if (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || message.includes('scope')) return 'no_scope';
        return 'not_host';
    }
    return 'error';
}

/**
 * Pre-configure auto-recording on a meeting space (host-only; needs the
 * `meetings.space.settings` scope and a Workspace edition with recording).
 * → { ok: true } | { error: 'not_host'|'no_scope'|'unsupported_edition'|'error' }
 * @param session
 * @param {{ meetingCode?: string, enabled?: boolean }} [opts]
 */
async function setAutoRecording(session, { meetingCode, enabled } = {}) {
    try {
        const meet = await createMeetClient(session);
        // spaces.patch only accepts the immutable `spaces/{space}` name, so
        // resolve the meeting-code alias first (spaces.get accepts both).
        let name = `spaces/${meetingCode}`;
        try {
            const space = await meet.spaces.get({ name });
            if (space.data?.name) name = space.data.name;
        } catch (_) { /* fall through — the patch below yields the classified error */ }
        await meet.spaces.patch({
            name,
            updateMask: AUTO_RECORDING_MASK,
            requestBody: {
                config: { artifactConfig: { recordingConfig: { autoRecordingGeneration: enabled ? 'ON' : 'OFF' } } },
            },
        });
        return { ok: true };
    } catch (err) {
        return { error: classifyAutoRecordingError(err) };
    }
}

// 403/404 on the recording file both mean "this account can't fetch it" —
// usually only the organizer's Drive has the MP4 (expected terminal state).
function driveAccessError(err) {
    const status = errStatus(err);
    if (status === 403 || status === 404) {
        return codedError('Recording file is not accessible with this Google account (organizer-only Drive access)', 'no_drive_access');
    }
    return codedError(`Recording download failed: ${err.message}`, 'download_failed');
}

/**
 * Stream a recording MP4 from Drive to `destPath`. Checks the file size via
 * metadata BEFORE requesting any media (Meet recordings are 0.4–1 GB/h).
 * Throws Error with `.code`:
 *   'recording_too_large' — metadata size exceeds `maxBytes` (no media request)
 *   'no_drive_access'     — 403/404 from Drive (metadata or media)
 *   'download_failed'     — anything else
 * Returns { size, name, mimeType } on success.
 * @param session
 * @param driveFileId
 * @param destPath
 * @param {{ maxBytes?: number }} [opts]
 */
async function downloadRecordingToFile(session, driveFileId, destPath, { maxBytes } = {}) {
    const drive = await createDriveClient(session);

    let meta;
    try {
        meta = await drive.files.get({
            fileId: driveFileId,
            fields: 'size,name,mimeType',
            supportsAllDrives: true,
        });
    } catch (err) {
        throw driveAccessError(err);
    }
    const size = Number(meta.data?.size) || 0;
    if (maxBytes && size > maxBytes) {
        throw codedError(`Recording is ${size} bytes — exceeds the ${maxBytes} byte limit`, 'recording_too_large');
    }

    let res;
    try {
        res = await drive.files.get(
            { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
            { responseType: 'stream' },
        );
    } catch (err) {
        throw driveAccessError(err);
    }
    try {
        await pipeline(res.data, fs.createWriteStream(destPath));
    } catch (err) {
        try { fs.unlinkSync(destPath); } catch (_) {}
        throw codedError(`Recording download failed: ${err.message}`, 'download_failed');
    }
    return { size, name: meta.data?.name || null, mimeType: meta.data?.mimeType || null };
}

/**
 * Extract the audio track of a downloaded recording into a mono AAC .m4a
 * (~30 MB/h vs 0.4–1 GB/h for the video). Deletes nothing itself — the caller
 * owns cleanup of both paths. Resolves to `audioPath`.
 */
async function extractAudioTrack(videoPath, audioPath) {
    // Same ffmpeg binary resolution as the Azure STT branch in routes/transcriptions.js.
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const { spawn } = require('child_process');
    const args = ['-y', '-i', videoPath, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', audioPath];
    await new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        let stderr = '';
        proc.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ''}`));
        });
    });
    return audioPath;
}

module.exports = {
    getSpaceByMeetingCode,
    findConferenceRecord,
    findGeneratedRecording,
    listParticipantNames,
    setAutoRecording,
    downloadRecordingToFile,
    extractAudioTrack,
};
