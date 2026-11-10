'use strict';
/**
 * The user's own Teams test (catalogue 3.2), with every collaborator injected
 * through init(): skipped semantics, the "no meeting" exception, read-only
 * Graph (no PATCH ever), the transcript text dropped, the overall verdict and
 * the param allow-list.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/userDiagnostics.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const diag = require('./userDiagnostics.mts');
const entra = require('./entraToken.mts');
const { PARAM_ALLOW_LIST } = require('./checks.mts');

const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT = '11111111-2222-3333-4444-555555555555';
const SECRET = 'fixture-not-a-secret';
const ALL_SCOPES = 'openid offline_access Calendars.ReadWrite OnlineMeetingRecording.Read.All OnlineMeetingTranscript.Read.All OnlineMeetings.ReadWrite';
const TRANSCRIPT_TEXT = 'WEBVTT\n\n00:00.000 --> 00:01.000\n<v Fixture Person>Fixture subject 7 secret words</v>';
const JOIN = 'https://teams.microsoft.com/l/meetup-join/fixture';
const config = { providers: { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT } } };

/** Collaborators that answer like a healthy setup; `over` replaces parts. */
function world(over = {}) {
    const graphCalls = [];
    const log = (what) => (...args) => { graphCalls.push({ what, method: 'GET', args }); };
    const missingTeamsPermissions = (scope, { includeOptional = false } = {}) => {
        const have = new Set(String(scope || '').split(/\s+/).map((s) => s.toLowerCase()));
        return [['Calendars.ReadWrite', 'r'], ['OnlineMeetingRecording.Read.All', 'r'], ['OnlineMeetingTranscript.Read.All', 'o'], ['OnlineMeetings.ReadWrite', 'o']]
            .filter(([n, role]) => (includeOptional || role === 'r') && !have.has(n.toLowerCase())).map(([n]) => n);
    };
    const deps = {
        hasCapability: async () => true,
        settings: {
            resolveTeamsNotesSettings: async () => ({ autoImport: true, autoRecordConfig: false }),
            getOrgSettings: async () => ({ autoImport: null }),
            missingTeamsPermissions,
        },
        skipState: { readSkips: async () => new Map() },
        // Like the real rule without a record mark: a candidate while auto-import is on.
        candidate: { isAutoImportCandidate: async (a) => a.autoImport === true },
        calendar: {
            listRecentlyEndedTeamsMeetings: async (a) => { log('calendar.ended')(a); return [
                { eventId: 'e1', title: 'Fixture subject 7', start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z', organizerSelf: true, joinUrl: JOIN, attendees: [{ email: 'member@fixture.test' }] },
                { eventId: 'e2', start: '2026-11-08T09:00:00Z', end: '2026-11-08T10:00:00Z', organizerSelf: false, joinUrl: `${JOIN}-other` },
            ]; },
            listUpcomingTeamsMeetings: async (a) => { log('calendar.upcoming')(a); return []; },
        },
        artifacts: {
            getOnlineMeetingByJoinUrl: async (s, url) => { log('lookup')(url); return { id: 'meeting-1', subject: 'Fixture subject 7', allowRecording: true, allowTranscription: true, recordAutomatically: false, joinWebUrl: url }; },
            listRecordings: async (s, id) => { log('recordings')(id); return [{ id: 'r1' }, { id: 'r2' }]; },
            listTranscripts: async (s, id) => { log('transcripts')(id); return [{ id: 't1', createdDateTime: '2026-11-09T09:00:00Z' }, { id: 't2', createdDateTime: '2026-11-09T09:30:00Z' }]; },
            fetchTranscriptVtt: async (s, a) => { log('transcript.content')(a); return TRANSCRIPT_TEXT; },
        },
        log: { warn: () => {} },
    };
    for (const [k, v] of Object.entries(over)) deps[k] = typeof v === 'object' && !Array.isArray(v) && deps[k] && typeof deps[k] === 'object' ? { ...deps[k], ...v } : v;
    diag.init(deps);
    return { graphCalls };
}

const liveSession = () => ({ oauthProvider: 'microsoft', accessToken: 'fixture-access-token', oauthScope: ALL_SCOPES });
const input = (over = {}) => {
    const reqSession = over.reqSession === undefined ? liveSession() : over.reqSession;
    return { userId: 'u1', orgId: 'org-a', config, callerTenantId: null, reqSession, session: reqSession, credential: { status: 'active', scope: ALL_SCOPES }, timeoutMs: 2000, ...over };
};
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test.beforeEach(() => {
    entra.init({ safeFetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'fixture-access-token', expires_in: 3600 }) }) });
});
test.afterEach(() => { diag.init(); entra.init(); });

