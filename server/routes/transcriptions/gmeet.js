/**
 * Transcriptions — Google Meet meetings & imports.
 *
 * GET   /gmeet-meetings          — upcoming calendar-linked Meet meetings
 * PATCH /gmeet-meetings/:eventId — per-meeting import toggle
 * GET   /gmeet-imports           — recent import jobs (failure UX)
 * GET   /gmeet-recordings        — recently ended meetings + recording state
 * POST  /from-gmeet              — manual import of a finished recording
 */
// @typecheck
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { resolveUserOrgFromReq, resolveAccessContext } = require('./shared');
const { HttpError } = require('../../core/http/errors');

// ── Google Meet meetings (calendar-linked) ───────────────
//
// Mirror of the Talk block above for Google Meet: the Upcoming view lists the
// user's calendar Meet meetings with per-meeting import toggles, recent import
// jobs feed the failure UX, and manual import pulls a finished recording
// through the gmeet ingest pipeline. Auth resolves the live Google session
// first, else a session shim from the encrypted vault (Microsoft/Nextcloud-SSO
// users who connected Google via the connector).

// Stable failure codes shared with the UI → HTTP status for /from-gmeet.
// needs_reauth is a 409, not a 401: the web client reloads the whole page on
// any 401 from /api (a lost login session), which a Google grant that needs
// renewing is not. Same as the Teams routes.
/** @type {Record<string, number>} */
const GMEET_ERROR_STATUS = {
    not_connected: 400,
    needs_reauth: 409,
    needs_meet_scopes: 403,
    no_conference: 404,
    no_recording: 404,
    no_drive_access: 403,
    recording_too_large: 413,
    unsupported_edition: 400,
    no_calendar_event: 404,
    // A colleague's note of the same conference this user may not read.
    already_imported: 409,
    // The workspace engine is not on the organisation's allow-list.
    provider_not_allowed: 403,
};

const { gmeetError, resolveGmeetSession, requireMeetAccess } = require('../../core/meetingNotes/gmeetSession');

const { validate } = require('../../core/http/validate');
const { worded, bodyOf, bool, NO_QUERY } = require('./schemas');
const { fallback: fallbackSwallowed } = require('../../utils/bestEffort');
const { occurrenceNoteId, noteStillExists, configureMeetAutoRecording, isGrantGone, unlessGrantGone } = require('./gmeetHelpers');

// ── Wat de Meet-routes mogen dragen ─────────────────────────────────
//
// `record` is een ECHTE boolean, om dezelfde reden als op de Talk-kant:
// de voorkeur werd geschreven als `record: !!record`, dus `{"record":"false"}`
// zette de automatische opname AAN voor een vergadering waarvan iemand hem
// net had uitgezet, en een verkeerd gespelde sleutel zette hem uit.
const RECORD_TEXT = 'record is true of false.';
const GmeetPrefBody = bodyOf({
    record: bool(RECORD_TEXT),
    // De code van de vergadering; met `applyToSeries` geldt de voorkeur voor
    // de hele serie in plaats van deze ene keer.
    meetingCode: worded('meetingCode is de code van een Meet-vergadering.').trim().min(1).nullish(),
    applyToSeries: bool('applyToSeries is true of false.').optional(),
    organizerSelf: bool('organizerSelf is true of false.').optional(),
});

const FromGmeetBody = bodyOf({
    event_id: worded('event_id is het id van een agendapunt.').trim().min(1).optional(),
    meeting_code: worded('meeting_code is de code van een Meet-vergadering.').trim().min(1).optional(),
    meet_link: worded('meet_link is een Meet-link.').trim().min(1).optional(),
    // Was set without any check and carried through into the transcription: a misspelled key let an English recording be transcribed in the default language, and that cannot be seen from the answer.
    language: worded('language is een taalcode.').trim().min(1).optional(),
    title: worded('Een titel is tekst.').optional(),
    context_terms: worded('context_terms is tekst.').optional(),
});

