// @typecheck strict
/**
 * Helpers of the Google Meet routes (routes/transcriptions/gmeet.js): which
 * note belongs to one occurrence of a meeting, whether an import job's note
 * still exists, and Meet's own auto-recording setting following the user's
 * effective choice.
 */

const log = require('../../telemetry/log');
const transcriptionStore = require('../../stores/transcriptionStore');
const { resolveUserOrgFromReq } = require('./shared');
const { resolveGmeetSession } = require('../../core/meetingNotes/gmeetSession');
const { fallback: fallbackSwallowed } = require('../../utils/bestEffort');

/**
 * The note of ONE occurrence of a Meet meeting, or null.
 *
 * A recurring event and a standing link keep one meeting code, so the note
 * of last week's stand-up matched every later occurrence: the list showed
 * "Note created" (opening the wrong note) and hid Transcribe. The import job
 * of THIS calendar event is the exact answer; the code lookup is limited to
 * notes made from this occurrence's start, and before the next occurrence on
 * the same code starts when that is known.
 * @param {{ eventId?: string | null, meetingCode?: string | null, start?: string | null }} m
 * @param {string} userId
 * @param {{ jobs?: Array<{ calendarEventId?: string | null, transcriptionId?: string | null }>, until?: string | null }} [opts]
 */
async function occurrenceNoteId(m, userId, { jobs = [], until = null } = {}) {
    const job = m.eventId ? jobs.find((j) => j.calendarEventId === m.eventId && j.transcriptionId) : null;
    if (job && await noteStillExists(job.transcriptionId, userId)) return job.transcriptionId;
    if (!m.start) return null;
    try {
        const t = await transcriptionStore.getTranscriptionByMeetMeetingCode(m.meetingCode, userId, { since: m.start });
        if (!t) return null;
        if (until && t.created_at && new Date(t.created_at).getTime() >= new Date(until).getTime()) return null;
        return t.id;
    } catch (err) {
        fallbackSwallowed('routes/transcriptions/gmeet:occurrenceNoteId', err);
        return null;
    }
}

/**
 * Whether the note an import job points at still exists (owner check, never
 * the super-admin shortcut). A deleted note leaves its job 'ingested'.
 * @param {string | null | undefined} transcriptionId
 * @param {string} userId
 */
async function noteStillExists(transcriptionId, userId) {
    if (!transcriptionId) return false;
    try {
        return await transcriptionStore.canReadTranscription(transcriptionId, userId, { orgIds: [], userGroupIds: [], isSuperAdmin: false });
    } catch (err) {
        fallbackSwallowed('routes/transcriptions/gmeet:noteStillExists', err);
        return true;
    }
}

/**
 * Whether a Meet calendar entry is one occurrence of a recurring event (or
 * shares its link with another listed entry). Meet's auto-recording is a
 * setting of the SPACE behind the link, so it applies to every occurrence.
 * @param {{ eventId?: string, meetingCode?: string, recurringEventId?: string | null } | null | undefined} m
 * @param {Array<{ eventId?: string, meetingCode?: string }>} listed
 */
function isSeriesOccurrence(m, listed) {
    if (!m) return false;
    if (m.recurringEventId) return true;
    return listed.some((o) => o.eventId !== m.eventId && o.meetingCode && o.meetingCode === m.meetingCode);
}

/**
 * Switch Meet's auto-recording of the space behind `meetingCode` on or off.
 * @param {Parameters<typeof import('../../core/meetingNotes/gmeetArtifacts').setAutoRecording>[0]} session
 * @param {string} meetingCode
 * @param {boolean} enabled
 * @returns {Promise<string>} 'set' (switched on), 'unset' (switched off), or why it was not changed
 */
async function applyMeetAutoRecording(session, meetingCode, enabled) {
    const { setAutoRecording } = require('../../core/meetingNotes/gmeetArtifacts');
    const result = await setAutoRecording(session, { meetingCode, enabled });
    if (!result.ok) return result.error || 'error';
    return enabled ? 'set' : 'unset';
}

/**
 * Meet's own auto-recording follows the EFFECTIVE choice, both ways, while
 * the settings say Bee Flow manages it (autoRecordConfig): on only when the
 * meeting will really be imported, and off again when the user switches it
 * off (otherwise Meet keeps recording to Drive and announcing it after the
 * user declined). The setting belongs to the Meet SPACE, so to every occurrence on
 * the link: one occurrence of a series reports 'series_only' and leaves it
 * alone. Never throws: the outcome is reported, the PATCH has succeeded.
 * @param {import('express').Request} req
 * @param {{ userId: string, eventId: string, meetingCode: string, record: boolean, effectiveRecord: boolean, applyToSeries: boolean, organizerSelf?: boolean }} choice
 * @returns {Promise<string>} 'set' (switched on), 'unset' (switched off), or why nothing was changed
 */
async function configureMeetAutoRecording(req, { userId, eventId, meetingCode, record, effectiveRecord, applyToSeries, organizerSelf }) {
    try {
        const { resolveGmeetNotesSettings } = require('../../core/meetingNotes/gmeetNotesSettings');
        const settings = await resolveGmeetNotesSettings({ orgId: await resolveUserOrgFromReq(req), userId });
        if (!settings.autoRecordConfig) return 'skipped';
        const { session, connection } = await resolveGmeetSession(req);
        if (!session) return 'skipped';
        const { listUpcomingMeetMeetings } = require('../../core/meetingNotes/gmeetCalendar');
        const listed = await listUpcomingMeetMeetings({ session, windowHours: 48 });
        const match = listed.find(m => m.eventId === eventId) || null;
        const isOrganizer = typeof organizerSelf === 'boolean' ? organizerSelf : match?.organizerSelf === true;
        if (!isOrganizer) return 'not_host';
        if (!connection.hasSettingsScope) return 'no_scope';
        if (!applyToSeries && isSeriesOccurrence(match, listed)) return 'series_only';
        // Switched on, but an org-wide or series opt-out wins: nothing will be
        // imported, so Meet is not armed (and a setting the host chose in Meet
        // is not touched either).
        if (record && !effectiveRecord) return 'overridden';
        return await applyMeetAutoRecording(session, meetingCode, effectiveRecord);
    } catch (err) {
        log.warn('[Transcriptions] gmeet auto-record config failed:', /** @type {Error} */ (err).message);
        return 'error';
    }
}

module.exports = { occurrenceNoteId, noteStillExists, isSeriesOccurrence, configureMeetAutoRecording };
