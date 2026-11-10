/**
 * teamsAutoImport tests — the Teams auto-import poller.
 *
 * Covers: discovery (organizer-only seeding, opt-in, licence and scope skips,
 * per-meeting opt-out, unparking), the per-job pipeline (recording preferred,
 * transcript fallback, transcript switch off = no transcript, waiting with
 * backoff, the 48 h no-recording deadline, meeting not available), ingest
 * retries and terminal codes, claim-time opt-out and needs_reauth parking, the
 * per-user skip state and the Graph user path of the attendee lookup. Option B
 * (the organisation app token) over the real coverage and app-token modules:
 * the delegated path first, the app path for a covered user, and coverage
 * re-checked at claim for every way a user stops being covered.
 *
 * Every dependency is injected through init(); the job store is an
 * in-memory fake with the real store's semantics.
 *
 * Run: cd server && node --test core/meetingNotes/teamsAutoImport.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const TEAMS_SCOPE = 'openid Calendars.ReadWrite OnlineMeetingRecording.Read.All OnlineMeetingTranscript.Read.All';

function makeJobStore() {
    const jobs = [];
    let seq = 0;
    const byId = (id) => jobs.find((j) => j.id === id);
    return {
        jobs,
        async seedJob(row) {
            if (jobs.some((j) => j.userId === row.userId && j.calendarEventId === row.calendarEventId)) return null;
            const job = {
                id: `job-${++seq}`, orgId: null, seriesMasterId: null, onlineMeetingId: null, title: null,
                meetingStart: null, meetingEnd: null, status: 'pending', errorCode: null, lastError: null,
                attempts: 0, nextAttemptAt: new Date().toISOString(), transcriptionId: null,
                createdAt: new Date().toISOString(), ...row,
            };
            jobs.push(job);
            return { ...job };
        },
        async claimDueJobs(limit = 2) {
            const now = Date.now();
            const due = jobs.filter((j) => ['pending', 'awaiting_artifacts'].includes(j.status)
                && new Date(j.nextAttemptAt).getTime() <= now).slice(0, limit);
            for (const j of due) j.nextAttemptAt = new Date(now + 600_000).toISOString();
            return due.map((j) => ({ ...j }));
        },
        async heartbeatJob(id) { const j = byId(id); if (j) j.heartbeats = (j.heartbeats || 0) + 1; return !!j; },
        async updateJob(id, fields) {
            const j = byId(id);
            if (!j) return false;
            for (const [k, v] of Object.entries(fields)) if (v !== undefined) j[k] = v;
            return true;
        },
        async completeJob(id, transcriptionId) {
            Object.assign(byId(id), { status: 'ingested', transcriptionId, errorCode: null, lastError: null });
            return true;
        },
        async failJob(id, { errorCode = null, lastError = null, terminal = false, backoffMs = 0, status = null } = {}) {
            const j = byId(id);
            j.attempts += 1;
            if (terminal) Object.assign(j, { status: errorCode || 'failed', errorCode, lastError });
            else {
                if (status) j.status = status;
                Object.assign(j, { errorCode, lastError, nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(), backoffMs });
            }
            return true;
        },
        async parkNeedsReauth(id) { Object.assign(byId(id), { status: 'needs_reauth', errorCode: 'needs_reauth' }); return true; },
        async unparkForUser(userId) {
            fx.unparkCalls++;
            let n = 0;
            for (const j of jobs) if (j.userId === userId && j.status === 'needs_reauth') { j.status = 'pending'; j.errorCode = null; n++; }
            return n;
        },
    };
}

const fx = {};
function resetFx() {
    fx.store = makeJobStore();
    fx.configAll = { user_teams_notes_u1: {} };
    fx.usersById = { u1: { id: 'u1', organizationId: 'orgA' } };
    fx.users = [{ id: 'u1', organizationId: 'orgA' }];
    fx.settingsByOrg = {};
    fx.settingsByUser = { u1: { autoImport: true } };
    fx.entitled = {};
    fx.authByUser = { u1: { userId: 'u1', orgId: 'orgA', accessToken: 'at', refreshToken: 'rt', scope: TEAMS_SCOPE } };
    fx.ended = [];
    fx.endedCalls = 0;
    fx.authCalls = 0;
    fx.unparkCalls = 0;
    fx.optInUsers = null;
    fx.meeting = { id: 'MSo1' };
    fx.recordings = [];
    fx.transcripts = [];
    fx.transcriptError = null;
    fx.lookupError = null;
    fx.prefs = {};
    fx.ingestCalls = [];
    fx.ingestError = null;
    fx.ingestResult = { id: 't-new', title: 'Notitie' };
    fx.graphAttendees = null;
    fx.graphPaths = [];
    fx.skips = new Map();
    fx.skipWrites = [];
    fx.skipClears = 0;
    fx.creds = {};
    fx.credLookupError = null;
    fx.sessionUnavailable = false;
    fx.endedSessions = [];
    // Option B: by default nobody is covered (the stub below); the B tests swap in the real modules.
    fx.appCalls = [];
    fx.appImpl = null;
}
resetFx();

const DEFAULTS = { autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24 };
const auto = require('./teamsAutoImport');
auto.init({
    teamsImportStore: new Proxy({}, { get: (_t, k) => (...a) => fx.store[k](...a) }),
    configStore: { getAllConfig: async () => fx.configAll },
    userStore: {
        getUser: async (id) => { if (fx.userLookupError) throw fx.userLookupError; return fx.usersById[id] || null; },
        getAllUsers: async () => fx.users,
    },
    recordOptIn: {
        hasLiveRecordOptIn: (rows) => rows.some((r) => r.record === true),
        listUsersWithRecordOptIn: async () => (Object.values(fx.prefs).includes(true) ? (fx.optInUsers || ['u1']) : []),
    },
    meetingPrefs: {
        teamsIds: ({ eventId = null, seriesMasterId = null } = {}) => [
            { kind: 'event', id: eventId }, { kind: 'code', id: seriesMasterId },
        ].filter((x) => x.id),
        participantCountOf: (m) => (Array.isArray(m?.attendees) ? m.attendees.length + 1 : null),
        loadMeetingPrefs: async () => {
            const opinionFor = (ids) => {
                const seen = ids.map(({ kind, id }) => fx.prefs[`${kind}:${id}`]);
                if (seen.includes(false)) return false;
                if (seen.includes(true)) return true;
                return null;
            };
            return {
                rows: Object.entries(fx.prefs).map(([k, record]) => ({ idKind: k.split(':')[0], externalId: k.split(':')[1], record })),
                opinionFor,
                decide: ({ ids, participantCount, fallback }) => {
                    const o = opinionFor(ids);
                    if (o !== null) return { record: o };
                    if (!(participantCount > 2)) return { record: false };
                    return { record: !!fallback };
                },
            };
        },
    },
    automationAuth: { getProviderAuth: async (userId) => { fx.authCalls++; return fx.authByUser[userId] || null; } },
    credentialStore: {
        getCredential: async (userId) => { if (fx.credLookupError) throw fx.credLookupError; return fx.creds[userId] || null; },
    },
    // The skip state's own semantics (write on change, clear when stored) are
    // pinned in teamsImportSkipState.test.js; here only what discovery asks for.
    skipState: {
        recordSkip: async (userId, orgId, reason, missingPermissions = []) => {
            fx.skipWrites.push({ userId, orgId, reason, missingPermissions });
            fx.skips.set(userId, { reason, missingPermissions, orgId });
        },
        clearSkip: async (userId) => { fx.skipClears++; fx.skips.delete(userId); },
    },
    resolveMicrosoftSession: async (s, userId) => {
        if (fx.sessionUnavailable) return null;
        return s?.automationProviders?.microsoft ? { userId, accessToken: s.automationProviders.microsoft.accessToken } : null;
    },
    hasCapability: async (_c, { userId }) => fx.entitled[userId] !== false,
    graphFetch: async (p) => {
        fx.graphPaths.push(p);
        return { attendees: fx.graphAttendees || [{ emailAddress: { address: 'an@x.nl', name: 'An' } }] };
    },
    resolveTeamsNotesSettings: async ({ orgId = null, userId = null } = {}) => ({
        ...DEFAULTS, ...(orgId ? fx.settingsByOrg[orgId] : null), ...(userId ? fx.settingsByUser[userId] : null),
    }),
    hasTeamsScopes: (scope) => String(scope || '').includes('OnlineMeetingRecording.Read.All'),
    hasTranscriptScope: (scope) => String(scope || '').includes('OnlineMeetingTranscript.Read.All'),
    listRecentlyEndedTeamsMeetings: async ({ session, lookbackHours } = {}) => { fx.endedCalls++; fx.endedSessions.push(session); fx.lookback = lookbackHours; return fx.ended; },
    getOnlineMeetingByJoinUrl: async () => {
        if (fx.lookupError) throw fx.lookupError;
        return fx.meeting;
    },
    listRecordings: async () => fx.recordings,
    listTranscripts: async () => {
        if (fx.transcriptError) throw fx.transcriptError;
        return fx.transcripts;
    },
    pickArtifactForSlot: (items) => items[0] || null,
    ingestTeamsMeeting: async (args) => {
        fx.ingestCalls.push(args);
        if (fx.ingestError) throw fx.ingestError;
        return fx.ingestResult;
    },
    appImport: {
        resolveAppImportSession: async (userId, orgId, opts) => {
            fx.appCalls.push({ userId, orgId, opts });
            if (fx.appImpl) return fx.appImpl.resolveAppImportSession(userId, orgId, opts);
            return { status: 'not_covered', reason: 'not_enabled' };
        },
    },
});

const coded = (message, code) => Object.assign(new Error(message), { code });
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
function endedMeeting(over = {}) {
    return {
        eventId: 'ev1', seriesMasterId: null, title: 'Overleg', joinUrl: 'https://teams.microsoft.com/l/x',
        start: hoursAgo(2), end: hoursAgo(1.5), organizerSelf: true,
        attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }], ...over,
    };
}
async function seeded(over = {}) {
    return fx.store.seedJob({
        userId: 'u1', orgId: 'orgA', calendarEventId: 'ev1', joinUrl: 'https://teams.microsoft.com/l/x',
        title: 'Overleg', meetingStart: hoursAgo(2), meetingEnd: hoursAgo(1.5), ...over,
    });
}

test.beforeEach(resetFx);

// ── discovery ────────────────────────────────────────────────────────

test('discover seeds organizer meetings only', async () => {
    fx.ended = [endedMeeting(), endedMeeting({ eventId: 'ev2', organizerSelf: false })];
    await auto.discover();
    assert.deepStrictEqual(fx.store.jobs.map(j => j.calendarEventId), ['ev1']);
    assert.strictEqual(fx.store.jobs[0].orgId, 'orgA');
});

test('discover skips: autoImport off, no licence, no Teams scopes, opted out, 1-on-1', async () => {
    fx.ended = [endedMeeting()];
    fx.settingsByUser.u1 = { autoImport: false };
    await auto.discover();
    fx.settingsByUser.u1 = { autoImport: true };
    fx.entitled.u1 = false;
    await auto.discover();
    fx.entitled.u1 = true;
    fx.authByUser.u1.scope = 'Calendars.ReadWrite OnlineMeetings.Read';
    await auto.discover();
    fx.authByUser.u1.scope = TEAMS_SCOPE;
    fx.prefs['event:ev1'] = false;
    await auto.discover();
    fx.prefs = {};
    fx.ended = [endedMeeting({ attendees: [{ email: 'a@x.nl' }] })];
    await auto.discover();
    assert.strictEqual(fx.store.jobs.length, 0);
});

test('autoImport off: an explicit record mark imports that one meeting only', async () => {
    fx.settingsByUser.u1 = { autoImport: false };
    fx.ended = [endedMeeting(), endedMeeting({ eventId: 'ev2' })];
    fx.prefs['event:ev2'] = true;
    await auto.discover();
    assert.deepStrictEqual(fx.store.jobs.map(j => j.calendarEventId), ['ev2']);
});

test('autoImport off and a user who only has a mark (no settings doc) is still a candidate', async () => {
    fx.configAll = {};
    fx.settingsByUser = {};
    fx.ended = [endedMeeting()];
    fx.prefs['event:ev1'] = true;
    await auto.discover();
    assert.strictEqual(fx.store.jobs.length, 1);
});

test('autoImport off without any mark: no Graph call, no job; an opt-out still wins', async () => {
    fx.settingsByUser.u1 = { autoImport: false };
    fx.ended = [endedMeeting()];
    await auto.discover();
    assert.strictEqual(fx.endedCalls, 0);
    fx.prefs['event:ev1'] = false;
    await auto.discover();
    assert.strictEqual(fx.endedCalls, 0);
    assert.strictEqual(fx.store.jobs.length, 0);
    assert.strictEqual(fx.authCalls, 0, 'no token refresh for a user without a mark');
    assert.strictEqual(fx.unparkCalls, 0, 'no database write for a user without a mark');
});

test('a deleted or deactivated user is not discovered, even with a mark', async () => {
    fx.ended = [endedMeeting()];
    fx.prefs['event:ev1'] = true;
    fx.usersById.u1 = { id: 'u1', organizationId: 'orgA', status: 'disabled' };
    await auto.discover();
    delete fx.usersById.u1;
    await auto.discover();
    assert.strictEqual(fx.endedCalls, 0);
});

test('claim time with autoImport off: a marked job runs, an unmarked one is skipped', async () => {
    fx.settingsByUser.u1 = { autoImport: false };
    fx.recordings = [{ id: 'R1' }];
    await seeded();
    fx.prefs['event:ev1'] = true;
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'ingested');

    resetFx();
    fx.settingsByUser.u1 = { autoImport: false };
    await seeded();
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'skipped');
});

test('an org that turned autoImport on brings in members without their own doc', async () => {
    fx.configAll = { org_teams_notes_orgA: {} };
    fx.settingsByUser = {};
    fx.settingsByOrg.orgA = { autoImport: true };
    fx.ended = [endedMeeting()];
    await auto.discover();
    assert.strictEqual(fx.store.jobs.length, 1);
});

test('discover returns parked jobs to the queue once the credential works', async () => {
    const job = await seeded({ calendarEventId: 'old' });
    await fx.store.parkNeedsReauth(job.id);
    await auto.discover();
    assert.strictEqual(fx.store.jobs[0].status, 'pending');
});

// ── skip state ───────────────────────────────────────────────────────

test('discovery remembers why it skipped a user, per reason', async () => {
    fx.ended = [endedMeeting()];
    const lastSkip = () => fx.skipWrites[fx.skipWrites.length - 1];

    fx.entitled.u1 = false;
    await auto.discover();
    assert.deepStrictEqual(lastSkip(), { userId: 'u1', orgId: 'orgA', reason: 'not_licensed', missingPermissions: [] });
    fx.entitled.u1 = true;

    fx.authByUser = {};
    await auto.discover();
    assert.strictEqual(lastSkip().reason, 'no_credential');

    fx.creds.u1 = { status: 'needs_reauth', scope: TEAMS_SCOPE };
    await auto.discover();
    assert.strictEqual(lastSkip().reason, 'credential_needs_reauth');

    fx.creds.u1 = { status: 'revoked', scope: TEAMS_SCOPE };
    await auto.discover();
    assert.strictEqual(lastSkip().reason, 'credential_revoked');

    // An active row getProviderAuth could not refresh right now.
    fx.creds.u1 = { status: 'active', scope: TEAMS_SCOPE };
    await auto.discover();
    assert.strictEqual(lastSkip().reason, 'session_unavailable');

    fx.authByUser = { u1: { userId: 'u1', orgId: 'orgA', accessToken: 'at', scope: 'openid Calendars.ReadWrite' } };
    await auto.discover();
    assert.deepStrictEqual(lastSkip(), {
        userId: 'u1', orgId: 'orgA', reason: 'missing_scopes', missingPermissions: ['OnlineMeetingRecording.Read.All'],
    }, 'names the required permissions that are missing');

    fx.authByUser.u1.scope = TEAMS_SCOPE;
    fx.sessionUnavailable = true;
    await auto.discover();
    assert.strictEqual(lastSkip().reason, 'session_unavailable');

    assert.strictEqual(fx.store.jobs.length, 0, 'nothing was seeded while skipped');
    assert.strictEqual(fx.skipClears, 0);
});

test('the skip state is cleared as soon as discovery gets a session, and jobs are seeded again', async () => {
    fx.ended = [endedMeeting()];
    fx.entitled.u1 = false;
    await auto.discover();
    assert.strictEqual(fx.skips.get('u1').reason, 'not_licensed');
    fx.entitled.u1 = true;
    await auto.discover();
    assert.strictEqual(fx.skips.has('u1'), false);
    assert.strictEqual(fx.skipClears, 1);
    assert.strictEqual(fx.store.jobs.length, 1);
});

test('an unreadable credential row records no reason rather than a wrong one', async () => {
    fx.ended = [endedMeeting()];
    fx.authByUser = {};
    fx.credLookupError = new Error('vault down');
    await auto.discover();
    assert.deepStrictEqual(fx.skipWrites, []);
});

test('a user who is not a candidate this tick (auto-import off, no mark) gets no skip state', async () => {
    fx.settingsByUser.u1 = { autoImport: false };
    fx.entitled.u1 = false;
    await auto.discover();
    assert.deepStrictEqual(fx.skipWrites, []);
});

test('a skip recorded while auto-import was on is dropped once it is switched off', async () => {
    fx.ended = [endedMeeting()];
    fx.authByUser = {};
    await auto.discover();
    assert.strictEqual(fx.skips.get('u1').reason, 'no_credential');
    fx.settingsByUser.u1 = { autoImport: false };
    await auto.discover();
    assert.strictEqual(fx.skips.has('u1'), false, 'the stale skip is gone');
    assert.strictEqual(fx.skipWrites.length, 1, 'nothing new is recorded');
    assert.strictEqual(fx.endedCalls, 0);
});

// ── per-job pipeline ─────────────────────────────────────────────────

test('a recording is ingested with the calendar attendees and the job completes', async () => {
    fx.recordings = [{ id: 'R1' }];
    fx.transcripts = [{ id: 'T1' }];
    await seeded();
    await auto.processDue();
    const job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'ingested');
    assert.strictEqual(job.transcriptionId, 't-new');
    assert.strictEqual(job.onlineMeetingId, 'MSo1');
    assert.strictEqual(job.heartbeats, 1, 'lease extended before the long ingest');
    assert.deepStrictEqual(fx.ingestCalls[0].artifact, { kind: 'recording', id: 'R1' });
    assert.strictEqual(fx.ingestCalls[0].meetingId, 'MSo1');
    assert.strictEqual(fx.ingestCalls[0].language, 'nl');
    assert.deepStrictEqual(fx.ingestCalls[0].attendees, [{ email: 'an@x.nl', displayName: 'An' }]);
});

test('no recording but a transcript → the transcript is ingested', async () => {
    fx.transcripts = [{ id: 'T1' }];
    await seeded();
    await auto.processDue();
    assert.deepStrictEqual(fx.ingestCalls[0].artifact, { kind: 'transcript', id: 'T1' });
});

test('the transcript fallback is skipped without the transcript scope', async () => {
    fx.transcripts = [{ id: 'T1' }];
    fx.authByUser.u1.scope = 'Calendars.ReadWrite OnlineMeetingRecording.Read.All';
    await seeded();
    await auto.processDue();
    assert.strictEqual(fx.ingestCalls.length, 0);
    assert.strictEqual(fx.store.jobs[0].status, 'awaiting_artifacts');
});

test('transcript API switched off by the tenant counts as "no transcript yet", not a failure', async () => {
    fx.transcriptError = coded('off', 'transcript_access_disabled');
    await seeded();
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'awaiting_artifacts');
    assert.ok(fx.store.jobs[0].backoffMs > 0);
});

test('no artifact 30 h after the end still waits (deadline is 48 h)', async () => {
    await seeded({ meetingStart: hoursAgo(31), meetingEnd: hoursAgo(30) });
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'awaiting_artifacts');
});

test('nothing 48 h after the end → terminal no_recording', async () => {
    await seeded({ meetingStart: hoursAgo(50), meetingEnd: hoursAgo(49) });
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'no_recording');
});

test('no onlineMeeting for a meeting the calendar says the user organises → terminal meeting_not_available', async () => {
    fx.meeting = null;
    await seeded();
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'meeting_not_available');
    assert.strictEqual(fx.store.jobs[0].errorCode, 'meeting_not_available');
    assert.strictEqual(fx.store.jobs[0].lastError, 'Microsoft has no online meeting for this calendar entry');
});

test('the new classified Graph refusals freeze the job at once', async () => {
    for (const code of ['graph_forbidden', 'application_access_policy_missing', 'calendar_forbidden', 'meeting_not_available']) {
        resetFx();
        fx.lookupError = coded(`refused: ${code}`, code);
        await seeded();
        await auto.processDue();
        assert.strictEqual(fx.store.jobs[0].status, code, code);
        assert.strictEqual(fx.store.jobs[0].errorCode, code, code);
    }
});

test('graph_throttled and graph_unavailable keep the job claimable with backoff', async () => {
    for (const code of ['graph_throttled', 'graph_unavailable']) {
        resetFx();
        fx.lookupError = coded('Microsoft Graph is throttling requests', code);
        await seeded();
        await auto.processDue();
        const job = fx.store.jobs[0];
        assert.strictEqual(job.status, 'pending', code);
        assert.strictEqual(job.errorCode, null, code);
        assert.ok(job.backoffMs > 0, code);
    }
});

test('a transient lookup failure keeps the job claimable with backoff', async () => {
    fx.lookupError = new Error('Graph 503');
    await seeded();
    await auto.processDue();
    const job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'pending');
    assert.ok(job.backoffMs > 0);
});

test('ingest: classified codes freeze, other failures retry three times', async () => {
    fx.recordings = [{ id: 'R1' }];
    fx.ingestError = coded('too big', 'recording_too_large');
    await seeded();
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'recording_too_large');

    resetFx();
    fx.recordings = [{ id: 'R1' }];
    fx.ingestError = new Error('provider down');
    const job = await seeded();
    for (let i = 0; i < 3; i++) {
        fx.store.jobs[0].nextAttemptAt = new Date(0).toISOString();
        await auto.processDue();
    }
    assert.strictEqual(fx.store.jobs[0].status, 'failed');
    assert.match(fx.store.jobs[0].lastError, /^attempt 3\/3:/);
    assert.strictEqual(fx.ingestCalls.length, 3);
    assert.ok(job);
});

test('claim time: an opt-out made after seeding wins; no credential parks the job', async () => {
    fx.recordings = [{ id: 'R1' }];
    await seeded();
    fx.prefs['event:ev1'] = false;
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'skipped');

    resetFx();
    await seeded();
    fx.authByUser = {};
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'needs_reauth');
});

test('processJobInline (manual route): pending while Teams is still processing', async () => {
    const job = await seeded();
    const out = await auto.processJobInline({ job, session: { userId: 'u1' }, language: 'en', contextTerms: 'AFAS' });
    assert.deepStrictEqual(out, { pending: true, status: 'awaiting_artifacts' });
    fx.recordings = [{ id: 'R1' }];
    const done = await auto.processJobInline({ job: { ...fx.store.jobs[0] }, session: { userId: 'u1' }, language: 'en', contextTerms: 'AFAS' });
    assert.strictEqual(done.transcription.id, 't-new');
    assert.strictEqual(fx.ingestCalls[0].language, 'en');
    assert.strictEqual(fx.ingestCalls[0].contextTerms, 'AFAS');
});

// ── Bounded lookups, claim-time entitlement, manual imports ───────────

test('a lookup that keeps failing freezes as failed once the meeting is past the deadline', async () => {
    await seeded({ meetingStart: hoursAgo(30 * 24 + 1), meetingEnd: hoursAgo(30 * 24) });
    // A meeting deleted after it was found: Graph answers 404 for good.
    fx.lookupError = coded('gone', 'not_found');
    await auto.processDue();
    const job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.errorCode, 'failed');
    assert.match(job.lastError, /gone/);
});

test('a recent meeting whose lookup fails still retries with backoff', async () => {
    await seeded();
    fx.lookupError = coded('Graph 503', 'failed');
    await auto.processDue();
    const job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'pending');
    assert.strictEqual(job.errorCode, null);
});

test('NOT_CONNECTED from the Graph client parks the job as needs_reauth instead of retrying forever', async () => {
    await seeded();
    fx.lookupError = new Error('NOT_CONNECTED');
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'needs_reauth');
});

test('a job whose owner was deactivated after seeding is skipped, not ingested', async () => {
    await seeded();
    fx.recordings = [{ id: 'R1' }];
    fx.usersById.u1 = { id: 'u1', organizationId: 'orgA', status: 'suspended' };
    await auto.processDue();
    assert.strictEqual(fx.ingestCalls.length, 0);
    assert.strictEqual(fx.store.jobs[0].status, 'skipped');
});

test('a failed owner lookup at claim time leaves the job for the next claim, never skipped', async () => {
    await seeded();
    fx.recordings = [{ id: 'R1' }];
    fx.userLookupError = new Error('connection terminated');
    try { await auto.processDue(); } finally { fx.userLookupError = null; }
    assert.strictEqual(fx.ingestCalls.length, 0);
    assert.notStrictEqual(fx.store.jobs[0].status, 'skipped');
});

test('a job whose owner lost the Meeting Notes licence after seeding is skipped, not ingested', async () => {
    await seeded();
    fx.recordings = [{ id: 'R1' }];
    fx.entitled.u1 = false;
    await auto.processDue();
    assert.strictEqual(fx.ingestCalls.length, 0);
    assert.strictEqual(fx.store.jobs[0].status, 'skipped');
});

test('a manual import that had to wait for Teams is finished by the poller even with autoImport off', async () => {
    fx.settingsByUser.u1 = { autoImport: false };
    const job = await seeded();
    fx.store.jobs[0].requestedByUser = true;
    const first = await auto.processJobInline({ job, session: { accessToken: 'at' }, manual: true });
    assert.deepStrictEqual(first, { pending: true, status: 'awaiting_artifacts' });
    fx.recordings = [{ id: 'R1' }];
    fx.store.jobs[0].nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    await auto.processDue();
    assert.strictEqual(fx.ingestCalls.length, 1);
    assert.strictEqual(fx.store.jobs[0].status, 'ingested');
});

test('a manual import that fails is final with its own code, not a silent background retry', async () => {
    const job = await seeded();
    fx.recordings = [{ id: 'R1' }];
    fx.ingestError = coded('download broke', 'download_failed');
    await assert.rejects(auto.processJobInline({ job, session: { accessToken: 'at' }, manual: true }), (e) => e.code === 'download_failed');
    assert.strictEqual(fx.store.jobs[0].status, 'download_failed');
    assert.strictEqual(fx.store.jobs[0].errorCode, 'download_failed');
});

test('already_imported freezes the job instead of three pointless retries', async () => {
    await seeded();
    fx.recordings = [{ id: 'R1' }];
    fx.ingestError = coded('someone else imported it', 'already_imported');
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'already_imported');
});

test('declined invitees and rooms are no attendees: not shared with, not speaker candidates', async () => {
    await seeded();
    fx.recordings = [{ id: 'R1' }];
    fx.graphAttendees = [
        { emailAddress: { address: 'an@x.nl', name: 'An' }, status: { response: 'accepted' }, type: 'required' },
        { emailAddress: { address: 'bob@x.nl', name: 'Bob' }, status: { response: 'declined' }, type: 'required' },
        { emailAddress: { address: 'room1@x.nl', name: 'Room 1.01' }, status: { response: 'accepted' }, type: 'resource' },
    ];
    await auto.processDue();
    assert.deepStrictEqual(fx.ingestCalls[0].attendees.map((a) => a.email), ['an@x.nl']);
    assert.deepStrictEqual(fx.graphPaths, ['/me/events/ev1?$select=attendees'], 'a delegated session reads /me');
});

test('the attendee lookup honours the session\'s Graph user path (option B seam)', async () => {
    const job = await seeded();
    fx.recordings = [{ id: 'R1' }];
    const oid = '0f0e0d0c-0b0a-4908-8706-050403020100';
    await auto.processJobInline({ job, session: { accessToken: 'at', graphUserPath: `/users/${oid}` } });
    assert.deepStrictEqual(fx.graphPaths, [`/users/${oid}/events/ev1?$select=attendees`]);

    // A path that is not /users/<guid> is refused: no Graph call, no attendees, the import still runs.
    fx.graphPaths = [];
    fx.ingestCalls = [];
    const job2 = await seeded({ calendarEventId: 'ev2' });
    await auto.processJobInline({ job: job2, session: { accessToken: 'at', graphUserPath: '/users/someone@fixture.test' } });
    assert.deepStrictEqual(fx.graphPaths, []);
    assert.deepStrictEqual(fx.ingestCalls[0].attendees, []);
});

test('the meeting start reaches the ingest (deadlines resolve against the meeting date)', async () => {
    const job = await seeded();
    fx.recordings = [{ id: 'R1' }];
    await auto.processDue();
    assert.strictEqual(fx.ingestCalls[0].meetingStart, job.meetingStart);
});

test('a recording stopped and restarted: the ingest learns how many other parts exist', async () => {
    await seeded({ meetingStart: '2026-11-03T09:00:00Z', meetingEnd: '2026-11-03T11:00:00Z' });
    fx.recordings = [
        { id: 'R1', createdDateTime: '2026-11-03T09:01:00Z', endDateTime: '2026-11-03T10:10:00Z' },
        { id: 'R2', createdDateTime: '2026-11-03T10:40:00Z', endDateTime: '2026-11-03T10:59:00Z' },
    ];
    await auto.processDue();
    assert.strictEqual(fx.ingestCalls[0].artifact.extraRecordings, 1);
});

// ── option B: the organisation app token ─────────────────────────────

const T = '11111111-2222-3333-4444-555555555555';
const OTHER_TENANT = '99999999-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-0000-0000-0000-000000000001';
const B_CONFIG = { providers: { microsoft: { clientId: 'cccccccc-0000-0000-0000-000000000001', clientSecret: 'fixture-not-a-secret', tenantId: 'common' } } };
const B_ROLES = ['OnlineMeetings.Read.All', 'OnlineMeetingRecording.Read.All', 'Calendars.Read', 'OnlineMeetingTranscript.Read.All'];

/**
 * The real coverage and app-token modules over the poller's fakes: orgA is
 * switched on for tenant T (coverage 'all'); u1 is a member of orgA with a
 * verified identity in T and no delegated credential. `fx.b` holds what the
 * stores and Entra answer.
 */
