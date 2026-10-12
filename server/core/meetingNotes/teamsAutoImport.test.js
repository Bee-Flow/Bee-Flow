/**
 * teamsAutoImport tests — the Teams auto-import poller.
 *
 * Covers: discovery (organizer-only seeding, opt-in, licence and scope skips,
 * per-meeting opt-out, unparking), the per-job pipeline (recording preferred,
 * transcript fallback, transcript switch off = no transcript, waiting with
 * backoff, the 24 h no-recording deadline, not-organizer), ingest retries and
 * terminal codes, claim-time opt-out and needs_reauth parking.
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
    fx.meeting = { id: 'MSo1' };
    fx.recordings = [];
    fx.transcripts = [];
    fx.transcriptError = null;
    fx.lookupError = null;
    fx.prefs = {};
    fx.ingestCalls = [];
    fx.ingestError = null;
    fx.ingestResult = { id: 't-new', title: 'Notitie' };
}
resetFx();

const DEFAULTS = { autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24 };
const auto = require('./teamsAutoImport');
auto.init({
    teamsImportStore: new Proxy({}, { get: (_t, k) => (...a) => fx.store[k](...a) }),
    configStore: { getAllConfig: async () => fx.configAll },
    userStore: {
        getUser: async (id) => fx.usersById[id] || null,
        getAllUsers: async () => fx.users,
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
    automationAuth: { getProviderAuth: async (userId) => fx.authByUser[userId] || null },
    resolveMicrosoftSession: async (s, userId) => (s?.automationProviders?.microsoft ? { userId, accessToken: s.automationProviders.microsoft.accessToken } : null),
    hasCapability: async (_c, { userId }) => fx.entitled[userId] !== false,
    graphFetch: async () => ({ attendees: [{ emailAddress: { address: 'an@x.nl', name: 'An' } }] }),
    resolveTeamsNotesSettings: async ({ orgId = null, userId = null } = {}) => ({
        ...DEFAULTS, ...(orgId ? fx.settingsByOrg[orgId] : null), ...(userId ? fx.settingsByUser[userId] : null),
    }),
    hasTeamsScopes: (scope) => String(scope || '').includes('OnlineMeetingRecording.Read.All'),
    hasTranscriptScope: (scope) => String(scope || '').includes('OnlineMeetingTranscript.Read.All'),
    listRecentlyEndedTeamsMeetings: async () => fx.ended,
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

test('nothing 24 h after the end → terminal no_recording', async () => {
    await seeded({ meetingStart: hoursAgo(30), meetingEnd: hoursAgo(29) });
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'no_recording');
});

test('no onlineMeeting for this account → terminal not_organizer', async () => {
    fx.meeting = null;
    await seeded();
    await auto.processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'not_organizer');
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