test('a healthy setup passes every check, in catalogue order, with GET-only Graph calls', async () => {
    const { graphCalls } = world();
    const report = await diag.runUserDiagnostics(input());
    assert.equal(report.level, 'user');
    assert.deepEqual(report.checks.map((c) => c.id), [...diag.USER_CHECK_IDS]);
    assert.deepEqual(report.checks.filter((c) => c.status !== 'pass').map((c) => c.id), []);
    assert.equal(report.overall, 'pass');
    const c = byId(report);
    assert.deepEqual(c['a.connection'].params, { source: 'sign_in' });
    assert.deepEqual(c['a.calendar'].params, { endedOrganised: 1, upcoming: 0 });
    assert.deepEqual(c['a.meeting_lookup'].params, { probe: 'ended', allowRecording: true, allowTranscription: true, recordAutomatically: false });
    assert.deepEqual(c['a.recordings'].params, { count: 2, probe: 'ended' });
    assert.deepEqual(c['a.transcripts'].params, { count: 2 });
    assert.deepEqual(graphCalls.find((g) => g.what === 'transcript.content').args[0], { meetingId: 'meeting-1', transcriptId: 't2' }, 'the newest transcript');
    assert.ok(graphCalls.every((g) => g.method === 'GET'));
    assert.ok(!graphCalls.some((g) => /patch|setRecord/i.test(g.what)), 'no PATCH ever');
    assert.equal(graphCalls.find((g) => g.what === 'calendar.ended').args[0].lookbackHours, 168);
});

test('the report holds no transcript text, subject, attendee, join URL, meeting id, token or secret', async () => {
    world();
    const text = JSON.stringify(await diag.runUserDiagnostics(input()));
    for (const leak of ['WEBVTT', 'secret words', 'Fixture subject 7', 'Fixture Person', 'member@fixture.test', JOIN, 'meeting-1', 'fixture-access-token', SECRET, TENANT]) {
        assert.ok(!text.includes(leak), `report contains ${leak}`);
    }
});

test('every param key is allow-listed', async () => {
    world();
    const allowed = new Set(PARAM_ALLOW_LIST);
    for (const c of (await diag.runUserDiagnostics(input())).checks) {
        for (const k of Object.keys(c.params)) assert.ok(allowed.has(k), `${c.id}.${k}`);
    }
});

test('not connected: the scope, calendar and meeting checks are skipped with their prerequisite', async () => {
    const { graphCalls } = world();
    const report = await diag.runUserDiagnostics(input({ reqSession: {}, session: null, credential: null }));
    const c = byId(report);
    assert.equal(c['a.connection'].status, 'fail');
    assert.equal(c['a.connection'].code, 'not_connected');
    for (const id of ['a.scope_calendar', 'a.scope_recordings', 'a.scope_transcripts', 'a.auto_record', 'a.background_access']) {
        assert.equal(c[id].status, 'skipped', id);
        assert.deepEqual(c[id].params, { prerequisite: 'a.connection' }, id);
    }
    assert.deepEqual(c['a.calendar'].params, { prerequisite: 'a.scope_calendar' });
    assert.deepEqual(c['a.meeting_lookup'].params, { prerequisite: 'a.calendar' });
    assert.deepEqual(c['a.recordings'].params, { prerequisite: 'a.meeting_lookup' });
    assert.deepEqual(c['a.transcript_content'].params, { prerequisite: 'a.transcripts' });
    assert.equal(c['a.auto_import'].status, 'pass', 'no prerequisites');
    assert.equal(report.overall, 'fail');
    assert.equal(graphCalls.length, 0, 'no Graph call without a session');
});

