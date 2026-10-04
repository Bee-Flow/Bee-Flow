/**
 * Transcriptions — Google Meet meetings & imports.
 *
 * GET   /gmeet-meetings          — upcoming calendar-linked Meet meetings
 * PATCH /gmeet-meetings/:eventId — per-meeting import toggle
 * GET   /gmeet-imports           — recent import jobs (failure UX)
 * GET   /gmeet-recordings        — recently ended meetings + recording state
 * POST  /from-gmeet              — manual import of a finished recording
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const transcriptionStore = require('../../stores/transcriptionStore');
const { requireAuth } = require('../../auth/permissions');
const { resolveUserOrgFromReq } = require('./shared');

// ── Google Meet meetings (calendar-linked) ───────────────
//
// Mirror of the Talk block above for Google Meet: the Upcoming view lists the
// user's calendar Meet meetings with per-meeting import toggles, recent import
// jobs feed the failure UX, and manual import pulls a finished recording
// through the gmeet ingest pipeline. Auth resolves the live Google session
// first, else a session shim from the encrypted vault (Microsoft/Nextcloud-SSO
// users who connected Google via the connector).

// Stable failure codes shared with the UI → HTTP status for /from-gmeet.
const GMEET_ERROR_STATUS = {
    not_connected: 400,
    needs_reauth: 401,
    needs_meet_scopes: 403,
    no_conference: 404,
    no_recording: 404,
    no_drive_access: 403,
    recording_too_large: 413,
    unsupported_edition: 400,
};

function gmeetError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

/**
 * Resolve a Google session for the gmeet routes. The live Google session wins;
 * otherwise an 'active' vault credential (refreshed via getProviderAuth) is
 * wrapped in a session shim. Returns { session, source: 'live'|'vault'|null,
 * cred, connection } — `connection` is the status block the UI renders its
 * connect/reconnect CTAs from, `session` is null without usable Google auth.
 */
async function resolveGmeetSession(req) {
    const userId = req.session.user.id;
    const { deriveConnectionStatus } = require('../../core/meetingNotes/gmeetNotesSettings');
    let cred = null;
    try {
        const automationCredentialStore = require('../../stores/automationCredentialStore');
        cred = await automationCredentialStore.getCredential(userId, 'google');
    } catch (_) { /* vault unavailable → session-only */ }
    const connection = deriveConnectionStatus({ session: req.session, credential: cred });

    if (req.session.oauthProvider === 'google' && req.session.accessToken) {
        return { session: req.session, source: 'live', cred, connection };
    }
    if (cred && cred.status === 'active') {
        const { getProviderAuth } = require('../../auth/automationAuth');
        const auth = await getProviderAuth(userId, 'google');
        if (auth && auth.accessToken) {
            // Session shim — createGoogleApiClient writes refreshed tokens back
            // into this object; the durable copy lives in the vault, refreshed
            // by getProviderAuth itself on the next resolve.
            return {
                session: { accessToken: auth.accessToken, refreshToken: auth.refreshToken },
                source: 'vault',
                cred: auth,
                connection,
            };
        }
    }
    return { session: null, source: null, cred, connection };
}

const { validate } = require('../../core/http/validate');
const { worded, bodyOf, bool, NO_QUERY } = require('./schemas');

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
    // Stond er zonder enige controle en reist door tot in de transcriptie:
    // een verkeerd gespelde sleutel liet een Engelse opname in de
    // standaardtaal transcriberen, en dat is aan het antwoord niet te zien.
    language: worded('language is een taalcode.').trim().min(1).optional(),
    title: worded('Een titel is tekst.').optional(),
    context_terms: worded('context_terms is tekst.').optional(),
});

