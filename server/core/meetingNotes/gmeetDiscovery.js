// @typecheck strict
/**
 * The discovery half of a Google Meet import job (gmeetAutoImport.js): who may
 * still import, space -> conference record -> generated recording, the org
 * claim on a conference, and the attendees of the calendar event. Every Google
 * lookup before the download lives here; the ingest itself stays in
 * gmeetAutoImport.processJobInline.
 */

const gmeetImportStore = require('../../stores/gmeetImportStore');
const { listRecentlyEndedMeetMeetings } = require('./gmeetCalendar');
const { getSpaceByMeetingCode, findConferenceRecord, findGeneratedRecording } = require('./gmeetArtifacts');
const log = require('../../telemetry/log');
const { codedError, backoffMsFor, meetingEndMs } = require('./importJobKit');
const { fallback: fallbackSwallowed } = require('../../utils/bestEffort');

/** @typedef {import('../../stores/gmeetImportStore').GmeetJob} GmeetJob */
/** @typedef {{ accessToken?: string, refreshToken?: string }} GoogleSession  a live web session or the vault shim */

// No conference record at all 48h past the end: the meeting never happened on
// Meet (or under a different code) — terminal no_conference.
const NO_CONFERENCE_DEADLINE_MS = 48 * 3600_000;

/**
 * May this job's owner still have a meeting imported? Checked again at claim
 * time, not only at discovery: a job can wait a day or two for its recording,
 * and an account suspended, or a licence that lapsed, in that window must not
 * still get a note downloaded, transcribed and shared.
 * @param {GmeetJob} job
 * @returns {Promise<string | null>} why not, or null when they may
 */
async function ownerBarredReason(job) {
    // A failed lookup throws: the claim lease retries the job instead of skipping it for good.
    const user = await require('../../stores/userStore').getUser(job.userId);
    if (!user || (user.status ?? 'active') !== 'active') return 'the account is no longer active';
    const { hasCapability } = require('../entitlements/entitlements');
    if (!await hasCapability('meeting_notes', { userId: job.userId, orgId: job.orgId })) return 'Meeting Notes is not licensed for this account';
    return null;
}

/**
 * Best-effort calendar attendee list for a claimed job (used for the speaker
 * roster + the attendee → connected-user sharing map). The job table doesn't
 * carry attendees, so re-read the event from the user's calendar window
 * around the meeting. [] on any failure.
 * @param {GoogleSession} session
 * @param {GmeetJob} job
 */
async function fetchEventAttendees(session, job) {
    if (!job.calendarEventId) return [];
    try {
        const startMs = job.meetingStart ? new Date(job.meetingStart).getTime() : meetingEndMs(job);
        const hours = Math.min(Math.max(Math.ceil((Date.now() - startMs) / 3600_000) + 1, 1), 168);
        const meetings = await listRecentlyEndedMeetMeetings({ session, lookbackHours: hours, graceMinutes: 0 });
        return meetings.find((/** @type {{ eventId?: string, attendees?: Array<{ email?: string, displayName?: string | null, self?: boolean }> }} */ m) => m.eventId === job.calendarEventId)?.attendees || [];
    } catch (err) {
        log.warn(`[GmeetAutoImport] attendee lookup failed for job ${job.id}: ${/** @type {Error} */ (err).message}`);
        return [];
    }
}

// No conference record (or even no space) yet: retry with backoff until the
// 48h post-end deadline, then freeze as no_conference.
/**
 * A job that is not ready yet: it stays claimable.
 * @typedef {{ pending: true, status: string, transcription?: undefined }} GmeetPending
 */
/**
 * A finished import: the note (made here, or by an org sibling).
 * @typedef {{ pending?: false, transcription: unknown }} GmeetImported
 */
/**
 * @param {GmeetJob} job
 * @param {string | null} [spaceName]
 * @returns {Promise<GmeetPending>}
 */
async function awaitConference(job, spaceName = null) {
    if (Date.now() > meetingEndMs(job) + NO_CONFERENCE_DEADLINE_MS) {
        await gmeetImportStore.failJob(job.id, {
            errorCode: 'no_conference', terminal: true,
            lastError: 'No Meet conference record appeared for this meeting',
        });
        throw codedError('No Meet conference was found for this meeting', 'no_conference');
    }
    if (spaceName && spaceName !== job.spaceName) {
        await gmeetImportStore.updateJob(job.id, { spaceName });
    }
    await gmeetImportStore.failJob(job.id, {
        terminal: false, status: 'pending',
        backoffMs: backoffMsFor(job.attempts),
    });
    return { pending: true, status: 'pending' };
}