function useRealAppImport() {
    const coverage = require('./teamsAppImport/coverage.mts');
    const appToken = require('./teamsAppImport/appToken.mts');
    fx.authByUser = {};
    fx.usersById.u1 = { id: 'u1', organizationId: 'orgA', status: 'active', azureTenantId: T, azureUserId: OID };
    fx.b = {
        settings: { orgA: { enabled: true, coverage: 'all', selectedUserIds: [], tenantId: T, enabledAt: null, enabledBy: null, updatedAt: null, updatedBy: null } },
        tenants: { orgA: { ok: true, tenantId: T, source: 'directory_binding' } },
        roles: B_ROLES,
        tokenRequests: [],
        settingsReads: [],
        tokenFails: false,
    };
    const orgTenant = async (orgId) => fx.b.tenants[orgId] || { ok: false, reason: 'tenant_not_bound' };
    coverage.init({
        readSettings: async (orgId, opts) => {
            fx.b.settingsReads.push(opts);
            return fx.b.settings[orgId] || { enabled: false, coverage: 'selected', selectedUserIds: [], tenantId: null };
        },
        orgTenant,
        getUser: async (id) => fx.usersById[id] || null,
        loadConfig: async () => B_CONFIG,
        hasCapability: async (_c, { userId }) => fx.entitled[userId] !== false,
        log: { warn: () => {} },
    });
    appToken.init({
        loadConfig: async () => B_CONFIG,
        orgTenant,
        requestToken: async (req) => {
            fx.b.tokenRequests.push(req.tenantId);
            if (fx.b.tokenFails) return { ok: false, kind: 'entra', httpStatus: 401, error: 'invalid_client', aadsts: 7000222 };
            return { ok: true, accessToken: 'fixture-access-token', expiresAt: Date.now() + 3600_000, roles: fx.b.roles, tokenTenantId: T };
        },
        log: { warn: () => {} },
    });
    fx.appImpl = appToken;
}

