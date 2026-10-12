// @typecheck
/**
 * Microsoft Teams artifact helpers — Graph onlineMeetings, recordings and
 * transcripts (delegated, as the meeting organizer).
 *
 * Resolves a calendar join URL → onlineMeeting → the recording (or transcript)
 * of one occurrence, and streams the recording MP4 to disk without buffering
 * it. The audio is then extracted with the same ffmpeg helper the Meet path
 * uses, so the video is never kept.
 *
 * Why the RECORDING is the primary artifact and the transcript only the
 * fallback: since mid-2026 Graph access to transcripts is off by default per
 * tenant (`EnableGraphTranscriptAccess`, with speaker attribution as a second
 * switch), while recordings are not behind that switch. Transcribing the
 * recording ourselves also keeps diarisation and speaker naming identical to
 * every other Meeting Notes source.
 *
 * All functions take a session-shaped `{ accessToken, refreshToken, save? }`
 * first (live Microsoft session or the shim from resolveMicrosoftSession).
 * Errors callers branch on carry a stable `.code`.
 */

const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { parseTeamsVtt } = require('./teamsVtt');

const { lazyDeps } = require('./lazyDeps');

/** Collaborators; tests swap them through init(). */
const { deps, init } = lazyDeps({
    graphRequest: () => require('../../integrations/msGraphClient').graphRequest,
});

/** ffmpeg audio extraction, shared with the Meet path (loaded on first use). */
function extractAudioTrack(videoPath, audioPath) {
    return require('./gmeetArtifacts').extractAudioTrack(videoPath, audioPath);
}

// Occurrence match window around the calendar slot, same reasoning as Meet:
// meetings start early and run long, and recurring meetings share ONE
// onlineMeeting, so every occurrence's recordings come back in one list.
const MATCH_PRE_MS = 15 * 60_000;
const MATCH_POST_MS = 6 * 3600_000;

// Teams recordings are video; cap the download well above any real meeting so
// a runaway stream cannot fill the disk.
const DEFAULT_MAX_VIDEO_BYTES = Number(process.env.TEAMS_MAX_RECORDING_BYTES) || 6 * 1024 * 1024 * 1024;

// Opaque Graph ids (base64-ish). encodeURIComponent below keeps any `/` from
// becoming a path separator; this only refuses obvious garbage.
const MEETING_ID_RE = /^[A-Za-z0-9+/_=-]{1,1024}$/;

function codedError(message, code, status = null) {
    const e = /** @type {Error & {code?: string, status?: number|null}} */ (new Error(message));
    e.code = code;
    if (status) e.status = status;
    return e;
}

function assertId(value, what) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- MEETING_ID_RE is a constant anchored class with a bounded {1,1024} repeat: linear
    if (typeof value !== 'string' || !MEETING_ID_RE.test(value)) {
        throw codedError(`Not a valid Teams ${what} id`, 'failed');
    }
    return encodeURIComponent(value);
}

async function readGraphError(response) {
    const body = await response.text().catch(() => '');
    try {
        const parsed = JSON.parse(body);
        return { code: String(parsed?.error?.code || ''), message: String(parsed?.error?.message || '') };
    } catch (_) {
        return { code: '', message: body.slice(0, 300) };
    }
}

/**
 * Map a failed Graph response onto a stable code.
 *   403 + GraphAccessToTranscriptsDisabled → transcript_access_disabled
 *   403 + SpeakerAttributionNotAllowed     → speaker_attribution_disabled
 *   403 mentioning scope / consent          → needs_teams_scopes
 *   403 otherwise                            → not_organizer
 *   404                                      → not_found
 */
async function classifyGraphFailure(response, context) {
    const { code, message } = await readGraphError(response);
    const text = `${code} ${message}`.toLowerCase();
    if (response.status === 403) {
        if (text.includes('graphaccesstotranscriptsdisabled')) {
            return codedError('Your Teams admin has turned off API access to meeting transcripts', 'transcript_access_disabled', 403);
        }
        if (text.includes('speakerattributionnotallowed')) {
            return codedError('Your Teams admin does not allow speaker names in transcripts', 'speaker_attribution_disabled', 403);
        }
        if (text.includes('scope') || text.includes('consent') || text.includes('permission')) {
            return codedError(`${context}: Microsoft did not grant the Teams meeting permissions`, 'needs_teams_scopes', 403);
        }
        return codedError(`${context}: only the meeting organizer can read this`, 'not_organizer', 403);
    }
    if (response.status === 404) return codedError(`${context}: not found`, 'not_found', 404);
    return codedError(`${context}: Microsoft Graph returned ${response.status}${message ? ` (${message})` : ''}`, 'failed', 502);
}

/** @returns {Promise<any>} */
async function graphJson(path, session, context, options = {}) {
    const response = await deps.graphRequest(path, session, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!response.ok) throw await classifyGraphFailure(response, context);
    if (response.status === 204) return {};
    return response.json();
}

/**
 * The onlineMeeting behind a calendar join URL, or null when this account
 * cannot see one (Graph returns an empty list for meetings the user does not
 * organize).
 */
async function getOnlineMeetingByJoinUrl(session, joinUrl) {
    if (!joinUrl) return null;
    const filter = `JoinWebUrl eq '${String(joinUrl).replace(/'/g, "''")}'`;
    const data = await graphJson(`/me/onlineMeetings?$filter=${encodeURIComponent(filter)}`, session, 'Looking up the Teams meeting');
    const meeting = (data?.value || [])[0] || null;
    return meeting && meeting.id ? meeting : null;
}

