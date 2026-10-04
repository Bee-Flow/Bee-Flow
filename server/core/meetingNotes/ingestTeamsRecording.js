// @typecheck
/**
 * ingestTeamsRecording — turn a finished Microsoft Teams meeting into a
 * Meeting Note.
 *
 * Shared entry point for the manual route (`POST /api/transcriptions/from-teams`)
 * and the background poller (`teamsAutoImport.js`). Two inputs:
 *
 *   - a RECORDING (preferred): the MP4 is streamed from Graph to disk, the
 *     audio track is extracted with ffmpeg and the video deleted at once; the
 *     audio runs through the instance's own transcription engine, diarisation
 *     and speaker naming, exactly like an upload.
 *   - a TRANSCRIPT (fallback, when the meeting was transcribed but not
 *     recorded): the WebVTT is parsed into segments that already carry the
 *     speakers' Teams display names, and only the summary passes run. Such a
 *     note has no audio.
 *
 * The provider-agnostic middle lives in `ingestRecordingCore.js`.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { parseTeamsVtt } = require('./teamsVtt');
const { lazyDeps } = require('./lazyDeps');
const log = require('../../telemetry/log');

/** Collaborators, loaded on first use; tests swap them through init(). */
const { deps: d, init } = lazyDeps({
    transcriptionStore: () => require('../../stores/transcriptionStore'),
    /** ingestLocalRecording, assertDedupHitReadable and the IngestError class */
    core: () => require('./ingestRecordingCore'),
    artifacts: () => require('./teamsArtifacts'),
    scratchDir: () => require('./savedAudioStore').AUDIO_SCRATCH_DIR,
    getUserByEmail: () => require('../../stores/userStore').getUserByEmail,
});

/** @param {string} message @param {{ code: string, status: number }} meta */
function ingestError(message, meta) {
    return new d.core.IngestError(message, meta);
}

// Same ceiling as a manual upload, applied to the extracted AUDIO.
const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const MAX_SHARED_WITH = 50;

/** Dedup key of one Teams artifact (recording or transcript) for one owner scope. */
function teamsSourceUri({ orgId, userId, meetingId, artifactKind, artifactId }) {
    return `teams://${orgId || `user:${userId}`}/${meetingId}/${artifactKind}/${artifactId}`;
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {object} opts.session          Microsoft session or shim
 * @param {string|null} [opts.orgId]
 * @param {string} opts.meetingId        Graph onlineMeeting id
 * @param {{ kind: 'recording'|'transcript', id: string }} opts.artifact
 * @param {string|null} [opts.title]     calendar subject (title hint)
 * @param {string} [opts.language]
 * @param {string} [opts.contextTerms]
 * @param {Array<{email?: string|null, displayName?: string|null}>} [opts.attendees]
 * @param {object} [opts.accessCtx]      for a dedup hit the caller must be able to read
 */
async function ingestTeamsMeeting(opts) {
    const {
        userId, session, orgId = null, meetingId, artifact,
        title = null, language = 'nl', contextTerms = '', attendees = [],
    } = opts || {};

    if (!userId) throw ingestError('userId is required', { code: 'failed', status: 400 });
    if (!meetingId || !artifact?.id || !['recording', 'transcript'].includes(artifact.kind)) {
        throw ingestError('meetingId and a recording or transcript are required', { code: 'failed', status: 400 });
    }

    const sourceUri = teamsSourceUri({ orgId, userId, meetingId, artifactKind: artifact.kind, artifactId: artifact.id });
    const existing = await d.transcriptionStore.getTranscriptionBySourceUri(sourceUri);
    if (existing) {
        await d.core.assertDedupHitReadable(existing, userId, opts.accessCtx);
        return { id: existing.id, title: existing.title, dedup: true, sourceUri };
    }

    const participantNames = rosterOf(attendees);
    const sharedWith = await resolveSharedWith(userId, orgId, attendees);
    const common = {
        userId, orgId, language, contextTerms,
        titleHint: title, participantNames,
        source: 'teams', sourceUri,
        extraStoreFields: { sharedWith },
    };

    if (artifact.kind === 'transcript') {
        const vtt = await d.artifacts.fetchTranscriptVtt(session, { meetingId, transcriptId: artifact.id });
        const parsed = parseTeamsVtt(vtt);
        if (!parsed.segments.length) {
            throw ingestError('The Teams transcript is empty.', { code: 'empty_transcription', status: 502 });
        }
        const named = parsed.segments.some(s => s.speakerId && s.speakerId !== 'Unknown');
        return d.core.ingestLocalRecording({
            ...common,
            fileName: `${title || 'Teams meeting'}.vtt`,
            provider: 'teams_transcript',
            transcriptResponse: parsed,
            speakersNamed: named,
        });
    }

    const uploadsDir = d.scratchDir;
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const stem = path.join(uploadsDir, `${Date.now()}-${crypto.randomUUID()}-${userId}`);
    const videoPath = `${stem}.mp4`;
    const audioPath = `${stem}.m4a`;
    try {
        await d.artifacts.downloadRecordingToFile(session, { meetingId, recordingId: artifact.id, destPath: videoPath });
        try {
            await d.artifacts.extractAudioTrack(videoPath, audioPath);
        } catch (err) {
            safeUnlink(audioPath);
            throw ingestError(`Audio extraction failed: ${err.message}`, { code: 'failed', status: 500 });
        }
        let size;
        try { ({ size } = fs.statSync(audioPath)); }
        catch (err) {
            throw ingestError(`Audio extraction produced no readable file: ${err.message}`, { code: 'failed', status: 500 });
        }
        if (size > MAX_AUDIO_BYTES) {
            safeUnlink(audioPath);
            throw ingestError('Recording exceeds the 500 MB limit.', { code: 'recording_too_large', status: 413 });
        }
    } finally {
        safeUnlink(videoPath);
    }

    return d.core.ingestLocalRecording({
        ...common,
        filePath: audioPath,
        fileName: `${title || 'Teams meeting'}.m4a`,
    });
}

/** Calendar display names, for anchoring diarised speakers to real people. */
function rosterOf(attendees) {
    const names = [];
    for (const a of Array.isArray(attendees) ? attendees : []) {
        const name = String(a?.displayName || '').trim();
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

/**
 * Attendees who are users of this instance IN THE OWNER'S ORGANISATION get read
 * access to the note, matched on their account e-mail. Best-effort: [] on error.
 */
async function resolveSharedWith(ownerId, orgId, attendees) {
    try {
        const emails = new Set();
        for (const a of Array.isArray(attendees) ? attendees : []) {
            const email = String(a?.email || '').trim().toLowerCase();
            if (email) emails.add(email);
        }
        if (!emails.size || !orgId) return [];
        const ids = [];
        for (const email of emails) {
            const u = await d.getUserByEmail(email);
            if (!u || String(u.id) === String(ownerId) || u.organizationId !== orgId || ids.includes(u.id)) continue;
            ids.push(u.id);
            if (ids.length >= MAX_SHARED_WITH) break;
        }
        return ids;
    } catch (err) {
        log.warn(`[IngestTeams] sharedWith resolution failed: ${err.message}`);
        return [];
    }
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

module.exports = { init, ingestTeamsMeeting, teamsSourceUri, rosterOf };