router.get('/gmeet-meetings', requireAuth, validate({ query: NO_QUERY }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const userId = req.session.user.id;
    const userOrgId = await resolveUserOrgFromReq(req);
    const { resolveGmeetNotesSettings } = require('../../core/meetingNotes/gmeetNotesSettings');
    const settings = await resolveGmeetNotesSettings({ orgId: userOrgId, userId });
    const { session, connection } = await resolveGmeetSession(req);

    // Not connected / missing Meet scopes is a first-run state, not an
    // error — the UI renders connect/reconnect CTAs from `connection`.
    if (!session || !connection.meetScopesGranted) {
        return res.json({ connection, autoImport: settings.autoImport, count: 0, meetings: [] });
    }

    const { listUpcomingMeetMeetings } = require('../../core/meetingNotes/gmeetCalendar');
    const meetings = await unlessGrantGone(() => listUpcomingMeetMeetings({ session, windowHours: 48 }));
    // Google refused the grant: the reconnect state, as the Teams route answers it.
    if (!meetings) return res.json({ connection: { ...connection, needsReauth: true }, autoImport: settings.autoImport, count: 0, meetings: [] });

    // The per-meeting choice comes from meeting_prefs (M5). `excluded` is the EFFECTIVE state of the switch in the Scheduled list, so including the 1-on-1 default; the global autoImport switch deliberately does not count in there (fallback: true) — it is already in the status chip.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'gmeet', userId, orgId: userOrgId });

    // The import jobs of these calendar events (one read for the whole list).
    const { listRecentJobsForUser } = require('../../stores/gmeetImportStore');
    const jobs = await listRecentJobsForUser(userId, 7).catch((e) => fallbackSwallowed('routes/transcriptions/gmeet:jobs', e, []));

    const out = [];
    for (const m of meetings) {
        const ids = meetingPrefs.gmeetIds({ eventId: m.eventId, meetingCode: m.meetingCode });
        const decision = prefs.decide({
            ids,
            participantCount: meetingPrefs.participantCountOf(m),
            fallback: true,
        });
        // Zie de Talk-variant: de tags van de AFSPRAAK, read-only op het scherm.
        const tags = prefs.tagsFor(ids);
        const excluded = !decision.record;
        // With Meet, the calendar is the ONLY source for the participant count — there is no live count as with Talk, because nothing is started here but harvested. The outcome here is therefore always decided, and the route says so explicitly: the screen may not show "we are still looking" for a provider that is no longer going to look.
        const recordDecided = true;
        const organizerSelf = m.organizerSelf === true;
        const importedNoteId = await occurrenceNoteId(m, userId, { jobs });

        /** @type {string} */
        let status;
        if (importedNoteId) status = 'imported';
        // Under the default scope only meetings the user organises are
        // imported (gmeetAutoImport skips the rest): a colleague's meeting
        // must not say "Record in Meet, it will be imported afterwards".
        else if (settings.importScope !== 'calendar' && !organizerSelf) status = 'not_organizer';
        else if (excluded) status = 'excluded';
        else if (settings.autoImport && connection.meetScopesGranted) status = 'will_import';
        else status = 'upcoming';

        out.push({
            ...m,
            excluded,
            tags,
            recordReason: decision.reason,
            recordDecided,
            organizerSelf,
            // Recording is a Meet host control — for meetings the user does
            // not organize we can only harvest what the host recorded.
            recordingControlledByHost: !organizerSelf,
            importedNoteId,
            status,
        });
    }

    res.json({
        connection,
        autoImport: settings.autoImport,
        importScope: settings.importScope === 'calendar' ? 'calendar' : 'organizer',
        // The footer line must be able to say that THIS button can also switch on Meet's OWN auto-recording — and Meet always announces an ongoing recording to all participants. Without this field the sentence ended on "They are not notified" while the button beneath it could cause exactly that. `hasSettingsScope` is already in `connection`.
        autoRecordConfig: settings.autoRecordConfig === true,
        count: out.length,
        meetings: out,
    });
});

