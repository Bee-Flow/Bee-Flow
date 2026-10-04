/**
 * Transcriptions — Microsoft Teams meetings & imports.
 *
 * GET   /teams-meetings          — upcoming Teams meetings from the Outlook calendar
 * PATCH /teams-meetings/:eventId — per-meeting record/import choice
 * GET   /teams-imports           — recent import jobs (failure UX)
 * GET   /teams-recordings        — recently ended meetings the user organized
 * POST  /from-teams              — manual import of a finished meeting
 *
 * The Teams sibling of transcriptions/gmeet.js. Graph only gives recordings
 * and transcripts to the meeting ORGANIZER under delegated permissions, so
 * every import here is the organizer's; for other meetings the list says so
 * instead of offering a toggle that cannot work.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { worded, bodyOf, bool, NO_QUERY } = require('./schemas');
const { lazyDeps } = require('../../core/meetingNotes/lazyDeps');

/** Collaborators, loaded on first use; tests swap them through `router.init()`. */
const { deps: d, init } = lazyDeps({
    permissions: () => require('../../auth/permissions'),
    shared: () => require('./shared'),
    settings: () => require('../../core/meetingNotes/teamsNotesSettings'),
    calendar: () => require('../../core/meetingNotes/teamsCalendar'),
    artifacts: () => require('../../core/meetingNotes/teamsArtifacts'),
    autoImport: () => require('../../core/meetingNotes/teamsAutoImport'),
    importStore: () => require('../../stores/teamsImportStore'),
    meetingPrefs: () => require('../../stores/meetingPrefsStore'),
    credentialStore: () => require('../../stores/automationCredentialStore'),
    resolveMicrosoftSession: () => require('../../auth/microsoftSessionHydration').resolveMicrosoftSession,
});

/** @type {import('express').RequestHandler} */
const requireAuth = (req, res, next) => d.permissions.requireAuth(req, res, next);
const resolveUserOrgFromReq = (req) => d.shared.resolveUserOrgFromReq(req);
const resolveAccessContext = (req) => d.shared.resolveAccessContext(req);

// Stable failure codes shared with the UI → HTTP status for /from-teams.
const TEAMS_ERROR_STATUS = {
    not_connected: 400,
    needs_reauth: 401,
    needs_teams_scopes: 403,
    not_organizer: 403,
    not_found: 404,
    no_recording: 404,
    recording_too_large: 413,
    transcript_access_disabled: 403,
    speaker_attribution_disabled: 403,
    already_imported: 409,
    empty_transcription: 502,
};

/**
 * The caller's Microsoft session (live SSO session or vault shim) plus the
 * connection block the UI renders its connect/reconnect prompts from.
 */
async function resolveTeamsSession(req) {
    const userId = req.session.user.id;
    let credential = null;
    try {
        credential = await d.credentialStore.getCredential(userId, 'microsoft');
    } catch (_) { /* vault unavailable → session only */ }
    const connection = d.settings.deriveConnectionStatus({ session: req.session, credential });
    let session = null;
    try {
        session = await d.resolveMicrosoftSession(req.session, userId);
    } catch (err) {
        log.warn('[Transcriptions] Microsoft session resolve failed:', err.message);
    }
    return { session, connection };
}

const RECORD_TEXT = 'record is true or false.';
const TeamsPrefBody = bodyOf({
    record: bool(RECORD_TEXT),
    // The Outlook series master; with applyToSeries the choice covers the whole series.
    seriesMasterId: worded('seriesMasterId is the id of an Outlook series.').trim().min(1).nullish(),
    applyToSeries: bool('applyToSeries is true or false.').optional(),
});

const FromTeamsBody = bodyOf({
    event_id: worded('event_id is the id of a calendar event.').trim().min(1),
    language: worded('language is a language code.').trim().min(1).optional(),
    context_terms: worded('context_terms is text.').optional(),
});