test('an expired stored connection is needs_reauth', async () => {
    world();
    const c = byId(await diag.runUserDiagnostics(input({ reqSession: {}, session: null, credential: { status: 'needs_reauth', scope: ALL_SCOPES } })));
    assert.equal(c['a.connection'].code, 'needs_reauth');
    assert.equal(c['a.connection'].remediation, 'teams_setup.fix.reconnect_microsoft');
});

test('no organised meeting: a.meeting_lookup is unknown no_meeting_to_probe, not failed and not skipped', async () => {
    world({ calendar: { listRecentlyEndedTeamsMeetings: async () => [], listUpcomingTeamsMeetings: async () => [] } });
    const report = await diag.runUserDiagnostics(input());
    const c = byId(report);
    assert.equal(c['a.calendar'].status, 'warn');
    assert.equal(c['a.calendar'].code, 'no_teams_meetings');
    assert.equal(c['a.meeting_lookup'].status, 'unknown');
    assert.equal(c['a.meeting_lookup'].code, 'no_meeting_to_probe');
    assert.equal(c['a.recordings'].status, 'skipped');
    assert.equal(report.overall, 'warn');
});

test('an upcoming meeting is the probe when none ended', async () => {
    world({ calendar: {
        listRecentlyEndedTeamsMeetings: async () => [],
        listUpcomingTeamsMeetings: async () => [{ eventId: 'u', start: '2026-11-11T09:00:00Z', organizerSelf: true, joinUrl: JOIN }],
    } });
    const c = byId(await diag.runUserDiagnostics(input()));
    assert.deepEqual(c['a.calendar'].params, { endedOrganised: 0, upcoming: 1 });
    assert.equal(c['a.meeting_lookup'].params.probe, 'upcoming');
});

test('a missing recordings scope fails and skips the recordings probe; a missing transcript scope only warns', async () => {
    const { graphCalls } = world();
    const scope = 'Calendars.ReadWrite OnlineMeetings.ReadWrite';
    const reqSession = { ...liveSession(), oauthScope: scope };
    const c = byId(await diag.runUserDiagnostics(input({ reqSession, session: reqSession, credential: { status: 'active', scope } })));
    assert.equal(c['a.scope_recordings'].status, 'fail');
    assert.equal(c['a.scope_recordings'].fixer, 'entra_admin');
    assert.deepEqual(c['a.scope_recordings'].params, { permission: 'OnlineMeetingRecording.Read.All' });
    assert.equal(c['a.recordings'].status, 'skipped');
    assert.deepEqual(c['a.recordings'].params, { prerequisite: 'a.scope_recordings' });
    assert.equal(c['a.scope_transcripts'].status, 'warn');
    assert.equal(c['a.transcripts'].status, 'skipped');
    assert.ok(!graphCalls.some((g) => g.what === 'recordings'));
    assert.deepEqual(c['a.background_access'].params, { missing: ['OnlineMeetingRecording.Read.All'] });
});

test('auto-record: missing write scope warns, or fails when Bee Flow manages Teams recording', async () => {
    const scope = 'Calendars.ReadWrite OnlineMeetingRecording.Read.All';
    const reqSession = { ...liveSession(), oauthScope: scope };
    world();
    assert.equal(byId(await diag.runUserDiagnostics(input({ reqSession, session: reqSession })))['a.auto_record'].status, 'warn');
    world({ settings: { resolveTeamsNotesSettings: async () => ({ autoImport: true, autoRecordConfig: true }) } });
    const c = byId(await diag.runUserDiagnostics(input({ reqSession, session: reqSession })))['a.auto_record'];
    assert.equal(c.status, 'fail');
    assert.deepEqual(c.params, { permission: 'OnlineMeetings.ReadWrite', autoRecordConfig: true });
});

