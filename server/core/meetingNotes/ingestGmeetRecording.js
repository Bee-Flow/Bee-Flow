// @typecheck strict
/**
 * ingestGmeetRecording — download a finished Google Meet recording from the
 * organizer's Drive and run it through Bee Flow's own transcription pipeline,
 * producing a Meeting Note with transcript, diarized speakers, summary, AI
 * title and action items.
 *
 * Shared entry point for BOTH:
 *   - the HTTP route `POST /api/transcriptions/from-gmeet` (manual import)
 *   - the background Google Meet auto-import worker (`gmeetAutoImport.js`)
 *
 * The MP4 is streamed to disk, the audio track is extracted with ffmpeg and
 * the video is deleted immediately — only the audio (~30 MB/h) continues into
 * the pipeline, and only the audio is subject to the 500 MB cap (Meet video
 * runs 0.4–1 GB/h; capping the MP4 would reject transcribable two-hour
 * meetings). Transcription is PINNED to WhisperX for gmeet ingests (owner
 * decision — one-line switch to admin-config parity if later wanted).
 *
 * The provider-agnostic middle (transcribe → diarize → summarize → persist)
 * lives in `ingestRecordingCore.js`; this wrapper owns the Drive download,
 * the audio extraction, the Meet participant roster and the attendee →
 * connected-user sharing map.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const transcriptionStore = require('../../stores/transcriptionStore');
const { ingestLocalRecording, IngestError, assertDedupHitReadable } = require('./ingestRecordingCore');
const { downloadRecordingToFile, extractAudioTrack, listParticipantNames } = require('./gmeetArtifacts');
const { AUDIO_SCRATCH_DIR: uploadsDir } = require('./savedAudioStore');
const log = require('../../telemetry/log');
const { ignoreGone } = require('../../utils/bestEffort');

// Hard ceiling — matches the manual-upload multer limit. Applied to the
// extracted AUDIO, not the downloaded video (see module doc).
const MAX_RECORDING_BYTES = 500 * 1024 * 1024;

// Auto-sharing never grows unbounded (webinar-sized attendee lists).
const MAX_SHARED_WITH = 50;

/**
 * @param {{ accessCtx?: import('../../stores/transcription/acl').ReadAclCtx, userId: string,
 *   session: import('./gmeetArtifacts').GoogleSession, orgId?: string | null, conferenceRecordName: string,
 *   driveFileId: string, meetingCode?: string | null, title?: string | null, language?: string, contextTerms?: string,
 *   attendees?: Array<{ email?: string, displayName?: string | null, responseStatus?: string | null, resource?: boolean }>,
 *   meetingStart?: string | Date | null, extraRecordings?: number }} opts `accessCtx`: the
 *   caller's access context, for a dedup hit it must be able to read; `userId`: Bee Flow user who owns
 *   the note; `session`: req.session OR vault pseudo-session; `orgId`: org id (model-tier + EU
 *   resolution); `conferenceRecordName`: `conferenceRecords/{record}` (dedup key); `driveFileId`: Drive
 *   file id of the recording MP4; `meetingCode`: typeable meeting code (`abc-defg-hij`); `title`:
 *   calendar event title (titleHint); `language`: BCP-47-ish lang code (default 'nl'); `contextTerms`:
 *   bias terms for the transcriber; `attendees`: calendar attendees ({email, displayName}); `meetingStart`:
 *   when the meeting took place (anchors relative deadlines); `extraRecordings`: other recordings of this
 *   conference the note does not cover
 * @returns {Promise<{ id: string, title?: string | null, dedup?: boolean, sourceUri?: string }>} the saved-note payload (+ `dedup`)
 */
