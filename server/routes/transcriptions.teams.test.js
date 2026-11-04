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
    fx.updates = [];
    fx.failures = [];
    fx.fresh = null;
    fx.msSessions = null;
    fx.accessCalls = 0;
    fx.deletedNotes = new Set();
    fx.resolveOpts = [];
    fx.upcomingThrows = null;
    fx.endedThrows = null;
    require('../core/meetingNotes/manualImportRunner')._resetForTests();
}
resetFx();

const router = require('./transcriptions/teams');
router.init({
    permissions: { requireAuth: (req, res, next) => next() },
    shared: {
        resolveUserOrgFromReq: async () => 'orgA',
        resolveAccessContext: async () => { fx.accessCalls++; return { orgIds: new Set(['orgA']) }; },
    },
    credentialStore: { getCredential: async () => fx.cred },
    resolveMicrosoftSession: async (session, userId, opts) => {
        fx.resolveOpts.push(opts);
        if (fx.msSession === 'live') return session;
        return fx.msSessions ? (fx.msSessions.shift() || null) : fx.msSession;
    },
    transcriptions: { canReadTranscription: async (id) => !fx.deletedNotes.has(id) },
    settings: {
        deriveConnectionStatus: require('../core/meetingNotes/teamsNotesSettings').deriveConnectionStatus,
        hasTeamsScopes: require('../core/meetingNotes/teamsNotesSettings').hasTeamsScopes,
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
        listUpcomingTeamsMeetings: async () => { if (fx.upcomingThrows) throw fx.upcomingThrows; return fx.upcoming; },
        listRecentlyEndedTeamsMeetings: async () => { if (fx.endedThrows) throw fx.endedThrows; return fx.ended; },
    },
    artifacts: {
        getOnlineMeetingByJoinUrl: async () => ({ id: 'MSo1' }),
        setRecordAutomatically: async (session, args) => { fx.autoRecordCalls.push(args); return fx.autoRecordResult; },
    },
    importStore: {
        getJobForEvent: async (userId, eventId) => fx.jobs[eventId] || null,
        listRecentJobsForUser: async () => Object.values(fx.jobs),
        updateJob: async (id, fields) => { fx.updates.push({ id, fields }); return true; },
        heartbeatJob: async () => true,
        getJob: async () => fx.fresh,
        failJob: async (id, opts) => { fx.failures.push({ id, ...opts }); return true; },
        seedJob: async (row) => { fx.seeded.push(row); return { id: `job-${row.calendarEventId}`, status: 'pending', ...row }; },
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

const settle = async (check) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(check(), 'the background import did not finish');
};

test('from-teams: answers 202 with the job id before the import finishes, then the work runs', async () => {
    connected();
    fx.ended = [meeting()];
    let finish;
    fx.inline = () => new Promise((resolve) => { finish = () => resolve({ transcription: { id: 't-new' } }); });
    const res = await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1', language: 'en', context_terms: 'Foo' } });
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.body, { jobId: 'job-ev1', status: 'pending' });
    assert.strictEqual(fx.seeded[0].joinUrl, 'https://teams.microsoft.com/l/x');
    // The previous outcome is cleared before the client starts polling, and the
    // request is kept on the job: the poller finishing it later must not skip it
    // under the auto-import rules, and uses the language and terms asked for.
    assert.deepStrictEqual(fx.updates[0].fields, {
        status: 'pending', errorCode: null, lastError: null,
        requestedByUser: true, requestedLanguage: 'en', contextTerms: 'Foo',
    });
    await settle(() => fx.inlineCalls.length === 1);
    assert.strictEqual(fx.inlineCalls[0].language, 'en');
    assert.strictEqual(fx.inlineCalls[0].transcriptAllowed, true);
    assert.strictEqual(fx.inlineCalls[0].manual, true, 'a run the user watches is final and keeps its code');
    assert.strictEqual(fx.inlineCalls[0].job.requestedByUser, true);
    assert.strictEqual(fx.accessCalls, 1, 'access context re-resolved when the job runs');
    finish();
    await settle(() => fx.failures.length === 0);
});

test('from-teams: access is checked again when the job runs; a revoked grant lands on the job', async () => {
    connected();
    fx.ended = [meeting()];
    // The request resolves a session; by the time the job runs it is gone.
    fx.msSessions = [{ accessToken: 'at' }];
    fx.fresh = { id: 'job-new', status: 'pending', errorCode: null };
    const res = await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    assert.strictEqual(res.statusCode, 202);
    await settle(() => fx.failures.length === 1);
    assert.strictEqual(fx.inlineCalls.length, 0, 'the import never started');
    assert.strictEqual(fx.failures[0].errorCode, 'not_connected');
    assert.strictEqual(fx.failures[0].terminal, true);
});

test('from-teams: a failure of the pipeline is recorded on the job when the pipeline did not', async () => {
    connected();
    fx.ended = [meeting()];
    fx.fresh = { id: 'job-new', status: 'pending', errorCode: null };
    fx.inline = async () => { throw new Error('ffmpeg exploded'); };
    await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    await settle(() => fx.failures.length === 1);
    assert.deepStrictEqual(
        { code: fx.failures[0].errorCode, terminal: fx.failures[0].terminal },
        { code: 'failed', terminal: true },
    );

    // The pipeline already wrote its classified outcome: nothing is overwritten.
    fx.failures.length = 0;
    fx.fresh = { id: 'job-new', status: 'no_recording', errorCode: 'no_recording' };
    fx.inline = async () => { throw Object.assign(new Error('no rec'), { code: 'no_recording' }); };
    await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    await settle(() => fx.inlineCalls.length === 2);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(fx.failures, []);
});

test('from-teams: a second click while the import runs starts nothing new; the per-user cap answers 429', async () => {
    connected();
    fx.ended = [meeting()];
    fx.inline = () => new Promise(() => {});
    await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    const again = await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    assert.strictEqual(again.statusCode, 202);
    await settle(() => fx.inlineCalls.length >= 1);
    assert.strictEqual(fx.inlineCalls.length, 1);

    process.env.MEETING_IMPORT_MAX_CONCURRENT_PER_USER = '1';
    try {
        fx.ended = [meeting({ eventId: 'ev2' })];
        await assert.rejects(dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev2' } }),
            (err) => err.status === 429 && err.code === 'too_many_imports');
    } finally {
        delete process.env.MEETING_IMPORT_MAX_CONCURRENT_PER_USER;
    }
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


// ═══ Fixes ═════════════════════════════════════════════════════════════

test('from-teams: a meeting whose note was deleted can be imported again', async () => {
    connected();
    fx.ended = [meeting()];
    fx.jobs.ev1 = { id: 'job-1', status: 'ingested', transcriptionId: 't-deleted' };
    fx.deletedNotes.add('t-deleted');
    const res = await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    assert.strictEqual(res.statusCode, 202, 'a fresh import, not a dedup to a note that 404s');
    await settle(() => fx.inlineCalls.length === 1);
});

test('teams-recordings: a deleted note is not shown as "Note created"', async () => {
    connected();
    fx.ended = [meeting()];
    fx.jobs.ev1 = { transcriptionId: 't-deleted' };
    fx.deletedNotes.add('t-deleted');
    const res = await dispatch({ url: '/teams-recordings' });
    assert.strictEqual(res.body.items[0].importedNoteId, null);
});

test('from-teams: the run gets the job as reset, so an earlier failure does not use up its retries', async () => {
    connected();
    fx.ended = [meeting()];
    fx.jobs.ev1 = { id: 'job-1', status: 'failed', errorCode: 'failed', lastError: 'attempt 2/3: boom', transcriptionId: null };
    await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } });
    await settle(() => fx.inlineCalls.length === 1);
    const job = fx.inlineCalls[0].job;
    assert.deepStrictEqual([job.status, job.errorCode, job.lastError], ['pending', null, null]);
});