test.afterEach(() => {
    require('./teamsAppImport/coverage.mts').init();
    require('./teamsAppImport/appToken.mts').init();
});

test('option B: a connected user keeps the delegated path, the app import is never asked', async () => {
    fx.ended = [endedMeeting()];
    fx.recordings = [{ id: 'R1' }];
    await auto.discover();
    await auto.processDue();
    assert.strictEqual(fx.appCalls.length, 0);
    assert.strictEqual(fx.endedSessions[0].graphUserPath, undefined, 'the vault session, on /me');
    assert.strictEqual(fx.ingestCalls[0].session.graphUserPath, undefined);
});

test('option B: a covered user without a credential is discovered and imported with the app session', async () => {
    useRealAppImport();
    fx.ended = [endedMeeting()];
    fx.recordings = [{ id: 'R1' }];
    fx.skips.set('u1', { reason: 'no_credential' });
    await auto.discover();
    assert.deepStrictEqual(fx.endedSessions[0], { accessToken: 'fixture-access-token', graphUserPath: `/users/${OID}`, appOnly: true });
    assert.strictEqual(fx.store.jobs.length, 1);
    assert.strictEqual(fx.skips.has('u1'), false, 'the skip state is cleared');
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'ingested');
    assert.strictEqual(fx.ingestCalls[0].session.graphUserPath, `/users/${OID}`);
    assert.deepStrictEqual(fx.graphPaths, [`/users/${OID}/events/ev1?$select=attendees`]);
    assert.deepStrictEqual(fx.b.tokenRequests, [T], 'one token request at the organisation tenant, reused at claim');
    assert.deepStrictEqual(fx.appCalls.map((c) => c.opts), [{}, { fresh: true }], 'claim time reads past every cache');
    assert.deepStrictEqual(fx.b.settingsReads[1], { fresh: true });
});

