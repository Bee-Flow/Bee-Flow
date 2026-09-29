/**
 * gmeetAutoImport tests — the Google Meet auto-import poller.
 *
 * Covers: discovery seeding (organizer scope, exclusions, scope/entitlement
 * skips, org-doc candidate expansion, needs_reauth unparking), the per-job
 * pipeline status transitions (awaiting_artifacts → ingested), the backoff
 * schedule, the 24h/48h deadlines, classified terminal failures, needs_reauth
 * parking, claim-time exclusion flips, the org-level duplicate claim and the
 * processJobInline pending/manual paths.
 *
 * Every dependency (gmeetImportStore, configStore/userStore, settings,
 * calendar, artifacts, ingest, routineAuth, entitlements) is stubbed via the
 * Module resolve hook; the job store is an in-memory fake mirroring the real
 * store's semantics.
 *
 * Run: cd server && node --test core/meetingNotes/gmeetAutoImport.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const MEET_SCOPE = 'openid email https://www.googleapis.com/auth/meetings.space.readonly';

// ── In-memory gmeet_import_jobs fake (mirrors gmeetImportStore semantics) ──
function makeJobStore() {
    const jobs = [];
    let seq = 0;
    const byId = (id) => jobs.find((j) => j.id === id);
    return {
        jobs,
        async seedJob(row) {
            if (row.calendarEventId && jobs.some((j) => j.userId === row.userId && j.calendarEventId === row.calendarEventId)) return null;
            if (row.conferenceRecord && jobs.some((j) => j.userId === row.userId && j.conferenceRecord === row.conferenceRecord)) return null;
            if (row.conferenceRecord && row.orgId && jobs.some((j) => j.orgId === row.orgId && j.conferenceRecord === row.conferenceRecord)) return null;
            const job = {
                id: `job-${++seq}`,
                orgId: null, calendarEventId: null, icalUid: null,
                spaceName: null, conferenceRecord: null, title: null,
                meetingStart: null, meetingEnd: null, preferred: false,
                status: 'pending', errorCode: null, lastError: null, attempts: 0,
                nextAttemptAt: new Date().toISOString(), transcriptionId: null,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                ...row,
            };
            jobs.push(job);
            return { ...job };
        },
        async claimDueJobs(limit = 2) {
            const now = Date.now();
            const due = jobs
                .filter((j) => ['pending', 'awaiting_artifacts'].includes(j.status)
                    && new Date(j.nextAttemptAt).getTime() <= now)
                .sort((a, b) => (b.preferred - a.preferred)
                    || (new Date(a.nextAttemptAt) - new Date(b.nextAttemptAt)))
                .slice(0, limit);
            for (const j of due) j.nextAttemptAt = new Date(now + 600_000).toISOString(); // lease
            return due.map((j) => ({ ...j }));
        },
        async heartbeatJob(id, minutes = 10) {
            const j = byId(id);
            if (!j) return false;
            j.nextAttemptAt = new Date(Date.now() + minutes * 60_000).toISOString();
            j.heartbeats = (j.heartbeats || 0) + 1;
            return true;
        },
        async attachConferenceRecord(id, { spaceName = null, conferenceRecord }) {
            const j = byId(id);
            if (!j) return null;
            const clash = jobs.some((o) => o.id !== id && o.conferenceRecord === conferenceRecord
                && ((o.userId === j.userId) || (o.orgId && j.orgId && o.orgId === j.orgId)));
            if (clash) return { duplicate: true };
            if (spaceName) j.spaceName = spaceName;
            j.conferenceRecord = conferenceRecord;
            return { ...j };
        },
        async updateJob(id, fields) {
            const j = byId(id);
            if (!j) return false;
            for (const k of ['status', 'errorCode', 'lastError', 'attempts', 'nextAttemptAt', 'transcriptionId', 'title', 'meetingStart', 'meetingEnd', 'spaceName', 'conferenceRecord', 'preferred', 'icalUid']) {
                if (fields[k] !== undefined) j[k] = fields[k];
            }
            return true;
        },
        async completeJob(id, transcriptionId) {
            const j = byId(id);
            if (!j) return false;
            Object.assign(j, { status: 'ingested', transcriptionId, errorCode: null, lastError: null });
            return true;
        },
        async failJob(id, { errorCode = null, lastError = null, terminal = false, backoffMs = 0, status = null } = {}) {
            fx.failCalls.push({ id, errorCode, lastError, terminal, backoffMs, status });
            const j = byId(id);
            if (!j) return false;
            j.attempts += 1;
            if (terminal) {
                Object.assign(j, { status: errorCode || 'failed', errorCode, lastError });
            } else {
                if (status) j.status = status;
                Object.assign(j, { errorCode, lastError });
                j.nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
            }
            return true;
        },
        async parkNeedsReauth(id, nextAttemptAt) {
            fx.parkCalls.push({ id, nextAttemptAt });
            const j = byId(id);
            if (!j) return false;
            Object.assign(j, { status: 'needs_reauth', errorCode: 'needs_reauth', nextAttemptAt });
            return true;
        },
        async listRecentJobsForUser(userId) {
            return jobs.filter((j) => j.userId === userId).map((j) => ({ ...j }));
        },
        async getJob(id) {
            const j = byId(id);
            return j ? { ...j } : null;
        },
    };
}

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {};

function resetFx() {
    fx.store = makeJobStore();
    fx.configAll = { user_gmeet_notes_u1: {} };
    fx.usersById = { u1: { id: 'u1', organizationId: 'orgA' } };
    fx.users = [{ id: 'u1', organizationId: 'orgA' }];
    fx.settingsByOrg = {};
    fx.settingsByUser = { u1: { autoImport: true } };
    fx.entitled = {};                    // userId → false to deny (default: allow)
    fx.authByUser = {
        u1: { userId: 'u1', orgId: 'orgA', accessToken: 'at-u1', refreshToken: 'rt-u1', expiresAt: Date.now() + 3600_000, scope: MEET_SCOPE },
    };
    fx.endedByUser = {};                 // session.userId → meetings
    fx.spaces = {};                      // meetingCode → space | null
    fx.conferenceRecord = null;          // findConferenceRecord result
    fx.recording = { notReady: true };   // findGeneratedRecording result
    fx.ingestResult = { id: 't-new', title: 'AI titel' };
    fx.ingestError = null;
    fx.existingByUri = {};
    fx.vaultWrites = [];
    fx.authCalls = [];
    fx.capCalls = [];
    fx.calendarCalls = [];
    fx.findRecordCalls = [];
    fx.recordingCalls = [];
    fx.ingestCalls = [];
    fx.failCalls = [];
    fx.parkCalls = [];
    fx.prefs = {};                       // 'kind:id' → true | false (meeting_prefs)
    fx.prefLoads = [];                   // scope waarmee de prefs geladen zijn
    fx.orgPrefs = {};                    // ORG-brede rijen: alleen zichtbaar mét orgId
}
resetFx();

const SETTINGS_DEFAULTS = {
    autoImport: false, autoRecordConfig: false, importScope: 'organizer',
    language: 'nl', lookbackHours: 24, excludedEventIds: [], excludedMeetingCodes: [],
};

const MOCKS = {
    '../../stores/gmeetImportStore': {
        seedJob: (...a) => fx.store.seedJob(...a),
        claimDueJobs: (...a) => fx.store.claimDueJobs(...a),
        heartbeatJob: (...a) => fx.store.heartbeatJob(...a),
        attachConferenceRecord: (...a) => fx.store.attachConferenceRecord(...a),
        updateJob: (...a) => fx.store.updateJob(...a),
        completeJob: (...a) => fx.store.completeJob(...a),
        failJob: (...a) => fx.store.failJob(...a),
        parkNeedsReauth: (...a) => fx.store.parkNeedsReauth(...a),
        listRecentJobsForUser: (...a) => fx.store.listRecentJobsForUser(...a),
        getJob: (...a) => fx.store.getJob(...a),
    },
    '../../stores/configStore': {
        getAllConfig: async () => fx.configAll,
    },
    '../../stores/userStore': {
        getUser: async (id) => fx.usersById[id] || null,
        getAllUsers: async () => fx.users,
    },
    // meeting_prefs (M5) — de per-vergadering keuze. De echte beslislogica
    // (unie-versmalling, 1-op-1-standaard) ligt vast in
    // stores/meetingPrefsStore.test.js; hier telt of de poller hem raadpleegt
    // met de juiste scope en identiteiten, en zijn antwoord respecteert.
    '../../stores/meetingPrefsStore': {
        gmeetIds: ({ eventId = null, meetingCode = null } = {}) => [
            { kind: 'event', id: eventId }, { kind: 'code', id: meetingCode },
        ].filter((x) => typeof x.id === 'string' && x.id),
        participantCountOf: (m) => {
            if (!m || !Array.isArray(m.attendees)) return null;
            const ids = new Set(m.attendees.map((a) => String(a?.email || a?.cn || '').toLowerCase()).filter(Boolean));
            if (m.organizerEmail) ids.add(String(m.organizerEmail).toLowerCase());
            return ids.size || null;
        },
        loadMeetingPrefs: async ({ provider, userId, orgId }) => {
            fx.prefLoads.push({ provider, userId, orgId });
            // De echte store schrijft een ORG-brede uitsluiting als rij met
            // `user_id = ''` en leest die alleen via de org-tak van listPrefs.
            // Deze dubbel doet hetzelfde: zonder `orgId` is `fx.orgPrefs`
            // onzichtbaar. Anders zou het weglaten van de org-scope in de
            // aanroeper nergens rood worden, terwijl juist dán een org-brede
            // uitsluiting als "geen mening" leest — de FALSE→TRUE die deze
            // verhuizing niet mag maken.
            // EEN FALSE WINT, uit welke rij hij ook komt — de user-rij
            // overschrijft de org-rij niet, zoals `resolvePrefs` het ook niet doet.
            const scopes = orgId ? [fx.orgPrefs, fx.prefs] : [fx.prefs];
            const opinionFor = (ids) => {
                const seen = ids.flatMap(({ kind, id }) => scopes.map(m => m[`${kind}:${id}`]));
                if (seen.includes(false)) return false;
                if (seen.includes(true)) return true;
                return null;
            };
            return {
                opinionFor,
                decide: ({ ids, participantCount = null, fallback = false }) => {
                    const o = opinionFor(ids);
                    if (o !== null) return { record: o, reason: o ? 'opted_in' : 'opted_out' };
                    if (!(typeof participantCount === 'number' && participantCount > 2)) {
                        return { record: false, reason: participantCount === null ? 'unknown_size' : 'small_meeting' };
                    }
                    return fallback ? { record: true, reason: 'auto' } : { record: false, reason: 'auto_off' };
                },
            };
        },
    },
    '../../stores/transcriptionStore': {
        getTranscriptionBySourceUri: async (uri) => fx.existingByUri[uri] || null,
    },
    '../../stores/routineCredentialStore': {
        upsertCredential: async (row) => { fx.vaultWrites.push(row); },
    },
    '../../auth/routineAuth': {
        getProviderAuth: async (userId, provider) => {
            fx.authCalls.push({ userId, provider });
            return fx.authByUser[userId] || null;
        },
    },
    '../entitlements/entitlements': {
        hasCapability: async (capId, { userId, orgId } = {}) => {
            fx.capCalls.push({ capId, userId, orgId });
            return fx.entitled[userId] !== false;
        },
    },
    './gmeetNotesSettings': {
        resolveGmeetNotesSettings: async ({ orgId = null, userId = null } = {}) => ({
            ...SETTINGS_DEFAULTS,
            ...(orgId ? fx.settingsByOrg[orgId] : null),
            ...(userId ? fx.settingsByUser[userId] : null),
        }),
        hasMeetScopes: (scope) => String(scope || '').includes('meetings.space.readonly'),
    },
    './gmeetCalendar': {
        listRecentlyEndedMeetMeetings: async ({ session, lookbackHours, graceMinutes } = {}) => {
            fx.calendarCalls.push({ userId: session?.userId, lookbackHours, graceMinutes });
            return fx.endedByUser[session?.userId] || [];
        },
    },
    './gmeetArtifacts': {
        getSpaceByMeetingCode: async (session, meetingCode) => fx.spaces[meetingCode] || null,
        findConferenceRecord: async (session, args) => {
            fx.findRecordCalls.push(args);
            return fx.conferenceRecord;
        },
        findGeneratedRecording: async (session, conferenceRecordName) => {
            fx.recordingCalls.push(conferenceRecordName);
            return fx.recording;
        },
    },
    './ingestGmeetRecording': {
        ingestGmeetRecording: async (args) => {
            fx.ingestCalls.push(args);
            if (fx.ingestError) throw fx.ingestError;
            return fx.ingestResult;
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:gmeetautoimport:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /meetingNotes[\\/]gmeetAutoImport\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { discover, processDue, processJobInline } = require('./gmeetAutoImport');

test.after(() => {
    Module._resolveFilename = originalResolve;
});

function endedMeeting(overrides = {}) {
    const end = new Date(Date.now() - 60 * 60_000);
    const start = new Date(end.getTime() - 30 * 60_000);
    return {
        eventId: 'ev1', iCalUID: 'ical-ev1', title: 'Weekly sync',
        start: start.toISOString(), end: end.toISOString(),
        organizerEmail: 'tom@beeflow.nl', organizerSelf: true,
        // Drie deelnemers: onder de 1-op-1-standaard (M5) wordt een gesprek met
        // ten hoogste twee mensen niet vanzelf geïmporteerd.
        attendees: [
            { email: 'sanne@beeflow.nl', displayName: 'Sanne Jansen', self: false },
            { email: 'ines@beeflow.nl', displayName: 'Ines de Vries', self: false },
        ],
        meetingCode: 'abc-defg-hij', meetLink: 'https://meet.google.com/abc-defg-hij',
        ...overrides,
    };
}

async function seedClaimable({ userId = 'u1', orgId = 'orgA', eventId = 'ev1', meetingCode = 'abc-defg-hij', endedMinAgo = 60, preferred = true } = {}) {
    const end = new Date(Date.now() - endedMinAgo * 60_000);
    const start = new Date(end.getTime() - 30 * 60_000);
    return fx.store.seedJob({
        userId, orgId, calendarEventId: eventId, icalUid: `ical-${eventId}`,
        meetingCode, title: 'Weekly sync',
        meetingStart: start.toISOString(), meetingEnd: end.toISOString(),
        preferred,
    });
}

function readyArtifacts() {
    fx.spaces['abc-defg-hij'] = { name: 'spaces/sp1' };
    fx.conferenceRecord = { name: 'conferenceRecords/cr1' };
}

// ── Discovery ────────────────────────────────────────────────────────

test('een ORG-brede uitsluiting stopt de discovery — de org-scope reist mee', async () => {
    // Dit was het gat: `orgId` → `null` op de discovery-lees liet de hele
    // suite groen. De backfill schrijft een org-brede uitsluiting als rij met
    // `user_id = ''`, en die is alleen via de org-tak van listPrefs bereikbaar;
    // valt die weg, dan leest zo'n uitsluiting als "geen mening" en wordt er
    // geïmporteerd wat een beheerder had uitgezet.
    resetFx();
    fx.settingsByUser.u1 = { autoImport: true, importScope: 'organizer' };
    fx.orgPrefs['code:abc-defg-hij'] = false;
    fx.endedByUser.u1 = [endedMeeting()];

    await discover();

    assert.strictEqual(fx.store.jobs.length, 0, 'de org zette deze serie uit');
    assert.deepStrictEqual(fx.prefLoads[0], { provider: 'gmeet', userId: 'u1', orgId: 'orgA' },
        'de discovery leest met de eigen gebruiker ÉN zijn org');
});

test('een ORG-brede uitsluiting wint ook bij het claimen', async () => {
    resetFx();
    await seedClaimable({ eventId: 'ev1', meetingCode: 'abc-defg-hij' });
    fx.settingsByUser.u1 = { autoImport: true };
    fx.orgPrefs['event:ev1'] = false;
    await processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'skipped');
});

test('discover seeds only ended organizer meetings, honoring exclusions', async () => {
    resetFx();
    fx.settingsByUser.u1 = { autoImport: true, importScope: 'organizer' };
    // De uitsluiting staat nu in meeting_prefs: per occurrence én per serie.
    fx.prefs['event:ev-excl'] = false;
    fx.prefs['code:zzz-zzzz-zzz'] = false;
    fx.endedByUser.u1 = [
        endedMeeting(),
        endedMeeting({ eventId: 'ev2', meetingCode: 'bbb-bbbb-bbb', organizerSelf: false }), // not organizer
        endedMeeting({ eventId: 'ev-excl', meetingCode: 'ccc-cccc-ccc' }),                   // excluded event
        endedMeeting({ eventId: 'ev4', meetingCode: 'zzz-zzzz-zzz' }),                       // excluded series
    ];

    await discover();

    assert.strictEqual(fx.store.jobs.length, 1);
    const job = fx.store.jobs[0];
    assert.strictEqual(job.userId, 'u1');
    assert.strictEqual(job.orgId, 'orgA');
    assert.strictEqual(job.calendarEventId, 'ev1');
    assert.strictEqual(job.icalUid, 'ical-ev1');
    assert.strictEqual(job.meetingCode, 'abc-defg-hij');
    assert.strictEqual(job.preferred, true);
    assert.strictEqual(job.status, 'pending');
    // Entitlement checked with the resolved org; lookback from settings.
    assert.deepStrictEqual(fx.capCalls, [{ capId: 'meeting_notes', userId: 'u1', orgId: 'orgA' }]);
    assert.strictEqual(fx.calendarCalls[0].lookbackHours, 24);
    // Re-discovery is idempotent (unique user+event).
    await discover();
    assert.strictEqual(fx.store.jobs.length, 1);
});

test('discover: calendar scope seeds non-organizer meetings with preferred=false', async () => {
    resetFx();
    fx.settingsByUser.u1 = { autoImport: true, importScope: 'calendar' };
    fx.endedByUser.u1 = [endedMeeting({ organizerSelf: false })];
    await discover();
    assert.strictEqual(fx.store.jobs.length, 1);
    assert.strictEqual(fx.store.jobs[0].preferred, false);
});

test('discover: user without Meet scopes is skipped silently', async () => {
    resetFx();
    fx.authByUser.u1.scope = 'openid email https://www.googleapis.com/auth/drive';
    fx.endedByUser.u1 = [endedMeeting()];
    await discover();
    assert.strictEqual(fx.store.jobs.length, 0);
    assert.strictEqual(fx.calendarCalls.length, 0); // never reached the calendar
});

test('discover: user without the meeting_notes entitlement is skipped', async () => {
    resetFx();
    fx.entitled.u1 = false;
    fx.endedByUser.u1 = [endedMeeting()];
    await discover();
    assert.strictEqual(fx.store.jobs.length, 0);
    assert.strictEqual(fx.authCalls.length, 0); // entitlement gate fires before auth
});

test('discover: org-level autoImport enrolls members without their own doc', async () => {
    resetFx();
    fx.configAll = { org_gmeet_notes_orgA: {} };
    fx.settingsByOrg.orgA = { autoImport: true };
    fx.settingsByUser = {};
    fx.users = [{ id: 'u1', organizationId: 'orgA' }, { id: 'u9', organizationId: 'orgB' }];
    fx.endedByUser.u1 = [endedMeeting()];
    await discover();
    assert.strictEqual(fx.store.jobs.length, 1);
    assert.strictEqual(fx.store.jobs[0].userId, 'u1'); // orgB member not enrolled
});

test('discover: working credential unparks needs_reauth jobs', async () => {
    resetFx();
    const job = await seedClaimable();
    await fx.store.parkNeedsReauth(job.id, new Date(Date.now() + 6 * 3600_000).toISOString());
    fx.endedByUser.u1 = [];
    await discover();
    const unparked = fx.store.jobs[0];
    assert.strictEqual(unparked.status, 'pending');
    assert.strictEqual(unparked.errorCode, null);
    assert.ok(new Date(unparked.nextAttemptAt).getTime() <= Date.now());
});

// ── Per-job pipeline ─────────────────────────────────────────────────

test('happy path: pending → awaiting_artifacts → ingested', async () => {
    resetFx();
    fx.endedByUser.u1 = [endedMeeting()];
    await discover();
    readyArtifacts();

    // First claim: recording not generated yet.
    fx.recording = { notReady: true };
    await processDue();
    let job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'awaiting_artifacts');
    assert.strictEqual(job.spaceName, 'spaces/sp1');
    assert.strictEqual(job.conferenceRecord, 'conferenceRecords/cr1');
    assert.strictEqual(job.attempts, 1);
    assert.strictEqual(fx.failCalls[0].backoffMs, 120_000);
    assert.strictEqual(fx.ingestCalls.length, 0);

    // Second claim: file generated → ingest → complete.
    job.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    fx.recording = { recordingName: 'conferenceRecords/cr1/recordings/r1', driveFileId: 'df1' };
    await processDue();
    job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'ingested');
    assert.strictEqual(job.transcriptionId, 't-new');
    assert.strictEqual(job.errorCode, null);

    assert.strictEqual(fx.ingestCalls.length, 1);
    const call = fx.ingestCalls[0];
    assert.strictEqual(call.userId, 'u1');
    assert.strictEqual(call.orgId, 'orgA');
    assert.strictEqual(call.conferenceRecordName, 'conferenceRecords/cr1');
    assert.strictEqual(call.driveFileId, 'df1');
    assert.strictEqual(call.meetingCode, 'abc-defg-hij');
    assert.strictEqual(call.title, 'Weekly sync');
    assert.strictEqual(call.language, 'nl');
    assert.strictEqual(call.session.accessToken, 'at-u1');
    // Attendees re-read from the calendar for the roster/sharing map.
    assert.deepStrictEqual(call.attendees.map((a) => a.email), ['sanne@beeflow.nl', 'ines@beeflow.nl']);

    // The vault session shim writes refreshed tokens back on save().
    call.session.accessToken = 'at-refreshed';
    call.session.save();
    assert.strictEqual(fx.vaultWrites.length, 1);
    assert.strictEqual(fx.vaultWrites[0].userId, 'u1');
    assert.strictEqual(fx.vaultWrites[0].orgId, 'orgA');
    assert.strictEqual(fx.vaultWrites[0].provider, 'google');
    assert.strictEqual(fx.vaultWrites[0].accessToken, 'at-refreshed');
});

test('backoff schedule: [2,5,10,20,40]min then hourly, attempts-indexed', async () => {
    resetFx();
    await seedClaimable();
    readyArtifacts();
    fx.recording = { notReady: true };

    const expected = [120_000, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000];
    for (let i = 0; i < expected.length; i++) {
        fx.store.jobs[0].nextAttemptAt = new Date(Date.now() - 1000).toISOString();
        await processDue();
    }
    assert.deepStrictEqual(fx.failCalls.map((c) => c.backoffMs), expected);
    assert.ok(fx.failCalls.every((c) => !c.terminal && c.status === 'awaiting_artifacts'));
    assert.strictEqual(fx.store.jobs[0].attempts, expected.length);
    assert.strictEqual(fx.store.jobs[0].status, 'awaiting_artifacts');
});

test('24h past meeting end without a recording → terminal no_recording', async () => {
    resetFx();
    await seedClaimable({ endedMinAgo: 25 * 60 });
    readyArtifacts();
    fx.recording = { none: true };
    await processDue();
    const job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'no_recording');
    assert.strictEqual(job.errorCode, 'no_recording');
    assert.strictEqual(fx.failCalls[0].terminal, true);
    assert.strictEqual(fx.ingestCalls.length, 0);
});

test('48h past meeting end without a conference record → terminal no_conference', async () => {
    resetFx();
    await seedClaimable({ endedMinAgo: 49 * 60 });
    // No space resolves for the meeting code.
    await processDue();
    const job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'no_conference');
    assert.strictEqual(job.errorCode, 'no_conference');
});

test('Drive 403 during ingest → terminal no_drive_access', async () => {
    resetFx();
    await seedClaimable();
    readyArtifacts();
    fx.recording = { recordingName: 'conferenceRecords/cr1/recordings/r1', driveFileId: 'df1' };
    fx.ingestError = Object.assign(new Error('organizer-only Drive access'), { code: 'no_drive_access' });
    await processDue();
    const job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'no_drive_access');
    assert.strictEqual(job.errorCode, 'no_drive_access');
    assert.strictEqual(job.attempts, 1); // no retries for classified failures
});

test('unclassified ingest errors: retried, terminal failed after 3 attempts', async () => {
    resetFx();
    await seedClaimable();
    readyArtifacts();
    fx.recording = { recordingName: 'conferenceRecords/cr1/recordings/r1', driveFileId: 'df1' };
    fx.ingestError = new Error('whisperx down');
    for (let i = 0; i < 3; i++) {
        fx.store.jobs[0].nextAttemptAt = new Date(Date.now() - 1000).toISOString();
        await processDue();
    }
    const job = fx.store.jobs[0];
    assert.strictEqual(fx.ingestCalls.length, 3);
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.errorCode, 'failed');
    assert.match(job.lastError, /^attempt 3\/3: whisperx down/);
    assert.deepStrictEqual(fx.failCalls.map((c) => c.terminal), [false, false, true]);
});

test('missing credential at claim time → parked needs_reauth (~6h)', async () => {
    resetFx();
    await seedClaimable();
    fx.authByUser = {};
    await processDue();
    const job = fx.store.jobs[0];
    assert.strictEqual(job.status, 'needs_reauth');
    assert.strictEqual(job.errorCode, 'needs_reauth');
    const parkedUntil = new Date(fx.parkCalls[0].nextAttemptAt).getTime();
    assert.ok(Math.abs(parkedUntil - (Date.now() + 6 * 3600_000)) < 60_000);
    assert.strictEqual(fx.ingestCalls.length, 0);
});

test('exclusion flipped after seeding wins at claim time → skipped', async () => {
    resetFx();
    await seedClaimable({ eventId: 'ev1' });
    fx.settingsByUser.u1 = { autoImport: true };
    fx.prefs['event:ev1'] = false;
    await processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'skipped');
    assert.strictEqual(fx.authCalls.length, 0); // settings gate fires before auth
    assert.deepStrictEqual(fx.prefLoads.at(-1), { provider: 'gmeet', userId: 'u1', orgId: 'orgA' },
        'de voorkeur wordt met de eigen scope gelezen, nooit die van een ander');
});

test('bij het claimen telt alleen de EXPLICIETE mening, niet opnieuw de 1-op-1-standaard', async () => {
    resetFx();
    // De jobrij draagt geen deelnemerslijst. Zou processClaimedJob de hele
    // beslissing herhalen, dan las dat als "aantal onbekend" en werd élke job
    // overgeslagen — de import zou volledig stilvallen.
    await seedClaimable({ eventId: 'ev1' });
    fx.settingsByUser.u1 = { autoImport: true };
    readyArtifacts();
    fx.recording = { driveFileId: 'drive-1', recordingName: 'rec-1' };
    await processDue();
    assert.notStrictEqual(fx.store.jobs[0].status, 'skipped');
});

test('autoImport switched off after seeding → skipped', async () => {
    resetFx();
    await seedClaimable();
    fx.settingsByUser.u1 = { autoImport: false };
    await processDue();
    assert.strictEqual(fx.store.jobs[0].status, 'skipped');
});

test('org-level duplicate claim → terminal duplicate, sibling note linked', async () => {
    resetFx();
    // u1's job already owns the conference for orgA.
    await seedClaimable({ userId: 'u1', eventId: 'evA' });
    Object.assign(fx.store.jobs[0], { conferenceRecord: 'conferenceRecords/crX', status: 'ingested' });
    fx.existingByUri['gmeet://orgA/conferenceRecords/crX'] = { id: 't-existing', title: 'Bestaande note' };

    // u2 attended the same meeting (calendar scope, not the organizer).
    fx.settingsByUser.u2 = { autoImport: true, importScope: 'calendar' };
    fx.usersById.u2 = { id: 'u2', organizationId: 'orgA' };
    fx.authByUser.u2 = { userId: 'u2', orgId: 'orgA', accessToken: 'at-u2', refreshToken: 'rt-u2', expiresAt: Date.now() + 3600_000, scope: MEET_SCOPE };
    await seedClaimable({ userId: 'u2', eventId: 'evB', preferred: false });
    readyArtifacts();
    fx.conferenceRecord = { name: 'conferenceRecords/crX' };

    await processDue();
    const jobB = fx.store.jobs[1];
    assert.strictEqual(jobB.status, 'duplicate');
    assert.strictEqual(jobB.transcriptionId, 't-existing');
    assert.strictEqual(fx.ingestCalls.length, 0); // no second download/transcription
});

// ── processJobInline (manual-import route contract) ──────────────────

test('processJobInline: artifacts not ready → { pending, status: awaiting_artifacts }', async () => {
    resetFx();
    const job = await seedClaimable();
    readyArtifacts();
    fx.recording = { notReady: true };
    const out = await processJobInline({ job, session: { accessToken: 'live-tok' } });
    assert.deepStrictEqual(out, { pending: true, status: 'awaiting_artifacts' });
    assert.strictEqual(fx.store.jobs[0].status, 'awaiting_artifacts');
});

test('processJobInline: no conference yet → { pending, status: pending }, spaceName persisted', async () => {
    resetFx();
    const job = await seedClaimable();
    fx.spaces['abc-defg-hij'] = { name: 'spaces/sp1' };
    fx.conferenceRecord = null;
    const out = await processJobInline({ job, session: { accessToken: 'live-tok' } });
    assert.deepStrictEqual(out, { pending: true, status: 'pending' });
    assert.strictEqual(fx.store.jobs[0].spaceName, 'spaces/sp1');
});

test('processJobInline: success returns the saved transcription', async () => {
    resetFx();
    const job = await seedClaimable();
    readyArtifacts();
    fx.recording = { recordingName: 'conferenceRecords/cr1/recordings/r1', driveFileId: 'df1' };
    const out = await processJobInline({ job, session: { accessToken: 'live-tok' } });
    assert.strictEqual(out.transcription.id, 't-new');
    assert.strictEqual(fx.store.jobs[0].status, 'ingested');
    assert.strictEqual(fx.ingestCalls[0].session.accessToken, 'live-tok');
});

test('the lease is extended before the long ingest, so the job is not re-claimed mid-run', async () => {
    // Regression: the claim only leased the job for 10 minutes, but download +
    // transcription + 5-7 LLM passes routinely take longer on a real meeting.
    // The next 120s tick then re-claimed the same job on another replica and
    // ran the whole pipeline again — every copy but the first discarded by the
    // source_uri dedup, after being paid for in full.
    resetFx();
    const job = await seedClaimable();
    readyArtifacts();
    fx.recording = { recordingName: 'conferenceRecords/cr1/recordings/r1', driveFileId: 'df1' };

    await processJobInline({ job, session: { accessToken: 'live-tok' } });

    const row = fx.store.jobs[0];
    assert.ok(row.heartbeats >= 1, 'the lease must be extended before the ingest starts');
    // And it must actually outlast a 10-minute claim lease.
    const leaseMs = new Date(row.nextAttemptAt).getTime() - Date.now();
    assert.ok(leaseMs > 30 * 60_000, `lease should cover a long ingest, got ${Math.round(leaseMs / 60000)}min`);
});

test('a lease-extension failure does not abort the ingest', async () => {
    // The heartbeat is an optimisation. If the DB write fails we would rather
    // risk a duplicate than lose the transcription outright.
    resetFx();
    const job = await seedClaimable();
    readyArtifacts();
    fx.recording = { recordingName: 'conferenceRecords/cr1/recordings/r1', driveFileId: 'df1' };
    fx.store.heartbeatJob = async () => { throw new Error('db blip'); };

    const out = await processJobInline({ job, session: { accessToken: 'live-tok' } });
    assert.strictEqual(out.transcription.id, 't-new');
});

test('processJobInline: classified terminal failures throw with a stable code', async () => {
    resetFx();
    const job = await seedClaimable({ endedMinAgo: 25 * 60 });
    readyArtifacts();
    fx.recording = { none: true };
    await assert.rejects(
        () => processJobInline({ job, session: { accessToken: 'live-tok' } }),
        (err) => err.code === 'no_recording',
    );
    assert.strictEqual(fx.store.jobs[0].status, 'no_recording');
});