test('from-teams: the background run gets a detached copy of the live login session', async () => {
    connected();
    fx.msSession = 'live';
    fx.ended = [meeting()];
    const live = { user: { id: 'u1' }, oauthProvider: 'microsoft', accessToken: 'at', oauthScope: FULL_SCOPE };
    // express-session keeps save() on the prototype: a copy must not carry it.
    Object.setPrototypeOf(live, { save() { throw new Error('the live session must not be saved from the background'); } });
    const res = await dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' }, session: live });
    assert.strictEqual(res.statusCode, 202);
    await settle(() => fx.inlineCalls.length === 1);
    const used = fx.inlineCalls[0].session;
    assert.notStrictEqual(used, live, 'not the express-session object a refresh would write back');
    assert.strictEqual(used.accessToken, 'at');
    assert.strictEqual(typeof used.save, 'undefined', 'a refresh on the copy writes nothing back to the session store');
});

test('the scope flags come from the session the calls carry, and the vault grant may replace a stale login', async () => {
    // The vault has the Teams grant (after Reconnect); the live login token has none of it.
    fx.cred = { status: 'active', scope: FULL_SCOPE };
    fx.msSession = 'live';
    fx.upcoming = [meeting()];
    const live = { user: { id: 'u1' }, oauthProvider: 'microsoft', accessToken: 'old', oauthScope: 'openid Mail.Read' };
    const res = await dispatch({ url: '/teams-meetings', session: live });
    assert.strictEqual(typeof fx.resolveOpts[0].scopeSatisfies, 'function', 'the resolver may swap in the vault grant');
    assert.strictEqual(res.body.connection.teamsScopesGranted, false, 'never "granted" for a token that has none of it');
    assert.deepStrictEqual(res.body.meetings, []);
});