test('the scope of a stored connection is used when the sign-in session is not the one the calls carry', async () => {
    world();
    const reqSession = { oauthProvider: 'microsoft', accessToken: 'fixture-access-token', oauthScope: 'openid' };
    const shim = { accessToken: 'fixture-access-token' };
    const c = byId(await diag.runUserDiagnostics(input({ reqSession, session: shim, credential: { status: 'active', scope: ALL_SCOPES } })));
    assert.deepEqual(c['a.connection'].params, { source: 'connection' });
    assert.equal(c['a.scope_calendar'].status, 'pass');
});

test('Graph failures become their codes: calendar 403, transcript switch, speaker attribution, null lookup', async () => {
    world({ calendar: { listRecentlyEndedTeamsMeetings: async () => { throw Object.assign(new Error('Fixture subject 7'), { graphStatus: 403 }); } } });
    let c = byId(await diag.runUserDiagnostics(input()));
    assert.equal(c['a.calendar'].code, 'calendar_forbidden');
    assert.equal(c['a.calendar'].remediation, 'teams_setup.fix.calendar_access');

    world({ artifacts: { listTranscripts: async () => { throw Object.assign(new Error('x'), { code: 'transcript_access_disabled' }); } } });
    c = byId(await diag.runUserDiagnostics(input()));
    assert.equal(c['a.transcripts'].status, 'warn');
    assert.equal(c['a.transcripts'].code, 'transcript_api_disabled');
    assert.equal(c['a.transcript_content'].status, 'skipped');

    world({ artifacts: { fetchTranscriptVtt: async () => { throw Object.assign(new Error('x'), { code: 'speaker_attribution_disabled' }); } } });
    c = byId(await diag.runUserDiagnostics(input()));
    assert.equal(c['a.transcript_content'].code, 'speaker_attribution_off');

    world({ artifacts: { getOnlineMeetingByJoinUrl: async () => null } });
    c = byId(await diag.runUserDiagnostics(input()));
    assert.equal(c['a.meeting_lookup'].code, 'meeting_not_available');
    assert.equal(c['a.meeting_lookup'].status, 'fail');
});

test('recording switched off for the meeting is a warning for the Teams admin', async () => {
    world({ artifacts: { getOnlineMeetingByJoinUrl: async () => ({ id: 'm', allowRecording: false }) } });
    const c = byId(await diag.runUserDiagnostics(input()))['a.meeting_lookup'];
    assert.equal(c.status, 'warn');
    assert.equal(c.code, 'recording_not_allowed');
    assert.equal(c.fixer, 'teams_admin');
});

test('no transcript to test with is unknown without a fix', async () => {
    world({ artifacts: { listTranscripts: async () => [] } });
    const c = byId(await diag.runUserDiagnostics(input()))['a.transcript_content'];
    assert.deepEqual([c.status, c.code, c.remediation, c.fixer], ['unknown', 'no_transcript_to_probe', null, null]);
});

test('a probe that does not answer in time is unknown probe_timeout', async () => {
    world({ calendar: { listRecentlyEndedTeamsMeetings: () => new Promise((r) => setTimeout(() => r([]), 300)) } });
    const c = byId(await diag.runUserDiagnostics(input({ timeoutMs: 20 })))['a.calendar'];
    assert.deepEqual([c.status, c.code, c.remediation, c.fixer], ['unknown', 'probe_timeout', 'teams_setup.fix.try_again_later', 'user']);
});

