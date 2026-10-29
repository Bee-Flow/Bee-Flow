// @typecheck noImplicitAny
/**
 * Transcriptions — Microsoft Teams meetings & imports.
 *
 * GET   /teams-meetings          — upcoming Teams meetings from the Outlook calendar
 * PATCH /teams-meetings/:eventId — per-meeting record/import choice
 * GET   /teams-imports           — recent import jobs (failure UX)
 * GET   /teams-recordings        — recently ended meetings the user organized
 * POST  /from-teams              — manual import of a finished meeting (202, runs in the background)
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
const { fallback: fallbackSwallowed } = require('../../utils/bestEffort');
const { sessionUser } = require('../../core/http/sessionUser');

/** Collaborators, loaded on first use; tests swap them through `router.init()`. */
const { deps: d, init } = lazyDeps({
    permissions: () => require('../../auth/permissions'),
    shared: () => require('./shared'),
    settings: () => require('../../core/meetingNotes/teamsNotesSettings'),
    calendar: () => require('../../core/meetingNotes/teamsCalendar'),
    artifacts: () => require('../../core/meetingNotes/teamsArtifacts'),
    autoImport: () => require('../../core/meetingNotes/teamsAutoImport'),
    importStore: () => require('../../stores/teamsImportStore'),
    importRunner: () => require('../../core/meetingNotes/manualImportRunner'),
    meetingPrefs: () => require('../../stores/meetingPrefsStore'),
    credentialStore: () => require('../../stores/automationCredentialStore'),
    resolveMicrosoftSession: () => require('../../auth/microsoftSessionHydration').resolveMicrosoftSession,
});

/** @type {import('express').RequestHandler} */
const requireAuth = (req, res, next) => d.permissions.requireAuth(req, res, next);
/** @param {import('express').Request} req */
const resolveUserOrgFromReq = (req) => d.shared.resolveUserOrgFromReq(req);
/** @param {import('express').Request} req */
const resolveAccessContext = (req) => d.shared.resolveAccessContext(req);

// Stable failure codes shared with the UI → HTTP status for /from-teams.
/** @type {Record<string, number>} */
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
 * @param {import('express').Request} req
 */