// Toggle a single Meet meeting's auto-import on/off (writes the user's
// exclusions; `applyToSeries` also toggles the meeting code → whole series).
// For a meeting the user organizes, best-effort keep Meet's own
// auto-recording in step with the choice (configureMeetAutoRecording) — the
// outcome is reported in `autoRecordingConfig` and never fails the PATCH.
router.patch('/gmeet-meetings/:eventId', requireAuth, validate({ body: GmeetPrefBody, query: NO_QUERY }), async (/** @type {import('express').Request<{ eventId: string }, any, import('zod').infer<typeof GmeetPrefBody>, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const userId = req.session.user.id;
    const eventId = req.params.eventId;
    const { record, meetingCode, applyToSeries, organizerSelf } = req.body;
    // Writes the preference of THIS user (meeting_prefs); another participant in the same meeting keeps their own row. `applyToSeries` also sets it on the meetingCode — the whole series.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    await meetingPrefs.setRecord({
        provider: 'gmeet',
        ids: meetingPrefs.gmeetIds({
            eventId,
            meetingCode: applyToSeries ? (meetingCode || null) : null,
        }),
        userId,
        record,
    });

    // What applies AFTER the write, not what was asked. One FALSE wins — an org-wide row, or the series row on the meetingCode while you switched one occurrence on. Without this, the route answered `record: true`, the row jumped to "Record", and at the next load it stood on "Skip" again without the screen having explained anything.
    const patchOrgId = await resolveUserOrgFromReq(req);
    const after = await meetingPrefs.loadMeetingPrefs({ provider: 'gmeet', userId, orgId: patchOrgId });
    const opinion = after.opinionFor(meetingPrefs.gmeetIds({ eventId, meetingCode: meetingCode || null }));
    const effectiveRecord = opinion === true;

    const autoRecordingConfig = meetingCode
        ? await configureMeetAutoRecording(req, { userId, eventId, meetingCode, record: !!record, effectiveRecord, applyToSeries: !!applyToSeries, organizerSelf })
        : 'skipped';

    res.json({
        ok: true, eventId,
        record: !!record,
        effectiveRecord,
        overridden: effectiveRecord !== !!record,
        autoRecordingConfig,
    });
});

// Recent import jobs — failure-UX feed + manual-import panel state.
router.get('/gmeet-imports', requireAuth, validate({ query: NO_QUERY }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const userId = req.session.user.id;
    const { listRecentJobsForUser } = require('../../stores/gmeetImportStore');
    const jobs = await listRecentJobsForUser(userId, 7);
    res.json({
        items: jobs.map(j => ({
            id: j.id,
            title: j.title,
            meetingCode: j.meetingCode,
            meetingStart: j.meetingStart,
            meetingEnd: j.meetingEnd,
            status: j.status,
            errorCode: j.errorCode,
            transcriptionId: j.transcriptionId,
        })),
    });
});

// Manual-import listing: recently ended Meet meetings with their recording
// state. Capped at the 10 most recent — each row costs 2-3 Meet API calls.
router.get('/gmeet-recordings', requireAuth, validate({ query: NO_QUERY }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const userId = req.session.user.id;
    const { session, connection } = await resolveGmeetSession(req);
    if (!session || !connection.meetScopesGranted) {
        return res.json({ connection, items: [] });
    }

    const { listRecentlyEndedMeetMeetings } = require('../../core/meetingNotes/gmeetCalendar');
    const { getSpaceByMeetingCode, findConferenceRecord, findGeneratedRecording } = require('../../core/meetingNotes/gmeetArtifacts');
    const meetings = await unlessGrantGone(() => listRecentlyEndedMeetMeetings({ session, lookbackHours: 24 * 7 }));
    if (!meetings) return res.json({ connection: { ...connection, needsReauth: true }, items: [] });
    meetings.sort((a, b) => new Date(b.end || 0).getTime() - new Date(a.end || 0).getTime());

    const { listRecentJobsForUser } = require('../../stores/gmeetImportStore');
    const jobs = await listRecentJobsForUser(userId, 7).catch((e) => fallbackSwallowed('routes/transcriptions/gmeet:jobs#2', e, []));
    /**
     * The start of the next occurrence on the same code, if listed: a note
     * created after it belongs to that one.
     * @param {{ meetingCode?: string, start?: string | null }} m
     */
    const nextStartOnCode = (m) => meetings
        .filter((o) => o.meetingCode === m.meetingCode && o.start && m.start && new Date(o.start).getTime() > new Date(m.start).getTime())
        .map((o) => /** @type {string} */ (o.start))
        .sort()[0] || null;

    const items = [];
    for (const m of meetings.slice(0, 10)) {
        let recordingState = 'none';
        try {
            const space = await getSpaceByMeetingCode(session, m.meetingCode);
            const record = space?.name
                ? await findConferenceRecord(session, { spaceName: space.name, meetingStart: m.start, meetingEnd: m.end })
                : null;
            if (record) {
                const rec = await findGeneratedRecording(session, record.name);
                if ('recordingName' in rec && rec.recordingName) recordingState = 'available';
                else if (rec.notReady) recordingState = 'processing';
            }
        } catch (err) { fallbackSwallowed('routes/transcriptions/gmeet:anon#2', err); /* best-effort — leave 'none' */ }
        const importedNoteId = await occurrenceNoteId(m, userId, { jobs, until: nextStartOnCode(m) });
        items.push({
            eventId: m.eventId,
            meetingCode: m.meetingCode,
            title: m.title,
            start: m.start,
            end: m.end,
            recordingState,
            importedNoteId,
        });
    }

    res.json({ connection, items });
});