router.get('/gmeet-meetings', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
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
    const meetings = await listUpcomingMeetMeetings({ session, windowHours: 48 });

    // De per-vergadering keuze komt uit meeting_prefs (M5). `excluded` is de
    // EFFECTIEVE stand van de schakelaar in de Gepland-lijst, dus inclusief
    // de 1-op-1-standaard; de globale autoImport-schakelaar telt daar
    // bewust niet in mee (fallback: true) — die staat al in de statuschip.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'gmeet', userId, orgId: userOrgId });

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
        // Bij Meet is de agenda de ENIGE bron voor het deelnemersaantal —
        // er is geen live telling zoals bij Talk, want er wordt niets
        // gestart maar geoogst. De uitkomst is hier dus altijd beslist, en
        // dat zegt de route expliciet: het scherm mag geen "we kijken nog"
        // tonen bij een provider die niet meer gaat kijken.
        const recordDecided = true;
        const organizerSelf = m.organizerSelf === true;
        let importedNoteId = null;
        try {
            const t = await transcriptionStore.getTranscriptionByMeetMeetingCode(m.meetingCode, userId);
            if (t) importedNoteId = t.id;
        } catch (_) { /* ignore */ }

        let status;
        if (importedNoteId) status = 'imported';
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
        // De voetregel moet kunnen zeggen dat DEZE knop ook Meets EIGEN
        // auto-opname kan aanzetten — en Meet kondigt een lopende opname
        // altijd aan bij alle deelnemers. Zonder dit veld eindigde de zin
        // op "They are not notified" terwijl de knop eronder precies dat
        // wél kon veroorzaken. `hasSettingsScope` zit al in `connection`.
        autoRecordConfig: settings.autoRecordConfig === true,
        count: out.length,
        meetings: out,
    });
});