test('an expired Microsoft grant is the reconnect state, not a 500', async () => {
    connected();
    fx.upcomingThrows = new Error('NOT_CONNECTED');
    fx.endedThrows = new Error('NOT_CONNECTED');
    let res = await dispatch({ url: '/teams-meetings' });
    assert.strictEqual(res.body.connection.needsReauth, true);
    assert.deepStrictEqual(res.body.meetings, []);
    res = await dispatch({ url: '/teams-recordings' });
    assert.strictEqual(res.body.connection.needsReauth, true);
    assert.deepStrictEqual(res.body.items, []);
    await assert.rejects(dispatch({ method: 'POST', url: '/from-teams', body: { event_id: 'ev1' } }),
        (err) => err.status === 409 && err.code === 'needs_reauth');
});

test('PATCH: switching a meeting off switches Teams auto-record off again', async () => {
    connected();
    fx.settings.autoRecordConfig = true;
    fx.upcoming = [meeting({ seriesMasterId: null })];
    await dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: true } });
    const res = await dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: false } });
    assert.strictEqual(res.body.autoRecordingConfig, 'unset');
    assert.deepStrictEqual(fx.autoRecordCalls.map(c => c.enabled), [true, false]);
});

test('PATCH: one occurrence of a series never arms the series-wide Teams recording', async () => {
    connected();
    fx.settings.autoRecordConfig = true;
    fx.upcoming = [meeting()];   // seriesMasterId sm1
    const res = await dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: true, seriesMasterId: 'sm1' } });
    assert.strictEqual(res.body.autoRecordingConfig, 'series_only');
    assert.strictEqual(fx.autoRecordCalls.length, 0);
});

test('PATCH: a click overridden by a series opt-out does not arm Teams', async () => {
    connected();
    fx.settings.autoRecordConfig = true;
    fx.upcoming = [meeting({ seriesMasterId: null })];
    fx.prefs['code:sm9'] = false;
    const res = await dispatch({ method: 'PATCH', url: '/teams-meetings/ev1', body: { record: true, seriesMasterId: 'sm9', applyToSeries: false } });
    assert.strictEqual(res.body.overridden, true);
    assert.notStrictEqual(res.body.autoRecordingConfig, 'set');
    assert.ok(fx.autoRecordCalls.every(c => c.enabled === false));
});