test('capability missing, background access and auto import variants', async () => {
    world({ hasCapability: async () => false, settings: { resolveTeamsNotesSettings: async () => ({ autoImport: false, autoRecordConfig: false }), getOrgSettings: async () => ({ autoImport: false }) } });
    let c = byId(await diag.runUserDiagnostics(input({ credential: null })));
    assert.deepEqual([c['product.access'].status, c['product.access'].code, c['product.access'].fixer], ['warn', 'capability_missing', 'org_admin']);
    assert.equal(c['a.background_access'].code, 'no_stored_connection');
    assert.equal(c['a.auto_import'].code, 'auto_import_off');
    assert.equal(c['a.auto_import'].remediation, 'teams_setup.fix.turn_on_auto_import_org');

    world({ skipState: { readSkips: async (ids) => new Map([[ids[0], { reason: 'missing_scopes', missingPermissions: ['OnlineMeetingRecording.Read.All'], at: '2026-11-10T07:00:00.000Z', orgId: 'org-a' }]]) } });
    c = byId(await diag.runUserDiagnostics(input({ credential: { status: 'needs_reauth', scope: ALL_SCOPES } })));
    assert.equal(c['a.background_access'].code, 'stored_connection_expired');
    assert.equal(c['a.auto_import'].code, 'auto_import_skipped');
    assert.deepEqual(c['a.auto_import'].params, { reason: 'missing_scopes', at: '2026-11-10T07:00:00.000Z', missing: ['OnlineMeetingRecording.Read.All'] });
    assert.equal(c['a.auto_import'].remediation, 'teams_setup.fix.reconnect_to_grant');

    world({ skipState: { readSkips: async (ids) => new Map([[ids[0], { reason: 'no_credential', missingPermissions: [], at: 'T', orgId: 'org-b' }]]) } });
    assert.equal(byId(await diag.runUserDiagnostics(input()))['a.auto_import'].status, 'pass', "another org's skip state is ignored");
});

test('a skip stored before auto-import was switched off no longer wins once the poller stops visiting the user', async () => {
    const staleSkip = { skipState: { readSkips: async (ids) => new Map([[ids[0], { reason: 'no_credential', missingPermissions: [], at: 'T', orgId: 'org-a' }]]) } };
    const off = { resolveTeamsNotesSettings: async () => ({ autoImport: false, autoRecordConfig: false }), getOrgSettings: async () => ({ autoImport: false }) };
    world({ ...staleSkip, settings: off });
    let c = byId(await diag.runUserDiagnostics(input()))['a.auto_import'];
    assert.deepEqual([c.status, c.code, c.remediation, c.fixer], ['warn', 'auto_import_off', 'teams_setup.fix.turn_on_auto_import_org', 'org_admin']);

    // Still visited through a live record mark: the skip is what the poller says.
    world({ ...staleSkip, settings: off, candidate: { isAutoImportCandidate: async () => true } });
    c = byId(await diag.runUserDiagnostics(input()))['a.auto_import'];
    assert.deepEqual([c.code, c.remediation], ['auto_import_skipped', 'teams_setup.fix.connect_for_background']);

    // Candidacy unreadable: the stored skip still counts.
    world({ ...staleSkip, settings: off, candidate: { isAutoImportCandidate: async () => { throw new Error('down'); } } });
    assert.equal(byId(await diag.runUserDiagnostics(input()))['a.auto_import'].code, 'auto_import_skipped');
});

test('without an app registration everything that needs it is skipped', async () => {
    const { graphCalls } = world();
    const c = byId(await diag.runUserDiagnostics(input({ config: { providers: {} } })));
    assert.equal(c['app.configured'].code, 'app_not_configured');
    assert.equal(c['app.token'].status, 'skipped');
    assert.equal(c['a.connection'].status, 'skipped');
    assert.equal(graphCalls.length, 0);
});

test('app.token in the user report carries no tenant id', async () => {
    world();
    const token = byId(await diag.runUserDiagnostics(input()))['app.token'];
    assert.equal(token.status, 'pass');
    assert.deepEqual(token.params, { tenantSource: 'configured' });
});