router.get('/teams-meetings', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const orgId = await resolveUserOrgFromReq(req);
    const settings = await d.settings.resolveTeamsNotesSettings({ orgId, userId });
    const { session, connection } = await resolveTeamsSession(req);

    // Not connected / missing scopes is a first-run state, not an error.
    if (!session || !connection.teamsScopesGranted) {
        return res.json({ connection, autoImport: settings.autoImport, autoRecordConfig: settings.autoRecordConfig, count: 0, meetings: [] });
    }

    const meetings = await d.calendar.listUpcomingTeamsMeetings({ session, windowHours: 48 });
    const meetingPrefs = d.meetingPrefs;
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'teams', userId, orgId });

    const out = meetings.map((m) => {
        const ids = meetingPrefs.teamsIds({ eventId: m.eventId, seriesMasterId: m.seriesMasterId });
        const decision = prefs.decide({ ids, participantCount: meetingPrefs.participantCountOf(m), fallback: true });
        const excluded = !decision.record;
        let status;
        if (!m.organizerSelf) status = 'organizer_only';
        else if (excluded) status = 'excluded';
        else if (settings.autoImport) status = 'will_import';
        else status = 'upcoming';
        return {
            ...m,
            excluded,
            tags: prefs.tagsFor(ids),
            recordReason: decision.reason,
            recordDecided: true,
            recordingControlledByHost: !m.organizerSelf,
            importedNoteId: null,
            status,
        };
    });

    res.json({
        connection,
        autoImport: settings.autoImport,
        autoRecordConfig: settings.autoRecordConfig,
        count: out.length,
        meetings: out,
    });
});

// Per-meeting choice. Turning it ON for a meeting the user organizes also
// switches on Teams' own "record automatically" when the settings ask for it;
// that outcome is reported in `autoRecordingConfig` and never fails the PATCH.
router.patch('/teams-meetings/:eventId', requireAuth, validate({ body: TeamsPrefBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const { eventId } = req.params;
    const { record, seriesMasterId, applyToSeries } = req.body;
    const orgId = await resolveUserOrgFromReq(req);
    const meetingPrefs = d.meetingPrefs;
    await meetingPrefs.setRecord({
        provider: 'teams',
        ids: meetingPrefs.teamsIds({ eventId, seriesMasterId: applyToSeries ? (seriesMasterId || null) : null }),
        userId,
        record,
    });

    // What holds AFTER the write: an org-wide or series-level FALSE still wins.
    const after = await meetingPrefs.loadMeetingPrefs({ provider: 'teams', userId, orgId });
    const effectiveRecord = after.opinionFor(meetingPrefs.teamsIds({ eventId, seriesMasterId: seriesMasterId || null })) === true;

    let autoRecordingConfig = 'skipped';
    if (record) {
        try {
            const settings = await d.settings.resolveTeamsNotesSettings({ orgId, userId });
            if (settings.autoRecordConfig) {
                const { session, connection } = await resolveTeamsSession(req);
                if (!session) autoRecordingConfig = 'not_connected';
                else if (!connection.hasMeetingWriteScope) autoRecordingConfig = 'needs_teams_scopes';
                else {
                    const match = (await d.calendar.listUpcomingTeamsMeetings({ session, windowHours: 48 })).find(m => m.eventId === eventId);
                    if (!match || !match.organizerSelf) autoRecordingConfig = 'not_organizer';
                    else {
                        const result = await d.artifacts.setRecordAutomatically(session, { joinUrl: match.joinUrl, enabled: true });
                        autoRecordingConfig = result.ok ? 'set' : result.error;
                    }
                }
            }
        } catch (err) {
            log.warn('[Transcriptions] teams auto-record config failed:', err.message);
            autoRecordingConfig = 'error';
        }
    }

    res.json({ ok: true, eventId, record, effectiveRecord, overridden: effectiveRecord !== record, autoRecordingConfig });
});

router.get('/teams-imports', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    const jobs = await d.importStore.listRecentJobsForUser(req.session.user.id, 7);
    res.json({
        items: jobs.map(j => ({
            id: j.id,
            eventId: j.calendarEventId,
            title: j.title,
            meetingStart: j.meetingStart,
            meetingEnd: j.meetingEnd,
            status: j.status,
            errorCode: j.errorCode,
            transcriptionId: j.transcriptionId,
        })),
    });
});

