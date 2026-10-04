/**
 * Microsoft Teams routes — teams-meetings / teams-imports / teams-recordings /
 * from-teams.
 *
 * Pins: the not-connected and missing-scope first-run answers, the status
 * mapping (organizer_only | excluded | will_import | upcoming), the PATCH
 * preference write plus best-effort "record automatically" (organizer only,
 * never failing the PATCH), and the manual import's 200 / 202 / classified
 * 4xx paths.
 *
 * Drives the Teams sub-router directly, its collaborators injected through
 * `router.init()`.
 *
 * Run: cd server && node --test routes/transcriptions.teams.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const FULL_SCOPE = 'Calendars.ReadWrite OnlineMeetingRecording.Read.All OnlineMeetings.ReadWrite OnlineMeetingTranscript.Read.All';

const fx = {};
function resetFx() {
    fx.cred = null;
    fx.msSession = null;
    fx.settings = { autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24 };
    fx.prefs = {};
    fx.prefWrites = [];
    fx.upcoming = [];
    fx.ended = [];
    fx.autoRecordCalls = [];
    fx.autoRecordResult = { ok: true };
    fx.jobs = {};
    fx.seeded = [];
    fx.inline = async () => ({ transcription: { id: 't-new' } });
    fx.inlineCalls = [];
}
resetFx();

const router = require('./transcriptions/teams');
router.init({
    permissions: { requireAuth: (req, res, next) => next() },
    shared: {
        resolveUserOrgFromReq: async () => 'orgA',
        resolveAccessContext: async () => ({ orgIds: new Set(['orgA']) }),
    },
    credentialStore: { getCredential: async () => fx.cred },
    resolveMicrosoftSession: async () => fx.msSession,
    settings: {
        deriveConnectionStatus: require('../core/meetingNotes/teamsNotesSettings').deriveConnectionStatus,
        resolveTeamsNotesSettings: async () => ({ ...fx.settings }),
    },
    meetingPrefs: {
        teamsIds: ({ eventId = null, seriesMasterId = null } = {}) => [
            { kind: 'event', id: eventId }, { kind: 'code', id: seriesMasterId },
        ].filter((x) => x.id),
        participantCountOf: (m) => (Array.isArray(m?.attendees) ? m.attendees.length + 1 : null),
        setRecord: async (args) => {
            fx.prefWrites.push(args);
            for (const { kind, id } of args.ids) fx.prefs[`${kind}:${id}`] = args.record;
        },
        loadMeetingPrefs: async () => {
            const opinionFor = (ids) => {
                const seen = ids.map(({ kind, id }) => fx.prefs[`${kind}:${id}`]);
                if (seen.includes(false)) return false;
                if (seen.includes(true)) return true;
                return null;
            };
            return {
                opinionFor,
                tagsFor: () => [],
                decide: ({ ids, participantCount, fallback }) => {
                    const o = opinionFor(ids);
                    if (o !== null) return { record: o, reason: o ? 'opted_in' : 'opted_out' };
                    if (!(participantCount > 2)) return { record: false, reason: 'small_meeting' };
                    return { record: !!fallback, reason: 'auto' };
                },
            };
        },
    },
    calendar: {
        listUpcomingTeamsMeetings: async () => fx.upcoming,
        listRecentlyEndedTeamsMeetings: async () => fx.ended,
    },
    artifacts: {
        getOnlineMeetingByJoinUrl: async () => ({ id: 'MSo1' }),
        setRecordAutomatically: async (session, args) => { fx.autoRecordCalls.push(args); return fx.autoRecordResult; },
    },
    importStore: {
        getJobForEvent: async (userId, eventId) => fx.jobs[eventId] || null,
        listRecentJobsForUser: async () => Object.values(fx.jobs),
        seedJob: async (row) => { fx.seeded.push(row); return { id: 'job-new', status: 'pending', ...row }; },
    },
    autoImport: {
        processJobInline: async (args) => { fx.inlineCalls.push(args); return fx.inline(args); },
        findArtifact: async () => ({ kind: 'recording', id: 'R1' }),
    },
});

function dispatch({ method = 'GET', url, body, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {}, headers: {},
            session: session || { user: { id: 'u1' } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

function connected() {
    fx.cred = { status: 'active', scope: FULL_SCOPE };
    fx.msSession = { accessToken: 'at' };
}

function meeting(over = {}) {
    return {
        eventId: 'ev1', seriesMasterId: 'sm1', title: 'Overleg', joinUrl: 'https://teams.microsoft.com/l/x',
        start: '2026-10-01T09:00:00.000Z', end: '2026-10-01T09:30:00.000Z',
        organizerSelf: true, attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }], ...over,
    };
}

test.beforeEach(resetFx);

test('teams-meetings: not connected → empty list with the connection block', async () => {
    const res = await dispatch({ url: '/teams-meetings' });
    assert.strictEqual(res.body.connection.microsoftConnected, false);
    assert.deepStrictEqual(res.body.meetings, []);
});

test('teams-meetings: connected with only the old login scopes → reconnect, no calendar call', async () => {
    fx.cred = { status: 'active', scope: 'Calendars.ReadWrite OnlineMeetings.Read' };
    fx.msSession = { accessToken: 'at' };
    fx.upcoming = [meeting()];
    const res = await dispatch({ url: '/teams-meetings' });
    assert.strictEqual(res.body.connection.microsoftConnected, true);
    assert.strictEqual(res.body.connection.teamsScopesGranted, false);
    assert.deepStrictEqual(res.body.meetings, []);
});

test('teams-meetings: status per meeting', async () => {
    connected();
    fx.settings.autoImport = true;
    fx.prefs['event:ev3'] = false;
    fx.upcoming = [
        meeting({ eventId: 'ev1' }),
        meeting({ eventId: 'ev2', organizerSelf: false }),
        meeting({ eventId: 'ev3', seriesMasterId: null }),
    ];
    const res = await dispatch({ url: '/teams-meetings' });
    assert.deepStrictEqual(res.body.meetings.map(m => [m.eventId, m.status]), [
        ['ev1', 'will_import'], ['ev2', 'organizer_only'], ['ev3', 'excluded'],
    ]);
    assert.strictEqual(res.body.meetings[1].recordingControlledByHost, true);
});

test('PATCH: writes the preference (series when asked) and switches on Teams auto-record for the organizer', async () => {
    connected();
    fx.settings.autoRecordConfig = true;
    fx.upcoming = [meeting()];
    const res = await dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: true, seriesMasterId: 'sm1', applyToSeries: true } });
    assert.deepStrictEqual(fx.prefWrites[0].ids, [{ kind: 'event', id: 'ev1' }, { kind: 'code', id: 'sm1' }]);
    assert.strictEqual(res.body.effectiveRecord, true);
    assert.strictEqual(res.body.autoRecordingConfig, 'set');
    assert.deepStrictEqual(fx.autoRecordCalls, [{ joinUrl: 'https://teams.microsoft.com/l/x', enabled: true }]);
});

test('PATCH: auto-record outcomes never fail the PATCH', async () => {
    connected();
    fx.settings.autoRecordConfig = true;
    fx.upcoming = [meeting({ organizerSelf: false })];
    let res = await dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: true } });
    assert.strictEqual(res.body.autoRecordingConfig, 'not_organizer');

    fx.cred.scope = 'Calendars.ReadWrite OnlineMeetingRecording.Read.All';
    res = await dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: true } });
    assert.strictEqual(res.body.autoRecordingConfig, 'needs_teams_scopes');

    fx.settings.autoRecordConfig = false;
    res = await dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: true } });
    assert.strictEqual(res.body.autoRecordingConfig, 'skipped');
    assert.strictEqual(fx.autoRecordCalls.length, 0);
});

test('PATCH: a string "false" is refused, never read as true', async () => {
    await assert.rejects(dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: 'false' } }),
        (err) => err.status === 400 || err.statusCode === 400);
    assert.strictEqual(fx.prefWrites.length, 0);
});

test('from-teams: classified refusals', async () => {
    await assert.rejects(dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } }),
        (err) => err.status === 400 && err.code === 'not_connected');

    fx.cred = { status: 'active', scope: 'Calendars.ReadWrite' };
    fx.msSession = { accessToken: 'at' };
    await assert.rejects(dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } }),
        (err) => err.status === 403 && err.code === 'needs_teams_scopes');

    connected();
    await assert.rejects(dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'nope' } }),
        (err) => err.status === 404);

    fx.ended = [meeting({ organizerSelf: false })];
    await assert.rejects(dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } }),
        (err) => err.status === 403 && err.code === 'not_organizer');
});

test('from-teams: seeds a job, runs it, answers the note; 202 while pending; mapped pipeline codes', async () => {
    connected();
    fx.ended = [meeting()];
    let res = await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1', language: 'en' } });
    assert.deepStrictEqual(res.body, { id: 't-new' });
    assert.strictEqual(fx.seeded[0].joinUrl, 'https://teams.microsoft.com/l/x');
    assert.strictEqual(fx.inlineCalls[0].language, 'en');
    assert.strictEqual(fx.inlineCalls[0].transcriptAllowed, true);

    fx.inline = async () => ({ pending: true, status: 'awaiting_artifacts' });
    res = await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.body, { jobId: 'job-new', status: 'awaiting_artifacts' });

    fx.inline = async () => { throw Object.assign(new Error('no rec'), { code: 'no_recording' }); };
    await assert.rejects(dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } }),
        (err) => err.status === 404 && err.code === 'no_recording');
});

test('from-teams: an already ingested job answers its note without running again', async () => {
    connected();
    fx.ended = [meeting()];
    fx.jobs.ev1 = { id: 'job-1', status: 'ingested', transcriptionId: 't-old' };
    const res = await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    assert.deepStrictEqual(res.body, { id: 't-old', dedup: true });
    assert.strictEqual(fx.inlineCalls.length, 0);
});

test('teams-recordings: organizer meetings only, newest first, with artifact state and note', async () => {
    connected();
    fx.ended = [
        meeting({ eventId: 'old', end: '2026-09-29T10:00:00Z' }),
        meeting({ eventId: 'new', end: '2026-09-30T10:00:00Z' }),
        meeting({ eventId: 'theirs', organizerSelf: false }),
    ];
    fx.jobs.old = { transcriptionId: 't-old' };
    const res = await dispatch({ url: '/teams-recordings' });
    assert.deepStrictEqual(res.body.items.map(i => [i.eventId, i.recordingState, i.importedNoteId]), [
        ['new', 'available', null], ['old', 'available', 't-old'],
    ]);
});