// Toggle a single Meet meeting's auto-import on/off (writes the user's
// exclusions; `applyToSeries` also toggles the meeting code → whole series).
// When import is turned ON for a meeting the user organizes, best-effort
// pre-configure Meet's auto-recording — the outcome is reported in
// `autoRecordingConfig` and never fails the PATCH.
router.patch('/gmeet-meetings/:eventId', requireAuth, validate({ body: GmeetPrefBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const eventId = req.params.eventId;
    const { record, meetingCode, applyToSeries, organizerSelf } = req.body;
    const { resolveGmeetNotesSettings } = require('../../core/meetingNotes/gmeetNotesSettings');
    // Schrijft de voorkeur van DEZE gebruiker (meeting_prefs); een andere
    // deelnemer aan dezelfde vergadering houdt zijn eigen rij.
    // `applyToSeries` zet hem ook op de meetingCode — de hele serie.
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

    // Wat er NA de schrijf geldt, niet wat er gevraagd werd. Eén FALSE
    // wint — een org-brede rij, of de serie-rij op de meetingCode terwijl
    // je één occurrence aanzette. Zonder dit antwoordde de route `record:
    // true`, sprong de rij op "Record", en stond hij bij de volgende load
    // weer op "Skip" zonder dat het scherm iets had uitgelegd.
    const patchOrgId = await resolveUserOrgFromReq(req);
    const after = await meetingPrefs.loadMeetingPrefs({ provider: 'gmeet', userId, orgId: patchOrgId });
    const opinion = after.opinionFor(meetingPrefs.gmeetIds({ eventId, meetingCode: meetingCode || null }));
    const effectiveRecord = opinion === true;

    let autoRecordingConfig = 'skipped';
    if (record && meetingCode) {
        try {
            const userOrgId = await resolveUserOrgFromReq(req);
            const settings = await resolveGmeetNotesSettings({ orgId: userOrgId, userId });
            const { session, connection } = await resolveGmeetSession(req);
            if (settings.autoRecordConfig && session) {
                let isOrganizer = typeof organizerSelf === 'boolean' ? organizerSelf : null;
                if (isOrganizer === null) {
                    const { listUpcomingMeetMeetings } = require('../../core/meetingNotes/gmeetCalendar');
                    const match = (await listUpcomingMeetMeetings({ session, windowHours: 48 }))
                        .find(m => m.eventId === eventId);
                    isOrganizer = match ? match.organizerSelf === true : false;
                }
                if (!isOrganizer) autoRecordingConfig = 'not_host';
                else if (!connection.hasSettingsScope) autoRecordingConfig = 'no_scope';
                else {
                    const { setAutoRecording } = require('../../core/meetingNotes/gmeetArtifacts');
                    const result = await setAutoRecording(session, { meetingCode, enabled: true });
                    autoRecordingConfig = result.ok ? 'set' : result.error;
                }
            }
        } catch (err) {
            log.warn('[Transcriptions] gmeet auto-record config failed:', err.message);
            autoRecordingConfig = 'error';
        }
    }

    res.json({
        ok: true, eventId,
        record: !!record,
        effectiveRecord,
        overridden: effectiveRecord !== !!record,
        autoRecordingConfig,
    });
});

// Recent import jobs — failure-UX feed + manual-import panel state.
router.get('/gmeet-imports', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
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
router.get('/gmeet-recordings', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const { session, connection } = await resolveGmeetSession(req);
    if (!session || !connection.meetScopesGranted) {
        return res.json({ connection, items: [] });
    }

    const { listRecentlyEndedMeetMeetings } = require('../../core/meetingNotes/gmeetCalendar');
    const { getSpaceByMeetingCode, findConferenceRecord, findGeneratedRecording } = require('../../core/meetingNotes/gmeetArtifacts');
    const meetings = await listRecentlyEndedMeetMeetings({ session, lookbackHours: 24 * 7 });
    meetings.sort((a, b) => new Date(b.end || 0) - new Date(a.end || 0));

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
                if (rec.recordingName) recordingState = 'available';
                else if (rec.notReady) recordingState = 'processing';
            }
        } catch (_) { /* best-effort — leave 'none' */ }
        let importedNoteId = null;
        try {
            const t = await transcriptionStore.getTranscriptionByMeetMeetingCode(m.meetingCode, userId);
            if (t) importedNoteId = t.id;
        } catch (_) { /* ignore */ }
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

// Manual import of a finished Meet recording. Runs the shared inline ingest
// (parity: /from-nextcloud, 10-minute timeout); responds 202 { jobId, status }
// when Meet's artifacts aren't ready yet, classified 4xx `code`s otherwise.
router.post('/from-gmeet', requireAuth, validate({ body: FromGmeetBody, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const { event_id, meeting_code, meet_link, language, title, context_terms } = req.body;

    req.setTimeout(600000); res.setTimeout(600000);

    try {
        const userOrgId = await resolveUserOrgFromReq(req);
        const { session, connection } = await resolveGmeetSession(req);
        if (!session) {
            throw gmeetError(
                connection.needsReauth
                    ? 'Google access expired — reconnect your Google account'
                    : 'Google is not connected for this account',
                connection.needsReauth ? 'needs_reauth' : 'not_connected',
            );
        }
        if (!connection.meetScopesGranted) {
            throw gmeetError('Google Meet access has not been granted — reconnect Google to add the Meet scopes', 'needs_meet_scopes');
        }

        const { extractMeetCode, listRecentlyEndedMeetMeetings } = require('../../core/meetingNotes/gmeetCalendar');
        let meetingCode = extractMeetCode(meet_link || meeting_code);
        let meeting = null;
        // Look up the calendar event (by id, else by code) so the job carries
        // the title + start/end that conference-record matching needs.
        try {
            const recent = await listRecentlyEndedMeetMeetings({ session, lookbackHours: 24 * 7 });
            meeting = recent.find(m => (event_id && m.eventId === event_id) || (meetingCode && m.meetingCode === meetingCode)) || null;
        } catch (_) { /* best-effort — a code-only import can still proceed */ }
        if (meeting && !meetingCode) meetingCode = meeting.meetingCode;
        if (!meetingCode) {
            const e = gmeetError('Provide a Google Meet link, meeting code or calendar event id of a recently ended meeting', 'bad_request');
            e.status = 400;
            throw e;
        }

        const { seedJob, listRecentJobsForUser } = require('../../stores/gmeetImportStore');
        const eventId = meeting?.eventId || event_id || null;

        // Find-or-seed: the poller may already own a row for this meeting.
        const recentJobs = await listRecentJobsForUser(userId, 30);
        let job = eventId
            ? recentJobs.find(j => j.calendarEventId === eventId) || null
            : recentJobs.find(j => j.meetingCode === meetingCode) || null;
        if (!job) {
            job = await seedJob({
                userId,
                orgId: userOrgId,
                calendarEventId: eventId,
                icalUid: meeting?.iCalUID || null,
                meetingCode,
                title: title || meeting?.title || null,
                meetingStart: meeting?.start || null,
                meetingEnd: meeting?.end || null,
                preferred: meeting?.organizerSelf === true,
            });
            // Unique-index conflict (another job already owns this meeting) —
            // fall back to that row instead of failing the import.
            if (!job) job = recentJobs.find(j => j.meetingCode === meetingCode) || null;
        }
        if (!job) throw gmeetError('Could not create an import job for this meeting', 'failed');

        // Lazy — shared with the background poller so manual and auto imports
        // behave identically (dedup, artifact waits, failure classification).
        const { processJobInline } = require('../../core/meetingNotes/gmeetAutoImport');
        const out = await processJobInline({ job, session, language, contextTerms: context_terms || '' });
        if (out && out.pending) {
            return res.status(202).json({ jobId: job.id, status: out.status || job.status });
        }
        res.json(out.transcription);
    } catch (err) {
        log.error('[Transcriptions] from-gmeet failed:', err.message);
        const status = err.status || GMEET_ERROR_STATUS[err.code] || 500;
        res.status(status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
});

module.exports = router;
