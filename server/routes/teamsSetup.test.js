'use strict';
/**
 * The Teams setup routes over the real router, the real stores and a real
 * Postgres (PGlite), with two organisations A and B, an admin and a member in
 * each. What this pins:
 *
 *   - the overview of A lists only A's members, failures and skip states; an
 *     org named in the query is refused (strict query); a member gets 403, an
 *     account without an organisation 404;
 *   - the consent link is for admins only and is bound to the caller's own org
 *     in the session; without a known tenant there is no link;
 *   - no answer of any route holds a token, secret, scope string, meeting
 *     subject, e-mail address or Microsoft object id;
 *   - the user test is rate limited;
 *   - option B: admins only; off by default; switching on needs the org's
 *     verified tenant and is audited without ids; org B, which shares the
 *     tenant of A, is neither available nor covered; ids of another org are
 *     refused with a count; the B test refuses a probe member of another org,
 *     carries no token and is rate limited.
 *
 * The mount gates (module, licence, capability-or-org-admin) are index.js's
 * and are covered by auth/capabilityOrOrgAdmin.test.js.
 *
 * Run: cd server && node --test routes/teamsSetup.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teams-setup-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'teams-setup-test-master-key-0123456789abcdef0123';

const { usePglitePool } = require('../testUtils/pglitePool');
const { pg, close: closePg } = usePglitePool();
const h = require('../testUtils/routeHarness');

const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT_A = '11111111-2222-3333-4444-555555555555';
const OID_A = 'cccccccc-1111-2222-3333-444444444444';
const OID_B = 'dddddddd-1111-2222-3333-444444444444';
const SECRET = 'fixture-not-a-secret';
const SCOPE = 'openid Fixture.Scope.Marker Calendars.ReadWrite';
const mk = (id, org, extra = {}) => ({ id, username: id, email: `${id}@fixture.test`, organizationId: org, role: 'user', orgRole: 'member', groups: [], ...extra });
const ADMIN_A = mk('a-admin', 'org-a', { orgRole: 'org_admin', displayName: 'Admin A', azureTenantId: TENANT_A, azureUserId: OID_A });
const MEMBER_A = mk('a-member', 'org-a', { displayName: 'Member A' });
const ADMIN_B = mk('b-admin', 'org-b', { orgRole: 'org_admin', displayName: 'Admin B', azureTenantId: TENANT_A, azureUserId: OID_B });
const MEMBER_B = mk('b-member', 'org-b', { displayName: 'Member B' });
const LONER = mk('loner', '', { displayName: 'No Org' });

const fx = { config: { providers: { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: 'common' } } } };
let api;
let rateLimit;

before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    for (const id of ['org-a', 'org-b']) await userStore.createOrganization({ id, name: id }, { autoGrantTrial: false });
    for (const u of [ADMIN_A, MEMBER_A, ADMIN_B, MEMBER_B, LONER]) await userStore.createUser({ ...u, passwordHash: 'x' });
    await require('../stores/automationCredentialStore').initDB();
    await require('../stores/teamsImportStore').initDB();
    await pg.query(`INSERT INTO automation_credentials (user_id, org_id, provider, scope, status, last_error) VALUES
        ('a-member', 'org-a', 'microsoft', $1, 'active', 'Fixture subject 7'),
        ('b-member', 'org-b', 'microsoft', $1, 'needs_reauth', 'Fixture subject 7')`, [SCOPE]);
    await pg.query(`INSERT INTO teams_import_jobs (user_id, org_id, calendar_event_id, join_url, title, status, error_code, last_error) VALUES
        ('a-member', 'org-a', 'e1', 'https://teams.microsoft.com/l/a', 'Fixture subject 7', 'failed', 'graph_forbidden', 'Fixture subject 7'),
        ('b-member', 'org-b', 'e2', 'https://teams.microsoft.com/l/b', 'Fixture subject 7', 'failed', 'org_b_only_code', 'Fixture subject 7')`);
    const configStore = require('../stores/configStore');
    await configStore.setConfig('teams_autoimport_skip_user_a-member', { reason: 'missing_scopes', missingPermissions: ['OnlineMeetingRecording.Read.All'], at: '2026-11-10T06:00:00.000Z', orgId: 'org-a' });
    // A skip counts only while the poller visits the member: auto-import is on for them.
    await configStore.setConfig('user_teams_notes_a-member', { autoImport: true });
    await configStore.setConfig('teams_autoimport_skip_user_b-member', { reason: 'no_credential', missingPermissions: [], at: '2026-11-10T06:00:00.000Z', orgId: 'org-b' });

    const router = require('./teamsSetup.mts');
    router.init({
        loadConfig: async () => fx.config,
        resolveTeamsSession: async () => ({ session: null }),
    });
    rateLimit = require('../core/meetingNotes/teamsSetup/rateLimit.mts');
    api = h.serve('/api/teams-setup', router.teamsSetupRouter, { user: ADMIN_A });
}, { timeout: 120_000 });

after(async () => {
    require('./teamsSetup.mts').init();
    await api.close();
    await closePg();
});

beforeEach(() => rateLimit.resetDiagnosticsSlots());

const LEAKS = [SECRET, SCOPE, 'Fixture.Scope.Marker', 'Fixture subject 7', '@fixture.test', OID_A, OID_B, 'fixture-access-token'];
function assertNoLeak(res, what) {
    const text = h.textWithoutCorrelationId(res);
    for (const leak of LEAKS) assert.ok(!text.includes(leak), `${what} contains ${leak}`);
}

test("the overview of A lists only A's members, failures and skip states", async () => {
    const res = await api.call('GET', '/api/teams-setup/org/overview?days=30', { user: ADMIN_A });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.windowDays, 30);
    assert.deepEqual(res.body.members.map((m) => m.userId).sort(), ['a-admin', 'a-member']);
    const member = res.body.members.find((m) => m.userId === 'a-member');
    assert.equal(member.microsoft, 'active');
    assert.deepEqual(member.failures, [{ code: 'graph_forbidden', count: 1 }]);
    assert.equal(member.autoImportSkip.reason, 'missing_scopes');
    assert.equal(res.body.members.find((m) => m.userId === 'a-admin').verifiedMicrosoftIdentity, true);
    const text = res.text;
    for (const other of ['b-member', 'b-admin', 'Member B', 'org_b_only_code', 'no_credential']) assert.ok(!text.includes(other), `B's ${other} leaked`);
    assert.equal(res.body.totals.failedImports, 1);
    assert.deepEqual(res.body.checks.map((c) => c.id), ['org.consent_link', 'org.admin_consent']);
    assertNoLeak(res, 'overview');
});

test('the admin of B sees only B', async () => {
    const res = await api.call('GET', '/api/teams-setup/org/overview', { user: ADMIN_B });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.members.map((m) => m.userId).sort(), ['b-admin', 'b-member']);
    assert.equal(res.body.windowDays, 7);
});

test('an org in the query is refused, and so is a window outside 1..30', async () => {
    for (const url of ['/api/teams-setup/org/overview?orgId=org-b', '/api/teams-setup/org/overview?days=31', '/api/teams-setup/org/overview?days=0']) {
        const res = await api.call('GET', url, { user: ADMIN_A });
        assert.equal(res.status, 400, url);
        assert.equal(res.body.code, 'invalid_request');
    }
});

test('a member gets 403 not_org_admin, an account without an org 404, no session 401', async () => {
    for (const [method, url] of [['GET', '/api/teams-setup/org/overview'], ['POST', '/api/teams-setup/org/consent-link']]) {
        const member = await api.call(method, url, { user: MEMBER_A });
        assert.equal(member.status, 403, `${method} ${url}`);
        assert.equal(member.body.code, 'not_org_admin');
        const loner = await api.call(method, url, { user: LONER });
        assert.equal(loner.status, 404, `${method} ${url}`);
        assert.equal(loner.body.code, 'no_organisation');
        assert.equal((await api.call(method, url, { user: null })).status, 401);
    }
});

test('consent link: tenant common uses the caller verified tenant; without one there is no link and no session write', async () => {
    fx.config = { providers: { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: 'common' } } };
    const withTenant = await api.call('POST', '/api/teams-setup/org/consent-link', { user: ADMIN_A });
    assert.equal(withTenant.status, 200);
    assert.equal(withTenant.body.available, true);
    assert.equal(withTenant.body.tenantSource, 'your_account');

    await pg.query('UPDATE users SET "azureTenantId" = NULL WHERE id = $1', ['b-admin']);
    const seen = [];
    const probe = h.serve('/api/teams-setup', [
        (req, _res, next) => { seen.push(req.session); next(); },
        require('./teamsSetup.mts').teamsSetupRouter,
    ], { user: ADMIN_B });
    try {
        const res = await probe.call('POST', '/api/teams-setup/org/consent-link', { user: ADMIN_B });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { available: false, reason: 'tenant_unknown' });
        assert.equal(seen[0].teamsAdminConsent, undefined);
    } finally {
        await probe.close();
        await pg.query('UPDATE users SET "azureTenantId" = $2 WHERE id = $1', ['b-admin', TENANT_A]);
    }
});

test("consent link as admin: the session gets the pending request of the caller's own org", async () => {
    fx.config = { providers: { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT_A } } };
    const seen = [];
    const probe = h.serve('/api/teams-setup', [
        (req, _res, next) => { seen.push(req.session); next(); },
        require('./teamsSetup.mts').teamsSetupRouter,
    ], { user: ADMIN_A });
    try {
        const res = await probe.call('POST', '/api/teams-setup/org/consent-link', { user: ADMIN_A });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.body.available, true);
        assert.equal(res.body.tenantSource, 'configured');
        assert.equal(res.body.tenantId, TENANT_A);
        const url = new URL(res.body.url);
        assert.equal(url.origin + url.pathname, `https://login.microsoftonline.com/${TENANT_A}/v2.0/adminconsent`);
        assert.equal(url.searchParams.get('client_id'), CLIENT);
        assert.equal(url.searchParams.get('redirect_uri'), res.body.redirectUri);
        assert.match(res.body.redirectUri, /\/api\/integrations\/microsoft\/callback$/);
        const pending = seen[0].teamsAdminConsent;
        assert.equal(pending.orgId, 'org-a');
        assert.equal(pending.tenantId, TENANT_A);
        assert.equal(url.searchParams.get('state'), pending.state);
        assert.match(pending.state, /^[0-9a-f]{64}$/);
        assert.ok(pending.expiresAt > Date.now() + 29 * 60_000);
        assert.ok(Array.isArray(res.body.permissions.delegated) && Array.isArray(res.body.permissions.application));
        assertNoLeak(res, 'consent link');
    } finally {
        await probe.close();
    }
});

test('requirements: the permission tables and redirect addresses, nothing secret', async () => {
    fx.config = { providers: { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT_A } } };
    const res = await api.call('GET', '/api/teams-setup/requirements', { user: MEMBER_A });
    assert.equal(res.status, 200);
    assert.equal(res.body.tenantMode, 'single');
    assert.match(res.body.redirectUris.signIn, /\/auth\/callback\/microsoft$/);
    assert.match(res.body.redirectUris.connect, /\/api\/integrations\/microsoft\/callback$/);
    assert.ok(res.body.delegated.some((p) => p.name === 'OnlineMeetingRecording.Read.All' && p.adminConsent === true));
    assert.equal(res.body.application.length, 4);
    assertNoLeak(res, 'requirements');
    fx.config = { providers: {} };
    assert.equal((await api.call('GET', '/api/teams-setup/requirements', { user: MEMBER_A })).body.tenantMode, 'not_configured');
    assert.equal((await api.call('GET', '/api/teams-setup/requirements?x=1', { user: MEMBER_A })).status, 400);
});

test('my diagnostics: a user report, then 429 within the interval', async () => {
    fx.config = { providers: { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: 'common' } } };
    const first = await api.call('POST', '/api/teams-setup/me/diagnostics', { user: MEMBER_A });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.level, 'user');
    const byId = Object.fromEntries(first.body.checks.map((c) => [c.id, c]));
    assert.equal(byId['a.connection'].code, 'not_connected', 'no session was resolved');
    assert.equal(byId['app.token'].code, 'tenant_needed', 'common, and the member has no verified tenant');
    assert.equal(byId['a.auto_import'].code, 'auto_import_skipped');
    assertNoLeak(first, 'my diagnostics');
    const second = await api.call('POST', '/api/teams-setup/me/diagnostics', { user: MEMBER_A });
    assert.equal(second.status, 429);
    assert.equal(second.body.code, 'diagnostics_rate_limited');
    assert.equal((await api.call('POST', '/api/teams-setup/me/diagnostics', { user: MEMBER_B })).status, 200, 'another user has their own slot');
});

test('the connection test and the consent link take no fields: one sent is refused by name, and the test slot stays free', async () => {
    fx.config = { providers: { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: 'common' } } };
    const mine = await api.call('POST', '/api/teams-setup/me/diagnostics', { user: MEMBER_A, body: { userId: 'a-admin' } });
    h.assertRefused(assert, mine, 'body', /does not take "userId"/);
    const link = await api.call('POST', '/api/teams-setup/org/consent-link', { user: ADMIN_A, body: { tenantId: TENANT_A } });
    h.assertRefused(assert, link, 'body', /does not take "tenantId"/);
    assert.equal((await api.call('POST', '/api/teams-setup/me/diagnostics', { user: MEMBER_A })).status, 200, 'the refused request took no slot');
});

// ── option B: organisation-wide import ───────────────────────────────

const coverage = require('../core/meetingNotes/teamsAppImport/coverage.mts');
const orgTenant = require('../core/meetingNotes/teamsAppImport/orgTenant.mts');
const appToken = require('../core/meetingNotes/teamsAppImport/appToken.mts');
const entraToken = require('../core/meetingNotes/teamsSetup/entraToken.mts');
const appDiagnostics = require('../core/meetingNotes/teamsAppImport/diagnostics.mts');
const membersOverview = require('../core/meetingNotes/teamsSetup/membersOverview.mts');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FIXTURE_JWT = `${b64({ alg: 'none' })}.${b64({ tid: TENANT_A, roles: ['Calendars.Read'] })}.fixture-access-token`;
const tokenRequests = [];

function useB() {
    fx.config = { providers: { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: 'common' } } };
    const loadConfig = async () => fx.config;
    orgTenant.init({ loadConfig });
    coverage.init({ loadConfig, hasCapability: async () => true, log: { warn: () => {} } });
    // Everyone has Meeting Notes in these tests (the entitlement rules have their own tests).
    membersOverview.init({ hasCapability: async () => true });
    appToken.init({ loadConfig });
    entraToken.init({ safeFetch: async (url) => {
        tokenRequests.push(url);
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: FIXTURE_JWT, expires_in: 3600 }) };
    } });
    appDiagnostics.init({
        loadConfig,
        calendar: { listRecentlyEndedTeamsMeetings: async () => [], listUpcomingTeamsMeetings: async () => [] },
    });
}

const B_LEAKS = [...LEAKS, FIXTURE_JWT];
function assertNoBLeak(res, what) {
    const text = h.textWithoutCorrelationId(res);
    for (const leak of B_LEAKS) assert.ok(!text.includes(leak), `${what} contains ${leak}`);
}

test('option B routes: 403 for a member, 404 without an organisation', async () => {
    useB();
    const calls = [
        ['GET', '/api/teams-setup/org/app-import', undefined],
        ['PUT', '/api/teams-setup/org/app-import', { enabled: false, coverage: 'selected', selectedUserIds: [] }],
        ['POST', '/api/teams-setup/org/app-import/diagnostics', {}],
    ];
    for (const [method, url, body] of calls) {
        const member = await api.call(method, url, { user: MEMBER_A, body });
        assert.equal(member.status, 403, `${method} ${url}`);
        assert.equal(member.body.code, 'not_org_admin');
        assert.equal((await api.call(method, url, { user: LONER, body })).status, 404);
    }
});

test('option B: off by default; switching on takes the bound tenant, audits without ids, and covers only A', async () => {
    useB();
    const configStore = require('../stores/configStore');
    await configStore.setConfig('azure_group_sync_binding', { syncOrganizationId: 'org-a', syncTenantId: TENANT_A });
    orgTenant.resetOrgTenantMemo();

    const initial = await api.call('GET', '/api/teams-setup/org/app-import', { user: ADMIN_A });
    assert.equal(initial.status, 200, initial.text);
    assert.equal(initial.body.settings.enabled, false);
    assert.deepEqual(initial.body.availability, { reason: 'ok', tenantId: TENANT_A, source: 'directory_binding' });
    assert.deepEqual(initial.body.counts, { eligible: 2, covered: 0, withoutIdentity: 1, otherTenant: 0, withoutAccess: 0, notSelected: 1 });

    const on = await api.call('PUT', '/api/teams-setup/org/app-import', { user: ADMIN_A, body: { enabled: true, coverage: 'selected', selectedUserIds: ['a-admin', 'a-admin'] } });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.body.settings.enabled, true);
    assert.equal(on.body.settings.tenantId, TENANT_A);
    assert.deepEqual(on.body.settings.selectedUserIds, ['a-admin']);
    assert.equal(on.body.counts.covered, 1);
    assertNoBLeak(on, 'app-import PUT');

    const audit = await pg.query(`SELECT action, changed_by, organization_id, old_values, new_values FROM access_audit_log WHERE action LIKE 'teams_app_import%' ORDER BY created_at`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].action, 'teams_app_import_enabled');
    assert.equal(audit.rows[0].changed_by, 'a-admin');
    assert.equal(audit.rows[0].organization_id, 'org-a');
    assert.deepEqual(JSON.parse(audit.rows[0].new_values), { enabled: true, coverage: 'selected', selectedCount: 1, tenantId: TENANT_A });
    assert.ok(!audit.rows[0].new_values.includes('a-admin') && !audit.rows[0].old_values.includes('a-admin'));

    // B shares tenant A but is a different organisation: its own setting, off, and not available.
    const bState = await api.call('GET', '/api/teams-setup/org/app-import', { user: ADMIN_B });
    assert.equal(bState.body.settings.enabled, false);
    assert.equal(bState.body.availability.reason, 'tenant_not_bound');
    const bOn = await api.call('PUT', '/api/teams-setup/org/app-import', { user: ADMIN_B, body: { enabled: true, coverage: 'all', selectedUserIds: [] } });
    assert.equal(bOn.status, 409);
    assert.equal(bOn.body.code, 'app_import_unavailable');
    assert.equal((await configStore.getConfigFresh('org_org-a_teams_app_import')).enabled, true, "B's attempt did not touch A");

    const overviewA = await api.call('GET', '/api/teams-setup/org/overview', { user: ADMIN_A });
    assert.deepEqual(overviewA.body.members.map((m) => [m.userId, m.appImportCovered]).sort(), [['a-admin', true], ['a-member', false]]);
    const overviewB = await api.call('GET', '/api/teams-setup/org/overview', { user: ADMIN_B });
    assert.ok(overviewB.body.members.every((m) => m.appImportCovered === false), 'the same tenant in org B is not covered');

    const off = await api.call('PUT', '/api/teams-setup/org/app-import', { user: ADMIN_A, body: { enabled: false, coverage: 'selected', selectedUserIds: ['a-admin'] } });
    assert.equal(off.status, 200);
    assert.equal(off.body.settings.tenantId, null);
    const actions = (await pg.query(`SELECT action FROM access_audit_log WHERE action LIKE 'teams_app_import%' ORDER BY created_at`)).rows.map((r) => r.action);
    assert.deepEqual(actions, ['teams_app_import_enabled', 'teams_app_import_disabled']);
});

test('option B: ids of another organisation are refused with a count only; too many; a strict body', async () => {
    useB();
    const outsider = await api.call('PUT', '/api/teams-setup/org/app-import', { user: ADMIN_A, body: { enabled: false, coverage: 'selected', selectedUserIds: ['a-member', 'b-member', 'b-admin'] } });
    assert.equal(outsider.status, 400);
    assert.equal(outsider.body.code, 'not_a_member');
    assert.ok(!outsider.text.includes('b-member') && !outsider.text.includes('b-admin'), 'the message never names the ids');
    assert.match(outsider.body.error, /^2 of/);

    process.env.TEAMS_APP_IMPORT_MAX_SELECTED_USERS = '1';
    try {
        const tooMany = await api.call('PUT', '/api/teams-setup/org/app-import', { user: ADMIN_A, body: { enabled: false, coverage: 'selected', selectedUserIds: ['a-member', 'a-admin'] } });
        assert.equal(tooMany.status, 400);
        assert.equal(tooMany.body.code, 'too_many_selected');
    } finally {
        delete process.env.TEAMS_APP_IMPORT_MAX_SELECTED_USERS;
    }
    for (const body of [{ enabled: true, coverage: 'all', selectedUserIds: [], orgId: 'org-b' }, { enabled: 'yes', coverage: 'all', selectedUserIds: [] }, { enabled: true, coverage: 'all' }]) {
        assert.equal((await api.call('PUT', '/api/teams-setup/org/app-import', { user: ADMIN_A, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await api.call('PUT', '/api/teams-setup/org/app-import?orgId=org-b', { user: ADMIN_A, body: { enabled: false, coverage: 'all', selectedUserIds: [] } })).status, 400);
});

test('option B diagnostics: a probe member of another org is refused, the report has no token, and it is rate limited', async () => {
    useB();
    const configStore = require('../stores/configStore');
    await configStore.setConfig('azure_group_sync_binding', { syncOrganizationId: 'org-a', syncTenantId: TENANT_A });
    await configStore.setConfig('org_org-a_teams_app_import', { enabled: true, coverage: 'all', selectedUserIds: [], tenantId: TENANT_A });
    orgTenant.resetOrgTenantMemo();
    tokenRequests.length = 0;

    const foreign = await api.call('POST', '/api/teams-setup/org/app-import/diagnostics', { user: ADMIN_A, body: { probeUserId: 'b-admin' } });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.code, 'not_a_member');
    rateLimit.resetDiagnosticsSlots();

    const res = await api.call('POST', '/api/teams-setup/org/app-import/diagnostics', { user: ADMIN_A, body: {} });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.level, 'org_app');
    const byId = Object.fromEntries(res.body.checks.map((c) => [c.id, c]));
    assert.equal(byId['b.app_token'].status, 'pass');
    assert.equal(byId['b.role_calendar'].status, 'pass');
    assert.equal(byId['b.role_recordings'].code, 'role_missing');
    assert.deepEqual(byId['b.probe_user'].params, { self: true });
    assert.equal(byId['b.calendar'].code, 'no_teams_meetings');
    assert.deepEqual(tokenRequests, [`https://login.microsoftonline.com/${TENANT_A}/oauth2/v2.0/token`]);
    assertNoBLeak(res, 'app-import diagnostics');

    const again = await api.call('POST', '/api/teams-setup/org/app-import/diagnostics', { user: ADMIN_A });
    assert.equal(again.status, 429);
    assert.equal(again.body.code, 'diagnostics_rate_limited');
    await configStore.setConfig('org_org-a_teams_app_import', { enabled: false });
    membersOverview.init();
});