test('option B: the transcript fallback follows the token roles', async () => {
    useRealAppImport();
    fx.transcripts = [{ id: 'T1' }];
    await seeded();
    await auto.processDue();
    assert.deepStrictEqual(fx.ingestCalls[0].artifact, { kind: 'transcript', id: 'T1' });

    resetFx();
    useRealAppImport();
    fx.b.roles = ['OnlineMeetings.Read.All', 'OnlineMeetingRecording.Read.All', 'Calendars.Read'];
    fx.transcripts = [{ id: 'T1' }];
    await seeded();
    await auto.processDue();
    assert.strictEqual(fx.ingestCalls.length, 0);
    assert.strictEqual(fx.store.jobs[0].status, 'awaiting_artifacts');
});

test('option B: a token Microsoft refuses is remembered as app_token_failed, nothing is seeded', async () => {
    useRealAppImport();
    fx.b.tokenFails = true;
    fx.ended = [endedMeeting()];
    await auto.discover();
    assert.strictEqual(fx.skipWrites.at(-1).reason, 'app_token_failed');
    assert.strictEqual(fx.endedCalls, 0);
    assert.strictEqual(fx.store.jobs.length, 0);
});

test('option B: a member of another organisation that shares the tenant is never covered', async () => {
    useRealAppImport();
    fx.users = [{ id: 'u2', organizationId: 'orgB' }];
    fx.configAll = { user_teams_notes_u2: {} };
    fx.settingsByUser = { u2: { autoImport: true } };
    fx.usersById.u2 = { id: 'u2', organizationId: 'orgB', status: 'active', azureTenantId: T, azureUserId: 'bbbbbbbb-0000-0000-0000-000000000002' };
    fx.ended = [endedMeeting()];
    await auto.discover();
    assert.strictEqual(fx.endedCalls, 0, 'orgB has no app import; orgA covering tenant T does not reach it');
    assert.strictEqual(fx.skipWrites.at(-1).reason, 'no_credential');

    // A job that names orgA for a member of orgB (stale or forged): refused at claim.
    await fx.store.seedJob({ userId: 'u2', orgId: 'orgA', calendarEventId: 'evx', joinUrl: 'https://teams.microsoft.com/l/x', meetingStart: hoursAgo(2), meetingEnd: hoursAgo(1.5) });
    fx.recordings = [{ id: 'R1' }];
    await auto.processDue();
    assert.strictEqual(fx.ingestCalls.length, 0);
    assert.strictEqual(fx.store.jobs[0].status, 'needs_reauth');
    assert.deepStrictEqual(fx.b.tokenRequests, [], 'no app token was even asked for');
});

