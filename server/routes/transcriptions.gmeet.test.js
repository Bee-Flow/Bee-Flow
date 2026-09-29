/**
 * Google Meet routes in transcriptions.js — gmeet-meetings / gmeet-imports /
 * gmeet-recordings / from-gmeet.
 *
 * Pins the connection resolution (live Google session first, else vault shim),
 * the status-chip mapping (imported | excluded | will_import | upcoming), the
 * PATCH exclusion write + best-effort auto-recording classification (which
 * never fails the PATCH), the manual-import 200/202/classified-4xx paths and —
 * regression against the GET /:id swallow trap — that the three gmeet GET
 * names are in RESERVED_GET_PATHS.
 *
 * Drives the REAL Express router with require-cache-stubbed collaborators
 * (same harness as transcriptions.reprocess.test.js); gmeetAutoImport is
 * stubbed via the Module resolve hook since it may not exist on disk yet.
 *
 * Run: cd server && node --test routes/transcriptions.gmeet.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────────────
const fx = {
    cred: null,                 // routineCredentialStore.getCredential
    providerAuth: null,         // routineAuth.getProviderAuth (vault shim source)
    settings: {},               // resolveGmeetNotesSettings result
    prefs: {},                  // 'kind:id' → true|false (meeting_prefs)
    orgPrefs: {},               // ORG-brede rijen: alleen zichtbaar mét orgId
    prefWrites: [],             // meetingPrefsStore.setRecord spy
    prefLoads: [],              // scope waarmee de prefs geladen zijn
    upcoming: [],               // listUpcomingMeetMeetings
    upcomingCalls: 0,
    recentlyEnded: [],          // listRecentlyEndedMeetMeetings
    spaceByCode: {},            // getSpaceByMeetingCode fixture per code
    conferenceRecord: null,     // findConferenceRecord
    generatedRecording: { none: true }, // findGeneratedRecording
    autoRecordResult: { ok: true },
    autoRecordThrows: false,
    autoRecordCalls: [],
    noteByCode: {},             // meetingCode → { id } (imported-note lookup)
    jobs: [],                   // listRecentJobsForUser
    seeded: [],                 // seedJob spy
    seedResult: undefined,      // override seedJob return (undefined = echo row)
    inline: null,               // processJobInline impl per test
    inlineCalls: [],
};

function resetFx() {
    fx.cred = null;
    fx.providerAuth = null;
    fx.settings = {
        autoImport: false, autoRecordConfig: false, importScope: 'organizer',
        language: 'nl', lookbackHours: 24,
    };
    fx.prefs = {};
    fx.orgPrefs = {};
    fx.prefWrites.length = 0;
    fx.prefLoads.length = 0;
    fx.upcoming = [];
    fx.upcomingCalls = 0;
    fx.recentlyEnded = [];
    fx.spaceByCode = {};
    fx.conferenceRecord = null;
    fx.generatedRecording = { none: true };
    fx.autoRecordResult = { ok: true };
    fx.autoRecordThrows = false;
    fx.autoRecordCalls.length = 0;
    fx.noteByCode = {};
    fx.jobs = [];
    fx.seeded.length = 0;
    fx.seedResult = undefined;
    fx.inline = async () => ({ transcription: { id: 't-new' } });
    fx.inlineCalls.length = 0;
}
resetFx();

// ── Require-cache stubs (before the router loads) ────────────────────────────
function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/transcriptionStore', {
    getTranscription: async () => null,
    getTranscriptionByMeetMeetingCode: async (code) => fx.noteByCode[code] || null,
});
stub('../stores/configStore', { getConfig: async () => null, getSecret: async () => null });
stub('../core/llm/llmClient', {});
stub('../core/meetingNotes/summaryHelpers', {
    resolveSmartModel: () => 'model',
    identifySpeakerNames: async () => null,
    generateMeetingSummary: async () => '',
    generateMeetingTitle: async () => '',
    extractMeetingArtifacts: async () => ({ actionItems: [], decisions: [], questions: [], tags: [] }),
    generateSpeakerSummaries: async () => ({}),
    applySpeakerSummaries: (speakers) => speakers,
    toContextBias: () => [],
    applySpeakerNames: (merged, _m) => ({ merged, transcript: '', speakers: [] }),
    transcribeWithWhisperX: async () => ({ segments: [], text: '' }),
});
stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['orgA']) });
stub('../stores/userStore', { getUser: async () => ({ groups: [] }), getAllGroups: async () => [] });
// Faithful mini-implementations — the real derivation/extraction contracts are
// pinned in gmeetNotesSettings.test.js / gmeetCalendar.test.js.
stub('../core/meetingNotes/gmeetNotesSettings', {
    deriveConnectionStatus: ({ session = null, credential = null } = {}) => {
        const live = !!(session && session.oauthProvider === 'google' && session.accessToken);
        const scope = String((credential && credential.scope) || '');
        return {
            googleConnected: !!(live || (credential && credential.status === 'active')),
            meetScopesGranted: scope.includes('meetings.space.readonly'),
            hasSettingsScope: scope.includes('meetings.space.settings'),
            needsReauth: !!(credential && credential.status === 'needs_reauth'),
        };
    },
    resolveGmeetNotesSettings: async () => ({ ...fx.settings }),
});
// meeting_prefs (M5) — de per-vergadering keuze. De beslislogica zelf ligt vast
// in stores/meetingPrefsStore.test.js; hier telt of de route hem met de eigen
// scope raadpleegt en zijn antwoord in `excluded` + de statuschip vertaalt.
stub('../stores/meetingPrefsStore', {
    gmeetIds: ({ eventId = null, meetingCode = null } = {}) => [
        { kind: 'event', id: eventId }, { kind: 'code', id: meetingCode },
    ].filter((x) => typeof x.id === 'string' && x.id),
    participantCountOf: (m) => {
        if (!m || !Array.isArray(m.attendees)) return null;
        const ids = new Set(m.attendees.map((a) => String(a?.email || a?.cn || '').toLowerCase()).filter(Boolean));
        if (m.organizerEmail) ids.add(String(m.organizerEmail).toLowerCase());
        return ids.size || null;
    },
    setRecord: async (args) => {
        fx.prefWrites.push(args);
        // Zie de talk-variant: de route LEEST na de schrijf terug, dus de
        // fixture moet de schrijf ook echt uitvoeren.
        for (const { kind, id } of args.ids) fx.prefs[`${kind}:${id}`] = args.record;
        return 1;
    },
    loadMeetingPrefs: async ({ provider, userId, orgId }) => {
        fx.prefLoads.push({ provider, userId, orgId });
        // Een ORG-brede rij schrijft de echte store als `user_id = ''` en leest
        // hij alleen via de org-tak van listPrefs. Deze dubbel doet hetzelfde:
        // zonder `orgId` is `fx.orgPrefs` onzichtbaar. Zonder dat onderscheid
        // liet het weglaten van de org-scope in de route de hele suite groen,
        // terwijl de toggle dan AAN staat voor een vergadering die de
        // beheerder had uitgezet — en anders dan bij de import is er hier geen
        // tweede vangnet.
        // EEN FALSE WINT, uit welke rij hij ook komt — de user-rij overschrijft
        // de org-rij niet, zoals `resolvePrefs` het ook niet doet.
        const scopes = orgId ? [fx.orgPrefs, fx.prefs] : [fx.prefs];
        const opinionFor = (ids) => {
            const seen = ids.flatMap(({ kind, id }) => scopes.map(m => m[`${kind}:${id}`]));
            if (seen.includes(false)) return false;
            if (seen.includes(true)) return true;
            return null;
        };
        return {
            opinionFor,
            tagsFor: () => [],
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
});
stub('../auth/routineAuth', { getProviderAuth: async () => fx.providerAuth });
stub('../stores/routineCredentialStore', { getCredential: async () => fx.cred });
stub('../core/meetingNotes/gmeetCalendar', {
    extractMeetCode: (v) => {
        const s = String(v || '').trim().toLowerCase();
        if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(s)) return s;
        const m = s.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
        return m ? m[1] : null;
    },
    listUpcomingMeetMeetings: async ({ session }) => { fx.upcomingCalls++; fx.lastUpcomingSession = session; return fx.upcoming; },
    listRecentlyEndedMeetMeetings: async () => fx.recentlyEnded,
});
stub('../core/meetingNotes/gmeetArtifacts', {
    getSpaceByMeetingCode: async (session, code) => fx.spaceByCode[code] || null,
    findConferenceRecord: async () => fx.conferenceRecord,
    findGeneratedRecording: async () => fx.generatedRecording,
    setAutoRecording: async (session, args) => {
        fx.autoRecordCalls.push(args);
        if (fx.autoRecordThrows) throw new Error('meet exploded');
        return fx.autoRecordResult;
    },
});
stub('../stores/gmeetImportStore', {
    listRecentJobsForUser: async () => fx.jobs,
    seedJob: async (row) => {
        fx.seeded.push(row);
        return fx.seedResult !== undefined ? fx.seedResult : { id: 'job-new', status: 'pending', ...row };
    },
});

// gmeetAutoImport may not exist on disk yet (built in parallel) — resolve-hook
// stub keyed on the gmeet sub-router as parent instead of require.resolve.
const AUTO_IMPORT_MOCK_ID = 'mock:gmeet:autoImport';
require.cache[AUTO_IMPORT_MOCK_ID] = {
    id: AUTO_IMPORT_MOCK_ID, filename: AUTO_IMPORT_MOCK_ID, loaded: true,
    exports: { processJobInline: async (args) => { fx.inlineCalls.push(args); return fx.inline(args); } },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../../core/meetingNotes/gmeetAutoImport' && parent && /routes[\\/]transcriptions[\\/]gmeet\.js$/.test(parent.filename || '')) {
        return AUTO_IMPORT_MOCK_ID;
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./transcriptions');

test.after(() => { Module._resolveFilename = originalResolve; });

// ── Dispatch harness ─────────────────────────────────────────────────────────
function liveSession() {
    return { user: { id: 'u1' }, oauthProvider: 'google', accessToken: 'live_at', refreshToken: 'live_rt' };
}

function dispatch({ method = 'GET', url, body, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {},
            headers: {},
            session: session || { user: { id: 'u1' } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200,
            headers: {},
            body: undefined,
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

const MEET_SCOPES = 'openid https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/meetings.space.settings';

function meeting(overrides = {}) {
    return {
        eventId: 'ev1', iCalUID: 'ical1', title: 'Weekly sync',
        start: '2026-07-17T10:00:00Z', end: '2026-07-17T11:00:00Z',
        organizerEmail: 'tom@example.com', organizerSelf: true,
        // Drie deelnemers: onder de 1-op-1-standaard (M5) staat de schakelaar
        // van een gesprek met ten hoogste twee mensen standaard uit.
        attendees: [{ email: 'sanne@example.com' }, { email: 'ines@example.com' }],
        meetingCode: 'abc-defg-hij', meetLink: 'https://meet.google.com/abc-defg-hij',
        ...overrides,
    };
}

// ═══ RESERVED_GET_PATHS regression ═══════════════════════════════════════════

test('gmeet GET routes are not swallowed by GET /:id (RESERVED_GET_PATHS)', async () => {
    resetFx();
    for (const url of ['/gmeet-meetings', '/gmeet-imports', '/gmeet-recordings']) {
        const res = await dispatch({ url });
        assert.strictEqual(res.statusCode, 200, `${url} should reach its own handler`);
        assert.notStrictEqual(res.body?.error, 'Transcription not found', `${url} swallowed as :id`);
    }
});

// ═══ GET /gmeet-meetings ═════════════════════════════════════════════════════

test('gmeet-meetings: not connected → 200 with empty list + connection CTAs', async () => {
    resetFx();
    const res = await dispatch({ url: '/gmeet-meetings' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.connection, {
        googleConnected: false, meetScopesGranted: false, hasSettingsScope: false, needsReauth: false,
    });
    assert.deepStrictEqual(res.body.meetings, []);
    assert.strictEqual(res.body.autoImport, false);
    assert.strictEqual(fx.upcomingCalls, 0, 'no calendar call without a session');
});

test('gmeet-meetings: connected without Meet scopes → empty list, reconnect hint', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: 'openid email' };
    const res = await dispatch({ url: '/gmeet-meetings', session: liveSession() });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.connection.googleConnected, true);
    assert.strictEqual(res.body.connection.meetScopesGranted, false);
    assert.deepStrictEqual(res.body.meetings, []);
    assert.strictEqual(fx.upcomingCalls, 0, 'no calendar call without Meet scopes');
});

test('gmeet-meetings: status chip mapping (imported | excluded | will_import | upcoming)', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.settings.autoImport = true;
    fx.prefs['event:ev-excl'] = false;
    fx.prefs['code:zzz-zzzz-zzz'] = false;
    fx.noteByCode['imp-orted-cde'] = { id: 't-77' };
    fx.upcoming = [
        meeting({ eventId: 'ev1', meetingCode: 'abc-defg-hij', organizerSelf: true }),
        meeting({ eventId: 'ev-excl', meetingCode: 'bbb-bbbb-bbb' }),
        meeting({ eventId: 'ev3', meetingCode: 'zzz-zzzz-zzz' }),
        meeting({ eventId: 'ev4', meetingCode: 'imp-orted-cde', organizerSelf: false }),
    ];
    const res = await dispatch({ url: '/gmeet-meetings', session: liveSession() });
    assert.strictEqual(res.statusCode, 200);
    const by = Object.fromEntries(res.body.meetings.map(m => [m.eventId, m]));

    assert.strictEqual(by.ev1.status, 'will_import');
    assert.strictEqual(by.ev1.recordingControlledByHost, false, 'organizer controls recording');
    assert.strictEqual(by['ev-excl'].status, 'excluded', 'excluded by event id');
    assert.strictEqual(by.ev3.status, 'excluded', 'excluded by meeting code (series)');
    assert.strictEqual(by.ev4.status, 'imported');
    assert.strictEqual(by.ev4.importedNoteId, 't-77');
    assert.strictEqual(by.ev4.recordingControlledByHost, true, 'attendee: host controls recording');
    assert.strictEqual(res.body.count, 4);
    assert.strictEqual(res.body.autoImport, true);
});

test('gmeet-meetings: een ORG-brede uitsluiting staat op UIT in de lijst', async () => {
    // Dit was het gat: `orgId: userOrgId` → `orgId: null` liet de hele suite
    // groen. De backfill schrijft een org-brede uitsluiting als rij met
    // `user_id = ''`; valt de org-tak weg, dan leest die als "geen mening" en
    // staat de toggle AAN voor een vergadering die de beheerder uitzette.
    // Anders dan bij de auto-import is er hier geen tweede vangnet.
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.settings.autoImport = true;
    fx.orgPrefs['code:abc-defg-hij'] = false;
    fx.upcoming = [meeting({ eventId: 'ev1', meetingCode: 'abc-defg-hij', organizerSelf: true })];
    const res = await dispatch({ url: '/gmeet-meetings', session: liveSession() });
    const row = res.body.meetings[0];
    assert.strictEqual(row.excluded, true);
    assert.strictEqual(row.recordReason, 'opted_out');
    assert.strictEqual(row.status, 'excluded');
    assert.deepStrictEqual(fx.prefLoads.at(-1), { provider: 'gmeet', userId: 'u1', orgId: 'orgA' },
        'de lijst leest met de eigen gebruiker ÉN zijn org');
});

test('gmeet-meetings: de uitkomst is hier altijd BESLIST — Meet telt niet na', async () => {
    // Bij Talk kan de engine bij de start nog live tellen, dus stuurt die
    // route `recordDecided: false`. Meet oogst alleen en kijkt niet opnieuw;
    // een "we kijken nog"-melding zou daar onwaar zijn.
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.settings.autoImport = true;
    fx.upcoming = [meeting({ eventId: 'ev1', meetingCode: 'abc-defg-hij', attendees: [], organizerEmail: null })];
    const res = await dispatch({ url: '/gmeet-meetings', session: liveSession() });
    assert.strictEqual(res.body.meetings[0].recordReason, 'unknown_size', 'de agenda zei niets over deelnemers');
    assert.strictEqual(res.body.meetings[0].recordDecided, true, 'en er komt geen tweede telling');
});

test('gmeet-meetings: autoImport off → upcoming chip', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.settings.autoImport = false;
    fx.upcoming = [meeting()];
    const res = await dispatch({ url: '/gmeet-meetings', session: liveSession() });
    assert.strictEqual(res.body.meetings[0].status, 'upcoming');
});

test('gmeet-meetings: vault shim used when the live session is not Google', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.providerAuth = { accessToken: 'vault_at', refreshToken: 'vault_rt', status: 'active', scope: MEET_SCOPES };
    fx.upcoming = [meeting()];
    // Microsoft-SSO session that connected Google via the connector
    const session = { user: { id: 'u1' }, oauthProvider: 'microsoft', accessToken: 'ms_at' };
    const res = await dispatch({ url: '/gmeet-meetings', session });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.meetings.length, 1);
    assert.strictEqual(fx.lastUpcomingSession.accessToken, 'vault_at', 'calendar called with the vault shim');
});

// ═══ PATCH /gmeet-meetings/:eventId ══════════════════════════════════════════

test('PATCH gmeet-meetings: exclusion write (per-occurrence and per-series)', async () => {
    resetFx();
    let res = await dispatch({ method: 'PATCH', url: '/gmeet-meetings/ev1', body: { record: false, meetingCode: 'abc-defg-hij' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
        ok: true, eventId: 'ev1', record: false,
        effectiveRecord: false, overridden: false, autoRecordingConfig: 'skipped',
    });
    assert.deepStrictEqual(fx.prefWrites[0], {
        provider: 'gmeet', userId: 'u1', record: false,
        ids: [{ kind: 'event', id: 'ev1' }],
    }, 'zonder applyToSeries alleen deze occurrence');

    res = await dispatch({ method: 'PATCH', url: '/gmeet-meetings/ev1', body: { record: false, meetingCode: 'abc-defg-hij', applyToSeries: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.prefWrites[1].ids, [{ kind: 'event', id: 'ev1' }, { kind: 'code', id: 'abc-defg-hij' }],
        'applyToSeries zet hem ook op de serie');
    assert.strictEqual(fx.prefWrites[1].userId, 'u1', 'altijd de eigen rij, nooit die van een ander');
});

test('PATCH gmeet-meetings: een serie-rij op UIT overruled het aanzetten van één occurrence', async () => {
    // `applyToSeries` wordt door geen enkel scherm meegestuurd, dus een
    // `code`-rij met FALSE is vanuit de UI niet meer weg te krijgen. Minimaal
    // moet de PATCH dan niet "gelukt" zeggen.
    resetFx();
    fx.prefs['code:abc-defg-hij'] = false;
    const res = await dispatch({ method: 'PATCH', url: '/gmeet-meetings/ev1', body: { record: true, meetingCode: 'abc-defg-hij' } });
    assert.strictEqual(res.body.record, true);
    assert.strictEqual(res.body.effectiveRecord, false);
    assert.strictEqual(res.body.overridden, true);
});

test('PATCH gmeet-meetings: record on + organizer + scope + autoRecordConfig → set', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.settings.autoRecordConfig = true;
    const res = await dispatch({
        method: 'PATCH', url: '/gmeet-meetings/ev1', session: liveSession(),
        body: { record: true, meetingCode: 'abc-defg-hij', organizerSelf: true },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.autoRecordingConfig, 'set');
    assert.deepStrictEqual(fx.autoRecordCalls, [{ meetingCode: 'abc-defg-hij', enabled: true }]);
    assert.deepStrictEqual(fx.prefWrites[0], {
        provider: 'gmeet', userId: 'u1', record: true,
        ids: [{ kind: 'event', id: 'ev1' }],
    });
});

test('PATCH gmeet-meetings: auto-record classification (not_host / no_scope / unsupported_edition / skipped)', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.settings.autoRecordConfig = true;

    // Looked-up organizerSelf=false when the caller omits it → not_host, no API call.
    fx.upcoming = [meeting({ eventId: 'ev1', organizerSelf: false })];
    let res = await dispatch({ method: 'PATCH', url: '/gmeet-meetings/ev1', session: liveSession(), body: { record: true, meetingCode: 'abc-defg-hij' } });
    assert.strictEqual(res.body.autoRecordingConfig, 'not_host');
    assert.strictEqual(fx.autoRecordCalls.length, 0);

    // Settings scope missing → no_scope, no doomed API call.
    fx.cred = { status: 'active', scope: 'openid https://www.googleapis.com/auth/meetings.space.readonly' };
    res = await dispatch({ method: 'PATCH', url: '/gmeet-meetings/ev1', session: liveSession(), body: { record: true, meetingCode: 'abc-defg-hij', organizerSelf: true } });
    assert.strictEqual(res.body.autoRecordingConfig, 'no_scope');
    assert.strictEqual(fx.autoRecordCalls.length, 0);

    // Meet rejects the edition → surfaced verbatim.
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.autoRecordResult = { error: 'unsupported_edition' };
    res = await dispatch({ method: 'PATCH', url: '/gmeet-meetings/ev1', session: liveSession(), body: { record: true, meetingCode: 'abc-defg-hij', organizerSelf: true } });
    assert.strictEqual(res.body.autoRecordingConfig, 'unsupported_edition');

    // autoRecordConfig disabled → skipped without any lookups.
    fx.settings.autoRecordConfig = false;
    res = await dispatch({ method: 'PATCH', url: '/gmeet-meetings/ev1', session: liveSession(), body: { record: true, meetingCode: 'abc-defg-hij', organizerSelf: true } });
    assert.strictEqual(res.body.autoRecordingConfig, 'skipped');
});

test('PATCH gmeet-meetings: auto-record blowing up NEVER fails the PATCH', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.settings.autoRecordConfig = true;
    fx.autoRecordThrows = true;
    const res = await dispatch({
        method: 'PATCH', url: '/gmeet-meetings/ev1', session: liveSession(),
        body: { record: true, meetingCode: 'abc-defg-hij', organizerSelf: true },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.autoRecordingConfig, 'error');
    assert.strictEqual(fx.prefWrites.length, 1, 'de voorkeurschrijf landde toch');
});

// ═══ GET /gmeet-imports ══════════════════════════════════════════════════════

test('gmeet-imports: recent jobs mapped to the failure-UX feed shape', async () => {
    resetFx();
    fx.jobs = [{
        id: 'j1', userId: 'u1', orgId: 'orgA', calendarEventId: 'ev1', icalUid: null,
        meetingCode: 'abc-defg-hij', title: 'Weekly sync',
        meetingStart: '2026-07-17T10:00:00.000Z', meetingEnd: '2026-07-17T11:00:00.000Z',
        status: 'no_drive_access', errorCode: 'no_drive_access', lastError: '403', attempts: 1,
        transcriptionId: null, preferred: false,
    }];
    const res = await dispatch({ url: '/gmeet-imports' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.items, [{
        id: 'j1', title: 'Weekly sync', meetingCode: 'abc-defg-hij',
        meetingStart: '2026-07-17T10:00:00.000Z', meetingEnd: '2026-07-17T11:00:00.000Z',
        status: 'no_drive_access', errorCode: 'no_drive_access', transcriptionId: null,
    }]);
});

// ═══ GET /gmeet-recordings ═══════════════════════════════════════════════════

test('gmeet-recordings: recording states resolved best-effort, capped at 10 newest', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.recentlyEnded = [];
    for (let i = 0; i < 12; i++) {
        fx.recentlyEnded.push(meeting({
            eventId: `ev${i}`, meetingCode: `cod-e${String(i).padStart(3, '0')}-xyz`,
            end: new Date(Date.UTC(2026, 6, 1 + i)).toISOString(),
        }));
    }
    // Newest meeting (ev11) has an available recording; the rest resolve to none.
    fx.spaceByCode['cod-e011-xyz'] = { name: 'spaces/sp11' };
    fx.conferenceRecord = { name: 'conferenceRecords/cr11' };
    fx.generatedRecording = { recordingName: 'r11', driveFileId: 'f11' };
    fx.noteByCode['cod-e010-xyz'] = { id: 't-10' };

    const res = await dispatch({ url: '/gmeet-recordings', session: liveSession() });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.items.length, 10, 'capped at 10');
    assert.strictEqual(res.body.items[0].eventId, 'ev11', 'newest first');
    assert.strictEqual(res.body.items[0].recordingState, 'available');
    assert.strictEqual(res.body.items[1].recordingState, 'none', 'no space → none');
    assert.strictEqual(res.body.items[1].importedNoteId, 't-10');
    assert.ok(!res.body.items.some(i => i.eventId === 'ev0' || i.eventId === 'ev1'), 'oldest two dropped');
});

test('gmeet-recordings: not connected → empty items with connection block', async () => {
    resetFx();
    const res = await dispatch({ url: '/gmeet-recordings' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.items, []);
    assert.strictEqual(res.body.connection.googleConnected, false);
});

// ═══ POST /from-gmeet ════════════════════════════════════════════════════════

test('from-gmeet: not connected → 400 not_connected; expired vault → 401 needs_reauth', async () => {
    resetFx();
    let res = await dispatch({ method: 'POST', url: '/from-gmeet', body: { meet_link: 'https://meet.google.com/abc-defg-hij' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'not_connected');

    resetFx();
    fx.cred = { status: 'needs_reauth', scope: MEET_SCOPES };
    res = await dispatch({ method: 'POST', url: '/from-gmeet', body: { meet_link: 'https://meet.google.com/abc-defg-hij' } });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'needs_reauth');
    assert.strictEqual(fx.inlineCalls.length, 0, 'no ingest attempted');
});

test('from-gmeet: connected without Meet scopes → 403 needs_meet_scopes', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: 'openid email' };
    const res = await dispatch({ method: 'POST', url: '/from-gmeet', session: liveSession(), body: { meet_link: 'https://meet.google.com/abc-defg-hij' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'needs_meet_scopes');
});

test('from-gmeet: happy path — seeds a job and returns the saved note', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.recentlyEnded = [meeting()];
    fx.inline = async () => ({ transcription: { id: 't-9', title: 'Weekly sync' } });

    const res = await dispatch({
        method: 'POST', url: '/from-gmeet', session: liveSession(),
        body: { meet_link: 'https://meet.google.com/abc-defg-hij', language: 'en' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { id: 't-9', title: 'Weekly sync' });

    assert.strictEqual(fx.seeded.length, 1, 'job seeded');
    assert.deepStrictEqual(
        { userId: fx.seeded[0].userId, orgId: fx.seeded[0].orgId, calendarEventId: fx.seeded[0].calendarEventId, meetingCode: fx.seeded[0].meetingCode, preferred: fx.seeded[0].preferred },
        { userId: 'u1', orgId: 'orgA', calendarEventId: 'ev1', meetingCode: 'abc-defg-hij', preferred: true },
    );
    assert.strictEqual(fx.inlineCalls.length, 1);
    assert.strictEqual(fx.inlineCalls[0].job.id, 'job-new');
    assert.strictEqual(fx.inlineCalls[0].session.accessToken, 'live_at', 'live session passed to the ingest');
});

test('from-gmeet: request language and context terms reach the ingest (not silently dropped)', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.recentlyEnded = [meeting()];
    fx.inline = async () => ({ transcription: { id: 't-10' } });

    const res = await dispatch({
        method: 'POST', url: '/from-gmeet', session: liveSession(),
        body: { meet_link: 'https://meet.google.com/abc-defg-hij', language: 'en', context_terms: 'Bee Flow, Kapsule' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.inlineCalls.length, 1);
    // Regression: processJobInline used to ignore these and run on the
    // settings language with no context terms.
    assert.strictEqual(fx.inlineCalls[0].language, 'en');
    assert.strictEqual(fx.inlineCalls[0].contextTerms, 'Bee Flow, Kapsule');
});

test('from-gmeet: existing poller job is reused instead of reseeding', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.recentlyEnded = [meeting()];
    fx.jobs = [{ id: 'job-poller', calendarEventId: 'ev1', meetingCode: 'abc-defg-hij', status: 'awaiting_artifacts' }];

    const res = await dispatch({ method: 'POST', url: '/from-gmeet', session: liveSession(), body: { event_id: 'ev1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.seeded.length, 0, 'no duplicate seed');
    assert.strictEqual(fx.inlineCalls[0].job.id, 'job-poller');
});

test('from-gmeet: artifacts not ready → 202 { jobId, status }', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.recentlyEnded = [meeting()];
    fx.inline = async () => ({ pending: true, status: 'awaiting_artifacts' });

    const res = await dispatch({ method: 'POST', url: '/from-gmeet', session: liveSession(), body: { meeting_code: 'abc-defg-hij' } });
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.body, { jobId: 'job-new', status: 'awaiting_artifacts' });
});

test('from-gmeet: classified ingest failures map to 4xx with stable codes', async () => {
    const cases = [
        ['no_recording', 404],
        ['no_conference', 404],
        ['no_drive_access', 403],
        ['recording_too_large', 413],
        ['unsupported_edition', 400],
    ];
    for (const [code, httpStatus] of cases) {
        resetFx();
        fx.cred = { status: 'active', scope: MEET_SCOPES };
        fx.recentlyEnded = [meeting()];
        fx.inline = async () => { const e = new Error(`ingest failed: ${code}`); e.code = code; throw e; };
        const res = await dispatch({ method: 'POST', url: '/from-gmeet', session: liveSession(), body: { meeting_code: 'abc-defg-hij' } });
        assert.strictEqual(res.statusCode, httpStatus, `${code} → ${httpStatus}`);
        assert.strictEqual(res.body.code, code);
    }
});

test('from-gmeet: unresolvable meeting reference → 400', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: MEET_SCOPES };
    fx.recentlyEnded = [];
    const res = await dispatch({ method: 'POST', url: '/from-gmeet', session: liveSession(), body: { event_id: 'ev-unknown' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(fx.inlineCalls.length, 0);
});