async function listCollection(session, meetingId, collection) {
    const id = assertId(meetingId, 'meeting');
    const items = [];
    let next = `/me/onlineMeetings/${id}/${collection}`;
    for (let page = 0; next && page < 5; page++) {
        const data = await graphJson(next, session, `Listing Teams ${collection}`);
        items.push(...(data?.value || []));
        next = data?.['@odata.nextLink'] || null;
    }
    return items;
}

/** All recordings of an onlineMeeting (every occurrence of a series). */
function listRecordings(session, meetingId) { return listCollection(session, meetingId, 'recordings'); }

/** All transcripts of an onlineMeeting (every occurrence of a series). */
function listTranscripts(session, meetingId) { return listCollection(session, meetingId, 'transcripts'); }

/**
 * Pick the artifact (recording or transcript) that belongs to one calendar
 * occurrence: largest overlap with [meetingStart, meetingEnd], else the
 * nearest one inside the match window, else null. Pure.
 * @param {Array<{id?: string, createdDateTime?: string, endDateTime?: string}>} items
 * @param {{ meetingStart?: string|Date|null, meetingEnd?: string|Date|null }} slot
 */
function pickArtifactForSlot(items, { meetingStart, meetingEnd } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!meetingStart) return list.length === 1 ? list[0] : null;
    const startMs = new Date(meetingStart).getTime();
    const endMs = meetingEnd ? new Date(meetingEnd).getTime() : startMs;
    const windowStart = startMs - MATCH_PRE_MS;
    const windowEnd = endMs + MATCH_POST_MS;

    let best = null;
    let bestOverlap = -1;
    let bestDistance = Infinity;
    for (const item of list) {
        const itemStart = new Date(item?.createdDateTime || 0).getTime();
        const itemEnd = item?.endDateTime ? new Date(item.endDateTime).getTime() : itemStart;
        if (!Number.isFinite(itemStart) || itemStart > windowEnd || itemEnd < windowStart) continue;
        const overlap = Math.max(0, Math.min(itemEnd, endMs) - Math.max(itemStart, startMs));
        const distance = itemStart >= endMs ? itemStart - endMs : itemEnd <= startMs ? startMs - itemEnd : 0;
        if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
            best = item; bestOverlap = overlap; bestDistance = distance;
        }
    }
    return best;
}

/**
 * Stream a recording MP4 to `destPath`. Refuses (code `recording_too_large`)
 * when Content-Length or the running byte count passes `maxBytes`.
 * @param {object} session
 * @param {{ meetingId: string, recordingId: string, destPath: string, maxBytes?: number }} opts
 */
async function downloadRecordingToFile(session, { meetingId, recordingId, destPath, maxBytes = DEFAULT_MAX_VIDEO_BYTES }) {
    const path = `/me/onlineMeetings/${assertId(meetingId, 'meeting')}/recordings/${assertId(recordingId, 'recording')}/content`;
    const response = await deps.graphRequest(path, session, {});
    if (!response.ok) throw await classifyGraphFailure(response, 'Downloading the Teams recording');
    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared && declared > maxBytes) {
        await response.body?.cancel?.().catch(() => {});
        throw codedError(`Recording is ${declared} bytes — exceeds the ${maxBytes} byte limit`, 'recording_too_large', 413);
    }
    if (!response.body) throw codedError('Microsoft Graph returned an empty recording', 'download_failed', 502);

    let seen = 0;
    const limiter = new Transform({
        transform(chunk, _enc, done) {
            seen += chunk.length;
            if (seen > maxBytes) done(codedError(`Recording exceeds the ${maxBytes} byte limit`, 'recording_too_large', 413));
            else done(null, chunk);
        },
    });
    try {
        await pipeline(Readable.fromWeb(/** @type {any} */ (response.body)), limiter, fs.createWriteStream(destPath));
    } catch (err) {
        try { fs.unlinkSync(destPath); } catch (_) {}
        if (err?.code === 'recording_too_large') throw err;
        throw codedError(`Recording download failed: ${err.message}`, 'download_failed', 502);
    }
    return { size: seen };
}

/** The transcript of one occurrence as WebVTT text (with `<v Name>` voice tags). */
async function fetchTranscriptVtt(session, { meetingId, transcriptId }) {
    const path = `/me/onlineMeetings/${assertId(meetingId, 'meeting')}/transcripts/${assertId(transcriptId, 'transcript')}/content?$format=text/vtt`;
    const response = await deps.graphRequest(path, session, { headers: { Accept: 'text/vtt' } });
    if (!response.ok) throw await classifyGraphFailure(response, 'Downloading the Teams transcript');
    return response.text();
}

/**
 * Turn Teams' own "record automatically" on or off for a meeting the user
 * organizes (needs OnlineMeetings.ReadWrite). Never throws.
 * → { ok: true } | { error: 'not_organizer'|'needs_teams_scopes'|'not_found'|'error' }
 */
async function setRecordAutomatically(session, { joinUrl, enabled }) {
    try {
        const meeting = await getOnlineMeetingByJoinUrl(session, joinUrl);
        if (!meeting) return { error: 'not_organizer' };
        await graphJson(`/me/onlineMeetings/${assertId(meeting.id, 'meeting')}`, session, 'Updating the Teams meeting', {
            method: 'PATCH',
            body: JSON.stringify({ recordAutomatically: !!enabled }),
        });
        return { ok: true };
    } catch (err) {
        const code = err?.code;
        if (code === 'not_organizer' || code === 'needs_teams_scopes' || code === 'not_found') return { error: code };
        return { error: 'error' };
    }
}

module.exports = {
    init,
    getOnlineMeetingByJoinUrl,
    listRecordings,
    listTranscripts,
    pickArtifactForSlot,
    downloadRecordingToFile,
    fetchTranscriptVtt,
    parseTeamsVtt,
    setRecordAutomatically,
    extractAudioTrack,
};