/**
 * The import itself, run after the 202. Access is checked again here: the
 * session may have changed since the request was accepted. Shared with the
 * background poller (processJobInline), so manual and auto imports behave
 * identically (dedup, artifact waits, failure classification).
 * `manual`: the user is watching, so a failure is final and keeps its code.
 * The run gets the job as reset (requestedByUser, no previous outcome).
 * `accessCtx`: a dedup hit is handed over only when this user may read it.
 * @param {{ req: import('express').Request<any, any, any, any>, job: import('../../stores/gmeetImportStore').GmeetJob, language: string | null, contextTerms: string }} args
 */
async function runGmeetImport({ req, job, language, contextTerms }) {
    const { session } = await requireMeetAccess(req);
    const { processJobInline } = require('../../core/meetingNotes/gmeetAutoImport');
    await processJobInline({
        job: { ...job, status: 'pending', errorCode: null, lastError: null, requestedByUser: true },
        session, language, contextTerms,
        manual: true, accessCtx: await resolveAccessContext(req),
    });
}

// Manual import of a finished Meet recording. Minutes of Drive download and
// transcription do not fit in a proxied request (ingress 504), so this seeds
// the job and answers 202 { jobId, status } at once; the shared ingest runs in
// the background and the client polls GET /gmeet-imports. Classified 4xx
// `code`s for everything that can be refused up front.
router.post('/from-gmeet', requireAuth, validate({ body: FromGmeetBody, query: NO_QUERY }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof FromGmeetBody>, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const userId = req.session.user.id;
    const { event_id, meeting_code, meet_link, language, title, context_terms } = req.body;

    try {
        const userOrgId = await resolveUserOrgFromReq(req);
        const { session } = await requireMeetAccess(req);

        const { extractMeetCode, listRecentlyEndedMeetMeetings } = require('../../core/meetingNotes/gmeetCalendar');
        let meetingCode = extractMeetCode(meet_link || meeting_code);
        let meeting = null;
        let calendarFailed = false;
        // Look up the calendar event so the job carries the title + start/end
        // that conference-record matching needs. The event id the client
        // clicked wins; a code alone picks the LATEST ended occurrence. One
        // `find` over both would pick the oldest occurrence in the 7 days
        // (the list is in start order), so clicking today's stand-up would
        // import last week's.
        try {
            const recent = await listRecentlyEndedMeetMeetings({ session, lookbackHours: 24 * 7 });
            meeting = (event_id && recent.find(m => m.eventId === event_id))
                || (meetingCode && [...recent].reverse().find(m => m.meetingCode === meetingCode))
                || null;
        } catch (err) {
            // A refused refresh is not an outage: the user has to reconnect.
            if (isGrantGone(err)) throw gmeetError('Google access expired — reconnect your Google account', 'needs_reauth');
            calendarFailed = true;
            fallbackSwallowed('routes/transcriptions/gmeet:anon#4', err);
        }
        if (meeting && !meetingCode) meetingCode = meeting.meetingCode;
        if (!meeting && calendarFailed) {
            throw new HttpError(503, 'calendar_unavailable', 'Your Google Calendar could not be read just now. Try again in a moment.');
        }
        if (!meetingCode) {
            const e = gmeetError('Provide a Google Meet link, meeting code or calendar event id of a recently ended meeting', 'bad_request');
            e.status = 400;
            throw e;
        }
        // Without the event there is no start time, and without one the
        // conference record can never be found: such a job would answer 202,
        // sit pending and end as no_conference two days later.
        if (!meeting) {
            const e = gmeetError('No Google Meet meeting with this link ended in your calendar in the last 7 days. Import it from the list of recent meetings.', 'no_calendar_event');
            e.status = 404;
            throw e;
        }

        const { seedJob, listRecentJobsForUser, updateJob } = require('../../stores/gmeetImportStore');
        const eventId = meeting.eventId || event_id || null;

        // Find-or-seed: the poller may already own a row for this meeting.
        const recentJobs = await listRecentJobsForUser(userId, 30);
        let job = recentJobs.find(j => j.calendarEventId === eventId) || null;
        if (!job) {
            job = await seedJob({
                userId,
                orgId: userOrgId,
                calendarEventId: eventId,
                icalUid: meeting.iCalUID || null,
                meetingCode,
                title: title || meeting.title || null,
                meetingStart: meeting.start || null,
                meetingEnd: meeting.end || null,
                preferred: meeting.organizerSelf === true,
            });
            // Unique-index conflict (another job already owns this meeting) —
            // fall back to that row instead of failing the import. Same event
            // only: another occurrence on the code is another meeting.
            if (!job) job = (await listRecentJobsForUser(userId, 30)).find(j => j.calendarEventId === eventId) || null;
        }
        if (!job) throw gmeetError('Could not create an import job for this meeting', 'failed');

        if (job.status === 'ingested' && job.transcriptionId && await noteStillExists(job.transcriptionId, userId)) {
            return res.json({ id: job.transcriptionId, dedup: true });
        }
        // A job seeded while the calendar could not be read carries no times,
        // and could never be matched to its conference: fill them in now.
        if (!job.meetingStart && meeting.start) {
            await updateJob(job.id, { meetingStart: meeting.start, meetingEnd: meeting.end || null });
            job = { ...job, meetingStart: meeting.start, meetingEnd: meeting.end || null };
        }

        const { startBackgroundImport } = require('../../core/meetingNotes/gmeetManualImport');
        const outcome = await startBackgroundImport({
            job, userId, orgId: userOrgId, knownCodes: GMEET_ERROR_STATUS,
            language: language || null, contextTerms: context_terms || null,
            work: () => runGmeetImport({ req, job, language: language || null, contextTerms: context_terms || '' }),
            accept: () => res.status(202).json({ jobId: job.id, status: 'pending' }),
            tooMany: () => Object.assign(gmeetError('Too many meeting imports are running; wait for one to finish', 'too_many_imports'), { status: 429 }),
        });
        if (outcome === 'already_running') res.status(202).json({ jobId: job.id, status: 'pending' });
    } catch (err) {
        const status = err.status || GMEET_ERROR_STATUS[err.code];
        if (!status || status >= 500) throw err; // unclassified: the terminal handler logs it and answers generically
        res.status(status).json({ error: /** @type {Error} */ (err).message, ...(err.code ? { code: err.code } : {}) });
    }
});

module.exports = router;
