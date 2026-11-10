'use strict';
/**
 * The organisation-wide import test: catalogue order and prerequisites,
 * unreadable roles letting the probes run, the access-policy refusal, a member
 * who is not covered never probed, and no token in the report.
 *
 * Run: cd server && node --test core/meetingNotes/teamsAppImport/diagnostics.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('./diagnostics.mts');

const T = '11111111-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CLIENT = 'cccccccc-0000-0000-0000-000000000001';
const CONFIG = { providers: { microsoft: { clientId: CLIENT, clientSecret: 'fixture-not-a-secret', tenantId: 'common' } } };
const ALL_ROLES = ['OnlineMeetings.Read.All', 'OnlineMeetingRecording.Read.All', 'Calendars.Read', 'OnlineMeetingTranscript.Read.All'];
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

const coded = (message, code, graphStatus) => Object.assign(new Error(message), { code, graphStatus });

function setup(over = {}) {
    const fx = {
        orgTenant: { ok: true, tenantId: T, source: 'directory_binding' },
        token: { ok: true, accessToken: 'fixture-access-token', roles: ALL_ROLES, tenantId: T, clientId: CLIENT },
        state: { settings: { enabled: true, coverage: 'all' }, counts: { eligible: 3, covered: 2, withoutIdentity: 1, otherTenant: 0, withoutAccess: 0, notSelected: 0 } },
        coverage: { covered: true, tenantId: T, objectId: OID },
        ended: [{ start: hoursAgo(3), end: hoursAgo(2), organizerSelf: true, joinUrl: 'https://teams.microsoft.com/l/x', title: 'Fixture subject 7' }],
        upcoming: [],
        meeting: { id: 'MSo1', subject: 'Fixture subject 7' },
        lookupError: null,
        ...over,
    };
    const seen = { sessions: [], coverageAsked: [], warnings: [] };
    diagnostics.init({
        loadConfig: async () => CONFIG,
        orgTenant: async () => fx.orgTenant,
        getAppToken: async () => { if (fx.tokenError) throw fx.tokenError; return fx.token; },
        appImportState: async () => fx.state,
        coverageForUser: async (userId, orgId, opts) => { seen.coverageAsked.push({ userId, orgId, opts }); return typeof fx.coverage === 'function' ? fx.coverage(userId) : fx.coverage; },
        calendar: {
            listRecentlyEndedTeamsMeetings: async ({ session }) => { seen.sessions.push(session); return fx.ended; },
            listUpcomingTeamsMeetings: async () => fx.upcoming,
        },
        artifacts: {
            getOnlineMeetingByJoinUrl: async (session) => { seen.sessions.push(session); if (fx.lookupError) throw fx.lookupError; return fx.meeting; },
            listRecordings: async () => [{ id: 'r1' }],
            listTranscripts: async () => [{ id: 't1' }, { id: 't2' }],
        },
        log: { warn: (...args) => { seen.warnings.push(args.join(' ')); } },
    });
    return seen;
}

test.afterEach(() => { delete process.env.TEAMS_APP_IMPORT; diagnostics.init(); });

const run = (input = {}) => diagnostics.runAppImportDiagnostics({ orgId: 'org-a', callerId: 'u-admin', ...input });
const byId = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

test('all good: catalogue order, every check passes, the probes use the app session of the covered member', async () => {
    const seen = setup();
    const report = await run();
    assert.equal(report.level, 'org_app');
    assert.deepEqual(report.checks.map((c) => c.id), [...diagnostics.APP_IMPORT_CHECK_IDS]);
    assert.deepEqual(report.checks.map((c) => c.id), ['b.instance', 'b.org_tenant', 'b.app_credentials', 'b.app_token', 'b.role_meetings',
        'b.role_recordings', 'b.role_calendar', 'b.role_transcripts', 'b.enabled', 'b.coverage', 'b.probe_user', 'b.calendar',
        'b.access_policy', 'b.recordings', 'b.transcripts']);
    for (const c of report.checks) assert.equal(c.status, 'pass', `${c.id}: ${c.code}`);
    assert.equal(report.overall, 'pass');
    const c = byId(report);
    assert.deepEqual(c['b.org_tenant'].params, { tenantId: T, source: 'directory_binding' });
    assert.deepEqual(c['b.app_credentials'].params, { clientId: CLIENT });
    assert.deepEqual(c['b.probe_user'].params, { self: true });
    assert.deepEqual(c['b.transcripts'].params, { count: 2 });
    assert.deepEqual(seen.sessions[0], { accessToken: 'fixture-access-token', graphUserPath: `/users/${OID}`, appOnly: true });
    const text = JSON.stringify(report);
    for (const leak of ['fixture-access-token', 'Fixture subject 7', OID, 'teams.microsoft.com', 'fixture-not-a-secret']) assert.ok(!text.includes(leak), `report contains ${leak}`);
});

test('instance switched off: the rest that depends on it is skipped', async () => {
    process.env.TEAMS_APP_IMPORT = '0';
    setup();
    const c = byId(await run());
    assert.equal(c['b.instance'].code, 'app_import_disabled_instance');
    assert.equal(c['b.org_tenant'].status, 'skipped');
    assert.equal(c['b.org_tenant'].params.prerequisite, 'b.instance');
    assert.equal(c['b.app_token'].status, 'skipped');
    assert.equal(c['b.calendar'].status, 'skipped');
});

test('not bound: tenant_not_bound, and nothing asks Microsoft', async () => {
    const seen = setup({ orgTenant: { ok: false, reason: 'tenant_not_bound' } });
    const c = byId(await run());
    assert.deepEqual([c['b.org_tenant'].status, c['b.org_tenant'].code, c['b.org_tenant'].fixer], ['fail', 'tenant_not_bound', 'platform_admin']);
    assert.equal(c['b.app_credentials'].status, 'skipped');
    assert.equal(c['b.coverage'].status, 'skipped');
    assert.equal(seen.sessions.length, 0);
});

test('unreadable roles are unknown and let the probes run', async () => {
    const seen = setup({ token: { ok: true, accessToken: 'fixture-access-token', roles: null, tenantId: T, clientId: CLIENT } });
    const c = byId(await run());
    for (const id of ['b.role_meetings', 'b.role_recordings', 'b.role_calendar', 'b.role_transcripts']) {
        assert.deepEqual([c[id].status, c[id].code, c[id].fixer], ['unknown', 'roles_unreadable', null], id);
    }
    for (const id of ['b.calendar', 'b.access_policy', 'b.recordings', 'b.transcripts']) assert.equal(c[id].status, 'pass', id);
    assert.ok(seen.sessions.length > 0);
});

test('a missing role fails and skips its probe; a missing transcript role only warns', async () => {
    setup({ token: { ok: true, accessToken: 'fixture-access-token', roles: ['OnlineMeetings.Read.All', 'Calendars.Read'], tenantId: T, clientId: CLIENT } });
    const c = byId(await run());
    assert.deepEqual([c['b.role_recordings'].status, c['b.role_recordings'].code], ['fail', 'role_missing']);
    assert.equal(c['b.role_recordings'].params.permission, 'OnlineMeetingRecording.Read.All');
    assert.equal(c['b.role_transcripts'].status, 'warn');
    assert.equal(c['b.recordings'].status, 'skipped');
    assert.equal(c['b.transcripts'].status, 'skipped');
    assert.equal(c['b.access_policy'].status, 'pass');
});

test('no application access policy: fail application_access_policy_missing with the client id, for a Teams admin', async () => {
    setup({ lookupError: coded('no Teams application access policy allows this app for this user', 'application_access_policy_missing', 403) });
    const c = byId(await run());
    const p = c['b.access_policy'];
    assert.deepEqual([p.status, p.code, p.fixer, p.remediation], ['fail', 'application_access_policy_missing', 'teams_admin', 'teams_setup.fix.grant_access_policy']);
    assert.deepEqual(p.params, { clientId: CLIENT });
    assert.equal(c['b.recordings'].status, 'skipped');
});

test('a picked member who is not covered fails and is never probed; the caller not covered is no_probe_user', async () => {
    let seen = setup({ coverage: { covered: false, reason: 'other_tenant' } });
    let c = byId(await run({ probeUserId: 'u-bob' }));
    assert.deepEqual([c['b.probe_user'].status, c['b.probe_user'].code, c['b.probe_user'].params.reason], ['fail', 'probe_user_not_covered', 'other_tenant']);
    assert.equal(c['b.calendar'].status, 'skipped');
    assert.equal(seen.sessions.length, 0);
    assert.deepEqual(seen.coverageAsked[0], { userId: 'u-bob', orgId: 'org-a', opts: { fresh: true } });

    seen = setup({ coverage: { covered: false, reason: 'not_selected' } });
    c = byId(await run());
    assert.deepEqual([c['b.probe_user'].status, c['b.probe_user'].code], ['unknown', 'no_probe_user']);
    assert.equal(seen.sessions.length, 0);
});

test('switched off: b.coverage says so (not "nobody covered"), and no member is probed with the app token', async () => {
    const seen = setup({ state: { settings: { enabled: false, coverage: 'selected' }, counts: { eligible: 2, covered: 0, withoutIdentity: 1, otherTenant: 0, withoutAccess: 0, notSelected: 0 } } });
    const c = byId(await run());
    assert.deepEqual([c['b.enabled'].status, c['b.enabled'].code], ['warn', 'not_enabled']);
    assert.deepEqual([c['b.coverage'].status, c['b.coverage'].code, c['b.coverage'].remediation, c['b.coverage'].fixer],
        ['warn', 'not_enabled', 'teams_setup.fix.enable_app_import', 'org_admin']);
    assert.equal(c['b.coverage'].params.withoutIdentity, 1, 'the would-cover counts stay');
    assert.equal(c['b.app_token'].status, 'pass', 'the app registration is still tested');
    assert.equal(c['b.probe_user'].status, 'skipped');
    assert.equal(seen.sessions.length, 0);
    assert.equal(seen.coverageAsked.length, 0);
});

test('nobody covered while switched on: b.coverage warns with the counts and the probe is skipped', async () => {
    setup({ state: { settings: { enabled: true, coverage: 'selected' }, counts: { eligible: 2, covered: 0, withoutIdentity: 2, otherTenant: 0, withoutAccess: 0, notSelected: 0 } } });
    const c = byId(await run());
    assert.deepEqual([c['b.coverage'].status, c['b.coverage'].code, c['b.coverage'].fixer], ['warn', 'nobody_covered', 'org_admin']);
    assert.equal(c['b.coverage'].params.withoutIdentity, 2);
    assert.equal(c['b.probe_user'].status, 'skipped');
});

test('no Teams meeting on the calendar: the meeting probes are unknown or skipped, and the admin is told to pick another member', async () => {
    setup({ ended: [], upcoming: [] });
    const c = byId(await run({ probeUserId: 'u-bob' }));
    assert.deepEqual([c['b.calendar'].status, c['b.calendar'].code, c['b.calendar'].remediation, c['b.calendar'].fixer],
        ['warn', 'no_teams_meetings', 'teams_setup.fix.pick_probe_user', 'org_admin']);
    assert.deepEqual([c['b.access_policy'].status, c['b.access_policy'].code, c['b.access_policy'].remediation, c['b.access_policy'].fixer],
        ['unknown', 'no_meeting_to_probe', 'teams_setup.fix.pick_probe_user', 'org_admin']);
    assert.equal(c['b.recordings'].status, 'skipped');
});

test('a failure inside Bee Flow while getting the app token is no network problem', async () => {
    let seen = setup({ tokenError: new Error('config read failed') });
    let c = byId(await run());
    assert.deepEqual([c['b.app_token'].status, c['b.app_token'].code, c['b.app_token'].remediation],
        ['unknown', 'graph_error', 'teams_setup.fix.try_again_later']);
    assert.equal(c['b.role_meetings'].status, 'skipped');
    assert.equal(seen.warnings.length, 1);

    // A token endpoint that cannot be reached is returned, not thrown: that one is the network.
    seen = setup({ token: { ok: false, result: { ok: false, kind: 'network' } } });
    c = byId(await run());
    assert.deepEqual([c['b.app_token'].status, c['b.app_token'].code, c['b.app_token'].remediation],
        ['fail', 'entra_unreachable', 'teams_setup.fix.check_network']);
});

test('a calendar refusal with the app token is calendar_forbidden for an Entra admin', async () => {
    setup();
    diagnostics.init({
        loadConfig: async () => CONFIG,
        orgTenant: async () => ({ ok: true, tenantId: T, source: 'single_org' }),
        getAppToken: async () => ({ ok: true, accessToken: 'fixture-access-token', roles: ALL_ROLES, tenantId: T, clientId: CLIENT }),
        appImportState: async () => ({ settings: { enabled: true, coverage: 'all' }, counts: { eligible: 1, covered: 1, withoutIdentity: 0, otherTenant: 0, withoutAccess: 0, notSelected: 0 } }),
        coverageForUser: async () => ({ covered: true, tenantId: T, objectId: OID }),
        calendar: { listRecentlyEndedTeamsMeetings: async () => { throw Object.assign(new Error('Graph 403'), { graphStatus: 403 }); }, listUpcomingTeamsMeetings: async () => [] },
        artifacts: { getOnlineMeetingByJoinUrl: async () => null, listRecordings: async () => [], listTranscripts: async () => [] },
    });
    const c = byId(await run());
    assert.deepEqual([c['b.calendar'].status, c['b.calendar'].code, c['b.calendar'].remediation, c['b.calendar'].fixer],
        ['fail', 'calendar_forbidden', 'teams_setup.fix.calendar_application_access', 'entra_admin']);
});

test('a refused app token is reported by its AADSTS code', async () => {
    setup({ token: { ok: false, result: { ok: false, kind: 'entra', httpStatus: 401, error: 'invalid_client', aadsts: 7000222 } } });
    const c = byId(await run());
    assert.deepEqual([c['b.app_token'].status, c['b.app_token'].code, c['b.app_token'].params.aadsts], ['fail', 'secret_expired', 'AADSTS7000222']);
    assert.equal(c['b.role_meetings'].status, 'skipped');
});