test('option B: coverage is re-checked at claim (removed member, other tenant, switched off, tenant moved)', async () => {
    const cases = {
        'removed from the organisation': () => { fx.usersById.u1 = { ...fx.usersById.u1, organizationId: 'orgC' }; },
        'identity from another tenant': () => { fx.usersById.u1 = { ...fx.usersById.u1, azureTenantId: OTHER_TENANT }; },
        'switched off after discovery': () => { fx.b.settings.orgA = { ...fx.b.settings.orgA, enabled: false }; },
        'tenant link moved': () => { fx.b.tenants.orgA = { ok: true, tenantId: OTHER_TENANT, source: 'directory_binding' }; },
        'no longer selected': () => { fx.b.settings.orgA = { ...fx.b.settings.orgA, coverage: 'selected', selectedUserIds: ['someone-else'] }; },
    };
    for (const [name, change] of Object.entries(cases)) {
        resetFx();
        useRealAppImport();
        fx.ended = [endedMeeting()];
        await auto.discover();
        assert.strictEqual(fx.store.jobs.length, 1, `${name}: seeded while covered`);
        change();
        fx.recordings = [{ id: 'R1' }];
        await auto.processDue();
        assert.strictEqual(fx.ingestCalls.length, 0, `${name}: not imported`);
        assert.strictEqual(fx.store.jobs[0].status, 'needs_reauth', `${name}: parked as without a credential`);
    }
});