// Manual-import listing: the 10 most recent ended meetings the user
// organized, with whether Teams has a recording or transcript for them.
router.get('/teams-recordings', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const { session, connection } = await resolveTeamsSession(req);
    if (!session || !connection.teamsScopesGranted) return res.json({ connection, items: [] });

    const meetings = (await d.calendar.listRecentlyEndedTeamsMeetings({ session, lookbackHours: 24 * 7 }))
        .filter(m => m.organizerSelf)
        .sort((a, b) => new Date(b.end || 0).getTime() - new Date(a.end || 0).getTime())
        .slice(0, 10);

    const items = [];
    for (const m of meetings) {
        let recordingState = 'none';
        try {
            const meeting = await d.artifacts.getOnlineMeetingByJoinUrl(session, m.joinUrl);
            if (meeting) {
                const artifact = await d.autoImport.findArtifact(session, meeting.id,
                    { meetingStart: m.start, meetingEnd: m.end },
                    { transcriptAllowed: connection.hasTranscriptScope });
                if (artifact) recordingState = artifact.kind === 'recording' ? 'available' : 'transcript_only';
            }
        } catch (_) { /* best-effort — leave 'none' */ }
        const job = await d.importStore.getJobForEvent(userId, m.eventId).catch(() => null);
        items.push({
            eventId: m.eventId,
            title: m.title,
            start: m.start,
            end: m.end,
            recordingState,
            importedNoteId: job?.transcriptionId || null,
        });
    }
    res.json({ connection, items });
});

// Manual import of a finished Teams meeting. 202 { jobId, status } when Teams
// has not finished processing the recording yet; classified 4xx otherwise.
router.post('/from-teams', requireAuth, validate({ body: FromTeamsBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const { event_id, language, context_terms } = req.body;
    req.setTimeout(600000); res.setTimeout(600000);

    const orgId = await resolveUserOrgFromReq(req);
    const { session, connection } = await resolveTeamsSession(req);
    if (!session) {
        throw connection.needsReauth
            ? new HttpError(401, 'needs_reauth', 'Microsoft access expired — reconnect your Microsoft 365 account')
            : new HttpError(400, 'not_connected', 'Microsoft 365 is not connected for this account');
    }
    if (!connection.teamsScopesGranted) {
        throw new HttpError(403, 'needs_teams_scopes', 'Teams meeting access has not been granted — reconnect Microsoft 365 to add it');
    }

    const meeting = (await d.calendar.listRecentlyEndedTeamsMeetings({ session, lookbackHours: 24 * 7, graceMinutes: 0 }))
        .find(m => m.eventId === event_id);
    if (!meeting) throw new HttpError(404, 'not_found', 'No Teams meeting with this id ended in the last 7 days');
    if (!meeting.organizerSelf) throw new HttpError(403, 'not_organizer', 'Only the organizer of a Teams meeting can import it');

    const teamsImportStore = d.importStore;
    const job = await teamsImportStore.getJobForEvent(userId, meeting.eventId)
        || await teamsImportStore.seedJob({
            userId, orgId,
            calendarEventId: meeting.eventId,
            seriesMasterId: meeting.seriesMasterId,
            joinUrl: meeting.joinUrl,
            title: meeting.title,
            meetingStart: meeting.start,
            meetingEnd: meeting.end,
        })
        || await teamsImportStore.getJobForEvent(userId, meeting.eventId);
    if (!job) throw new HttpError(500, 'failed', 'Could not create an import job for this meeting');
    if (job.status === 'ingested' && job.transcriptionId) {
        return res.json({ id: job.transcriptionId, dedup: true });
    }

    let out;
    try {
        out = await d.autoImport.processJobInline({
            job, session, language: language || null, contextTerms: context_terms || '',
            transcriptAllowed: connection.hasTranscriptScope,
            accessCtx: await resolveAccessContext(req),
        });
    } catch (err) {
        const status = TEAMS_ERROR_STATUS[err?.code];
        if (status) throw new HttpError(status, err.code, err.message);
        throw err;
    }
    if (out && out.pending) return res.status(202).json({ jobId: job.id, status: out.status });
    res.json(out.transcription);
});

module.exports = router;
module.exports.init = init;
