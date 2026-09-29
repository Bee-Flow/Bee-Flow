// @typecheck
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
const log = require('../../telemetry/log');

// Hard ceiling — matches the manual-upload multer limit. Applied to the
// extracted AUDIO, not the downloaded video (see module doc).
const MAX_RECORDING_BYTES = 500 * 1024 * 1024;

// Auto-sharing never grows unbounded (webinar-sized attendee lists).
const MAX_SHARED_WITH = 50;

const uploadsDir = path.resolve(__dirname, '../../data/uploads/audio');

/**
 * @param {object} opts
 * @param {object} [opts.accessCtx]        the caller's access context, for a dedup hit it must be able to read
 * @param {string} opts.userId               Bee Flow user who owns the note
 * @param {object} opts.session              req.session OR vault pseudo-session
 * @param {string} [opts.orgId]              org id (model-tier + EU resolution)
 * @param {string} opts.conferenceRecordName `conferenceRecords/{record}` (dedup key)
 * @param {string} opts.driveFileId          Drive file id of the recording MP4
 * @param {string} [opts.meetingCode]        typeable meeting code (`abc-defg-hij`)
 * @param {string} [opts.title]              calendar event title (titleHint)
 * @param {string} [opts.language]           BCP-47-ish lang code (default 'nl')
 * @param {string} [opts.contextTerms]       bias terms for the transcriber
 * @param {object[]} [opts.attendees]        calendar attendees ({email, displayName})
 * @returns {Promise<object>} the saved-note payload (+ `dedup`)
 */
async function ingestGmeetRecording(opts) {
    const {
        userId, session, orgId = null,
        conferenceRecordName, driveFileId, meetingCode = null,
        title = null, language = 'nl', contextTerms = '',
        attendees = [],
    } = opts || {};

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
            // swallowing it used to let the pipeline run on a missing path and
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

    // Attendees who also connected Google on this instance get read access.
    const sharedWith = await resolveSharedWith(userId, attendees);

    // ── Transcribe → diarize → summarize → persist (shared core) ──
    const baseName = driveName ? driveName.replace(/\.[^/.]+$/, '') : '';
    return ingestLocalRecording({
        userId, orgId, filePath: audioPath,
        fileName: baseName ? `${baseName}.m4a` : path.basename(audioPath),
        language,
        provider: 'whisperx', // pinned for gmeet (owner decision)
        contextTerms, titleHint: title,
        participantNames, source: 'gmeet', sourceUri,
        extraStoreFields: { meetMeetingCode: meetingCode, sharedWith },
    });
}

/**
 * Display-name roster for diarization anchoring. `listParticipantNames` is
 * best-effort by contract ([] on any API error), so this never throws.
 */
async function resolveRoster(session, conferenceRecordName, attendees) {
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
 * invert. Excludes the owner, capped at MAX_SHARED_WITH. Best-effort: [] on
 * any error.
 */
async function resolveSharedWith(ownerId, attendees) {
    try {
        const emails = [];
        for (const a of Array.isArray(attendees) ? attendees : []) {
            const email = String(a?.email || '').trim().toLowerCase();
            if (email && !emails.includes(email)) emails.push(email);
        }
        if (!emails.length) return [];

        const { getAllUsers } = require('../../stores/userStore');
        const configStore = require('../../stores/configStore');
        const users = await getAllUsers();
        const configs = await configStore.getConfigsByKeys(users.map(u => `google_workspace_email_user_${u.id}`));

        const userByEmail = new Map();
        for (const u of users) {
            const email = String(configs[`google_workspace_email_user_${u.id}`] || '').trim().toLowerCase();
            if (email && !userByEmail.has(email)) userByEmail.set(email, u.id);
        }

        const ids = [];
        for (const email of emails) {
            const uid = userByEmail.get(email);
            if (!uid || String(uid) === String(ownerId) || ids.includes(uid)) continue;
            ids.push(uid);
            if (ids.length >= MAX_SHARED_WITH) break;
        }
        return ids;
    } catch (err) {
        log.warn(`[IngestGmeetRecording] sharedWith resolution failed: ${err.message}`);
        return [];
    }
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

module.exports = {
    ingestGmeetRecording,
    IngestError,
};