test('option B: a deactivated user or a revoked capability at claim is skipped before any token', async () => {
    for (const change of [() => { fx.usersById.u1 = { ...fx.usersById.u1, status: 'disabled' }; }, () => { fx.entitled.u1 = false; }]) {
        resetFx();
        useRealAppImport();
        await seeded();
        fx.recordings = [{ id: 'R1' }];
        change();
        await auto.processDue();
        assert.strictEqual(fx.ingestCalls.length, 0);
        assert.strictEqual(fx.store.jobs[0].status, 'skipped');
        assert.deepStrictEqual(fx.b.tokenRequests, []);
    }
});

test('option B does not imply auto-import: with it off, only a marked meeting is imported, and an opt-out wins', async () => {
    useRealAppImport();
    fx.settingsByUser.u1 = { autoImport: false };
    fx.ended = [endedMeeting(), endedMeeting({ eventId: 'ev2' })];
    await auto.discover();
    assert.strictEqual(fx.endedCalls, 0, 'not a candidate without a mark');
    fx.prefs['event:ev2'] = true;
    await auto.discover();
    assert.deepStrictEqual(fx.store.jobs.map((j) => j.calendarEventId), ['ev2']);
    fx.prefs['event:ev2'] = false;
    fx.recordings = [{ id: 'R1' }];
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'skipped');
});

test('option B: an unexpected failure deciding coverage is a refusal', async () => {
    fx.appImpl = { resolveAppImportSession: async () => { throw new Error('config store down'); } };
    fx.authByUser = {};
    fx.ended = [endedMeeting()];
    await auto.discover();
    assert.strictEqual(fx.endedCalls, 0);
    await seeded();
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'needs_reauth');
});