async function resolveTeamsSession(req) {
    const userId = sessionUser(req).id;
    let credential = null;
    try {
        credential = await d.credentialStore.getCredential(userId, 'microsoft');
    } catch (err) { fallbackSwallowed('routes/transcriptions/teams:resolveTeamsSession', err); /* vault unavailable → session only */ }
    const connection = d.settings.deriveConnectionStatus({ session: req.session, credential });
    let session = null;
    try {
        session = await d.resolveMicrosoftSession(req.session, userId);
    } catch (err) {
        log.warn('[Transcriptions] Microsoft session resolve failed:', /** @type {Error} */ (err).message);
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

router.get('/teams-meetings', requireAuth, validate({ query: NO_QUERY }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const userId = sessionUser(req).id;
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
        /** @type {string} */
        let status;
        if (!m.organizerSelf) status = 'organizer_only';
        else if (excluded) status = 'excluded';
        // An explicit "record" mark imports this meeting even with autoImport off.
        else if (settings.autoImport || decision.reason === 'opted_in') status = 'will_import';
        else status = 'upcoming';
        return {
            ...m,
            excluded,
            tags: prefs.tagsFor(ids),
            recordReason: decision.reason,
            recordDecided: true,
            recordingControlledByHost: !m.organizerSelf,
            importedNoteId: /** @type {string | null} */ (null),
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
router.patch('/teams-meetings/:eventId', requireAuth, validate({ body: TeamsPrefBody, query: NO_QUERY }), /** @param {import('express').Request<{ eventId: string }>} req @param {import('express').Response} res */ async (req, res) => {
    const userId = sessionUser(req).id;
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
            log.warn('[Transcriptions] teams auto-record config failed:', /** @type {Error} */ (err).message);
            autoRecordingConfig = 'error';
        }
    }

    res.json({ ok: true, eventId, record, effectiveRecord, overridden: effectiveRecord !== record, autoRecordingConfig });
});

router.get('/teams-imports', requireAuth, validate({ query: NO_QUERY }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const jobs = await d.importStore.listRecentJobsForUser(sessionUser(req).id, 7);
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
// organized, with whether Teams has a recording or transcript for them
// ('available' | 'transcript_only' | 'processing' | 'none').
router.get('/teams-recordings', requireAuth, validate({ query: NO_QUERY }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const userId = sessionUser(req).id;
    const { session, connection } = await resolveTeamsSession(req);
    if (!session || !connection.teamsScopesGranted) return res.json({ connection, items: [] });

    const meetings = (await d.calendar.listRecentlyEndedTeamsMeetings({ session, lookbackHours: 24 * 7 }))
        .filter(m => m.organizerSelf)
        .sort((a, b) => new Date(b.end || 0).getTime() - new Date(a.end || 0).getTime())
        .slice(0, 10);

    /** @type {({ eventId: string; title: string; start: string | null; end: string | null; recordingState: string; importedNoteId: string | null; })[]} */
    const items = [];
    for (const m of meetings) {
        // Teams needs time to process a recording: inside the import deadline an
        // empty answer means "not ready yet", not "was not recorded".
        const endMs = new Date(m.end || 0).getTime();
        const stillProcessing = Number.isFinite(endMs) && Date.now() <= endMs + d.autoImport.NO_RECORDING_DEADLINE_MS;
        let recordingState = stillProcessing ? 'processing' : 'none';
        try {
            const meeting = await d.artifacts.getOnlineMeetingByJoinUrl(session, m.joinUrl);
            // No online meeting for this account: nothing will ever appear.
            if (!meeting) recordingState = 'none';
            else {
                const artifact = await d.autoImport.findArtifact(session, meeting.id,
                    { meetingStart: m.start, meetingEnd: m.end },
                    { transcriptAllowed: connection.hasTranscriptScope });
                if (artifact) recordingState = artifact.kind === 'recording' ? 'available' : 'transcript_only';
            }
        } catch (err) { fallbackSwallowed('routes/transcriptions/teams:anon', err); /* best-effort — keep the default state */ }
        const job = await d.importStore.getJobForEvent(userId, m.eventId).catch((e) => fallbackSwallowed('routes/transcriptions/teams:anon#2', e, null));
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

const INGEST_LEASE_MINUTES = Number(process.env.TEAMS_INGEST_LEASE_MINUTES) || 120;

/**
 * Session + scope gate shared by the request and the background run: the
 * caller's Microsoft session must exist and carry the Teams scopes.
 * @param {import('express').Request} req
 */
async function requireTeamsAccess(req) {
    const { session, connection } = await resolveTeamsSession(req);
    if (!session) {
        throw connection.needsReauth
            ? new HttpError(401, 'needs_reauth', 'Microsoft access expired — reconnect your Microsoft 365 account')
            : new HttpError(400, 'not_connected', 'Microsoft 365 is not connected for this account');
    }
    if (!connection.teamsScopesGranted) {
        throw new HttpError(403, 'needs_teams_scopes', 'Teams meeting access has not been granted — reconnect Microsoft 365 to add it');
    }
    return { session, connection };
}

/**
 * The import itself, run after the 202. Access is checked again here (the
 * session and the user's group scope may have changed since the request was
 * accepted); whatever goes wrong ends up on the job row, never nowhere.
 * @param {{ req: import('express').Request, job: Awaited<ReturnType<typeof import('../../stores/teamsImportStore').getJob>> & {}, language: string | null, contextTerms: string }} args
 */
async function runTeamsImport({ req, job, language, contextTerms }) {
    const { session, connection } = await requireTeamsAccess(req);
    const accessCtx = await resolveAccessContext(req);
    await d.autoImport.processJobInline({
        job, session, language, contextTerms,
        transcriptAllowed: connection.hasTranscriptScope,
        accessCtx,
    });
}

/**
 * A failure that escaped the pipeline (or happened before it): put it on the
 * job as a terminal, classified error, unless the pipeline already did.
 * @param {string} jobId
 * @param {unknown} err
 */
async function recordImportFailure(jobId, err) {
    const e = /** @type {{ code?: string, message?: string }} */ (err);
    const fresh = await d.importStore.getJob(jobId);
    if (!fresh || fresh.status === 'ingested' || fresh.errorCode || fresh.status === 'awaiting_artifacts') return;
    const code = e?.code && TEAMS_ERROR_STATUS[e.code] ? e.code : 'failed';
    await d.importStore.failJob(jobId, {
        errorCode: code, terminal: true, lastError: String(e?.message || 'Teams import failed').slice(0, 500),
    });
}

// Manual import of a finished Teams meeting. The import takes minutes, longer
// than a proxy keeps a request open, so this validates, seeds the job and
// answers 202 { jobId, status } at once; the work runs in the background and the
// client polls GET /teams-imports for the job (ingested | an error code).
// 200 { id, dedup } when the meeting was imported before; classified 4xx otherwise.
router.post('/from-teams', requireAuth, validate({ body: FromTeamsBody, query: NO_QUERY }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof FromTeamsBody>, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    const userId = sessionUser(req).id;
    const { event_id, language, context_terms } = req.body;

    const orgId = await resolveUserOrgFromReq(req);
    const { session } = await requireTeamsAccess(req);

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

    const slot = d.importRunner.acquire({ jobKey: `teams:${job.id}`, userId, orgId });
    if (slot.ok === false) {
        if (slot.reason !== 'already_running') {
            throw new HttpError(429, 'too_many_imports', 'Too many meeting imports are running; wait for one to finish');
        }
        return res.status(202).json({ jobId: job.id, status: 'pending' });
    }

    try {
        // A fresh run: drop the previous outcome so the poller does not read it,
        // and keep the poller's tick off the row while this one works.
        await teamsImportStore.updateJob(job.id, { status: 'pending', errorCode: null, lastError: null });
        await teamsImportStore.heartbeatJob(job.id, INGEST_LEASE_MINUTES);
    } catch (err) {
        slot.release();
        throw err;
    }

    res.status(202).json({ jobId: job.id, status: 'pending' });
    void d.importRunner.runDetached({
        label: 'Transcriptions',
        release: slot.release,
        work: () => runTeamsImport({ req, job, language: language || null, contextTerms: context_terms || '' }),
        onFailure: (err) => recordImportFailure(job.id, err),
    });
});

module.exports = Object.assign(router, {
    init,
});