async function ingestGmeetRecording(opts) {
    const {
        userId, session, orgId = null,
        conferenceRecordName, driveFileId, meetingCode = null,
        title = null, language = 'nl', contextTerms = '',
        attendees: allAttendees = [], meetingStart = null, extraRecordings = 0,
    } = opts || {};
    // Rooms are no participants, and an invitee who declined was not there:
    // neither gets the note shared nor becomes a speaker candidate.
    const attendees = (Array.isArray(allAttendees) ? allAttendees : [])
        .filter((a) => a && a.resource !== true && String(a.responseStatus || '').toLowerCase() !== 'declined');

    if (!userId) throw new IngestError('userId is required', { code: 'failed', status: 400 });
    if (!conferenceRecordName || typeof conferenceRecordName !== 'string') {
        throw new IngestError('conferenceRecordName is required', { code: 'failed', status: 400 });
    }
    if (!driveFileId || typeof driveFileId !== 'string') {
        throw new IngestError('driveFileId is required', { code: 'failed', status: 400 });
    }

    const sourceUri = `gmeet://${orgId || `user:${userId}`}/${conferenceRecordName}`;

    // Cheap pre-check so the same conference isn't downloaded + transcribed twice.
    const existing = await transcriptionStore.getTranscriptionBySourceUri(sourceUri);
    if (existing) {
        await assertDedupHitReadable(existing, userId, opts.accessCtx);
        return { id: existing.id, title: existing.title, dedup: true, sourceUri };
    }

    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    // See ingestNextcloudRecording: a millisecond stamp + user id is not unique,
    // and the two ingest pipelines share this one directory — a collision made
    // one run delete the other's download mid-pipeline.
    const stem = path.join(uploadsDir, `${Date.now()}-${crypto.randomUUID()}-${userId}`);
    const videoPath = `${stem}.mp4`;
    const audioPath = `${stem}.m4a`;

    // ── Download from Drive + extract audio (video never kept) ──
    let driveName = null;
    try {
        try {
            const meta = await downloadRecordingToFile(session, driveFileId, videoPath);
            driveName = meta?.name || null;
        } catch (err) {
            // Classified Drive errors (no_drive_access / recording_too_large /
            // download_failed) propagate untouched.
            if (err?.code) throw err;
            throw new IngestError(`Recording download failed: ${err.message}`, { code: 'download_failed', status: 502 });
        }

        try {
            await extractAudioTrack(videoPath, audioPath);
        } catch (err) {
            safeUnlink(audioPath);
            throw new IngestError(`Audio extraction failed: ${err.message}`, { code: 'failed', status: 500 });
        }

        // Reject oversized audio up front (classified, not a timeout).
        try {
            const { size } = fs.statSync(audioPath);
            if (size > MAX_RECORDING_BYTES) {
                safeUnlink(audioPath);
                throw new IngestError('Recording exceeds the 500 MB limit.', { code: 'recording_too_large', status: 413 });
            }
        } catch (err) {
            if (err instanceof IngestError) throw err;
            // statSync failing means extraction produced no readable file —
            // swallowing it would let the pipeline run on a missing path and
            // fail much later with an unclassified error.
            safeUnlink(audioPath);
            throw new IngestError(`Audio extraction produced no readable file: ${err.message}`, { code: 'failed', status: 500 });
        }
    } finally {
        safeUnlink(videoPath);
    }

    // Real attendee roster so the model maps speaker_0/1/2 to the actual
    // participants: calendar attendee names merged with the conference's
    // participant list (only the latter sees signed-out/phone participants).
    const participantNames = await resolveRoster(session, conferenceRecordName, attendees);

    // Attendees in the owner's organisation who also connected Google on this
    // instance get read access.
    const sharedWith = await resolveSharedWith(userId, orgId, attendees);

    // ── Transcribe → diarize → summarize → persist (shared core) ──
    const baseName = driveName ? driveName.replace(/\.[^/.]+$/, '') : '';
    return ingestLocalRecording({
        userId, orgId, filePath: audioPath,
        fileName: baseName ? `${baseName}.m4a` : path.basename(audioPath),
        language,
        contextTerms, titleHint: title,
        participantNames, source: 'gmeet', sourceUri,
        extraStoreFields: { meetMeetingCode: meetingCode, sharedWith },
        // The core checks the dedup key again just before it saves.
        accessCtx: opts.accessCtx,
        meetingDate: meetingStart,
        extraRecordings: Number(extraRecordings) || 0,
    });
}

/**
 * Display-name roster for diarization anchoring. `listParticipantNames` is
 * best-effort by contract ([] on any API error), so this never throws.
 * @param {import('./gmeetArtifacts').GoogleSession} session
 * @param {string} conferenceRecordName
 * @param {Array<{ email?: string, displayName?: string | null }>} attendees
 */
async function resolveRoster(session, conferenceRecordName, attendees) {
    /** @type {string[]} */
    const names = [];
    for (const a of Array.isArray(attendees) ? attendees : []) {
        const name = String(a?.displayName || '').trim();
        if (name && !names.includes(name)) names.push(name);
    }
    const fromConference = await listParticipantNames(session, conferenceRecordName);
    for (const name of fromConference) {
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

/**
 * Map calendar attendee emails to Bee Flow users who connected the same
 * Google account (the connector stores each user's Google email under
 * `google_workspace_email_user_<userId>`), so attendees on this instance can
 * see the note without a manual share. There is no reverse (email → user)
 * index for those configs, so batch-read the per-user keys in one SELECT and
 * invert. ONLY users in the owner's organisation, like the Teams import: an
 * external guest who happens to have an account in another tenant of this
 * instance must not get another organisation's meeting in their library.
 * No organisation, no share. Every member who connected an attendee's
 * address gets it (not an arbitrary first one). Excludes the owner, capped at
 * MAX_SHARED_WITH. Best-effort: [] on any error.
 * @param {string} ownerId
 * @param {string | null} orgId
 * @param {Array<{ email?: string, displayName?: string | null }>} attendees
 */
async function resolveSharedWith(ownerId, orgId, attendees) {
    if (!orgId) return [];
    try {
        /** @type {string[]} */
        const emails = [];
        for (const a of Array.isArray(attendees) ? attendees : []) {
            const email = String(a?.email || '').trim().toLowerCase();
            if (email && !emails.includes(email)) emails.push(email);
        }
        if (!emails.length) return [];

        const { getAllUsers } = require('../../stores/userStore');
        const configStore = require('../../stores/configStore');
        const users = (await getAllUsers()).filter((u) => u?.organizationId && String(u.organizationId) === String(orgId));
        if (!users.length) return [];
        /** @type {Record<string, unknown>} */
        const configs = await configStore.getConfigsByKeys(users.map(u => `google_workspace_email_user_${u.id}`));

        /** @type {Map<string, string[]>} */
        const usersByEmail = new Map();
        for (const u of users) {
            const email = String(configs[`google_workspace_email_user_${u.id}`] || '').trim().toLowerCase();
            if (!email) continue;
            usersByEmail.set(email, [...(usersByEmail.get(email) || []), u.id]);
        }

        /** @type {string[]} */
        const ids = [];
        for (const email of emails) {
            for (const uid of usersByEmail.get(email) || []) {
                if (String(uid) === String(ownerId) || ids.includes(uid)) continue;
                ids.push(uid);
                if (ids.length >= MAX_SHARED_WITH) return ids;
            }
        }
        return ids;
    } catch (err) {
        log.warn(`[IngestGmeetRecording] sharedWith resolution failed: ${err.message}`);
        return [];
    }
}

/** @param {string} p */
function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) { ignoreGone('meetingNotes/ingestGmeetRecording:unlinkTemp', _); } }

module.exports = {
    ingestGmeetRecording,
    IngestError,
};