/**
 * The (org_id, conference_record) claim index rejected the attach — another
 * attendee's job in the same org owns this conference. Freeze quietly
 * (organizer-first seeding makes the organizer's job win the race) and
 * surface the sibling's note when it already exists.
 * @param {GmeetJob} job
 * @param {string} conferenceRecordName
 * @param {import('../../stores/transcription/acl').ReadAclCtx} [accessCtx]
 * @returns {Promise<GmeetPending | GmeetImported>}
 */
async function resolveDuplicate(job, conferenceRecordName, accessCtx = undefined) {
    await gmeetImportStore.updateJob(job.id, { status: 'duplicate', errorCode: null });
    const sourceUri = `gmeet://${job.orgId || `user:${job.userId}`}/${conferenceRecordName}`;
    const transcriptionStore = require('../../stores/transcriptionStore');
    const existing = await transcriptionStore
        .getTranscriptionBySourceUri(sourceUri).catch((e) => fallbackSwallowed('core/meetingNotes/gmeetDiscovery:resolveDuplicate', e, null));
    if (existing) {
        // The sibling's note is only this user's note when they may read it.
        // Linking it regardless sent them to a note that answers 404; the
        // classified code tells them to ask for it to be shared.
        const readable = existing.user_id === job.userId
            || await transcriptionStore.canReadTranscription(existing.id, job.userId, accessCtx || {});
        if (!readable) {
            const message = 'This recording has already been imported by someone else. Ask them to share the meeting note with you.';
            await gmeetImportStore.failJob(job.id, { errorCode: 'already_imported', terminal: true, lastError: message });
            throw codedError(message, 'already_imported');
        }
        await gmeetImportStore.updateJob(job.id, { transcriptionId: existing.id });
        return { transcription: existing };
    }
    return { pending: true, status: 'duplicate' };
}

/**
 * A Google API failure that means the credential does not work any more (a revoked
 * or expired grant): a reconnect, not a retry.
 * @param {unknown} err
 */
function isAuthFailure(err) {
    const e = /** @type {{ status?: unknown, code?: unknown, message?: unknown, response?: { status?: unknown, data?: { error?: unknown } } } | null} */ (err);
    const status = Number(e?.status || e?.response?.status || e?.code) || 0;
    const text = `${e?.message || ''} ${e?.response?.data?.error || ''}`;
    return status === 401 || /invalid_grant/i.test(text);
}

/**
 * The discovery half of a job: space -> conference record (claimed for the
 * org) -> generated recording. Every Google call is here, so one catch in
 * processJobInline records a failure on the job.
 * @param {GmeetJob} job
 * @param {GoogleSession} session
 * @returns {Promise<{ next: 'await', spaceName?: string | null } | { next: 'duplicate', record: string }
 *   | { next: 'ready', conferenceRecordName: string, recording: { driveFileId?: string | null, recordingName?: string | null,
 *       extraRecordings?: number, pendingRecordings?: number, none?: boolean, notReady?: boolean } }>}
 */
async function discoverArtifacts(job, session) {
    let spaceName = job.spaceName;
    let conferenceRecordName = job.conferenceRecord;

    if (!conferenceRecordName) {
        if (!spaceName) {
            const space = await getSpaceByMeetingCode(session, job.meetingCode);
            spaceName = space?.name || null;
            if (!spaceName) return { next: 'await' };
        }
        const record = await findConferenceRecord(session, {
            spaceName,
            meetingStart: job.meetingStart ?? undefined,
            meetingEnd: job.meetingEnd ?? undefined,
        });
        if (!record?.name) return { next: 'await', spaceName };

        const attached = await gmeetImportStore.attachConferenceRecord(job.id, {
            spaceName, conferenceRecord: record.name,
        });
        if (attached && attached.duplicate) return { next: 'duplicate', record: record.name };
        conferenceRecordName = record.name;
    }
    if (!conferenceRecordName) return { next: 'await', spaceName };

    const recording = await findGeneratedRecording(session, conferenceRecordName);
    return { next: 'ready', conferenceRecordName, recording };
}

module.exports = {
    NO_CONFERENCE_DEADLINE_MS, fetchEventAttendees, awaitConference, resolveDuplicate, isAuthFailure, discoverArtifacts, ownerBarredReason,
};
