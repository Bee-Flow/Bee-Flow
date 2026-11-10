'use strict';
/**
 * The organisation admin's Teams overview, with the store and the other
 * collaborators injected: rows, totals, the skip state of another org
 * ignored, the org checks, and nothing outside the row type in the answer.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/membersOverview.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const overview = require('./membersOverview.mts');
const settings = require('../teamsNotesSettings');

const TENANT = '11111111-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FULL = 'Calendars.ReadWrite OnlineMeetingRecording.Read.All OnlineMeetingTranscript.Read.All OnlineMeetings.ReadWrite';
const config = { providers: { microsoft: { clientId: OID, clientSecret: 'fixture-not-a-secret', tenantId: TENANT } } };

const ROWS = [
    { userId: 'u-amy', displayName: 'Amy', username: 'amy', azureTenantId: TENANT, azureUserId: OID, credentialStatus: 'active', credentialScope: FULL },
    { userId: 'u-bob', displayName: 'Bob', username: 'bob', azureTenantId: null, azureUserId: null, credentialStatus: 'active', credentialScope: 'Calendars.ReadWrite' },
    { userId: 'u-cy', displayName: null, username: 'cy', azureTenantId: TENANT, azureUserId: 'not-a-guid', credentialStatus: 'needs_reauth', credentialScope: FULL },
    { userId: 'u-dee', displayName: 'Dee', username: 'dee', azureTenantId: null, azureUserId: null, credentialStatus: null, credentialScope: null },
];

function setup(over = {}) {
    const seen = { capability: [], limit: null, days: null, skipIds: null };
    overview.init({
        store: {
            listOrgMemberRows: async (orgId, limit) => { seen.limit = limit; seen.orgId = orgId; return { rows: ROWS, truncated: true }; },
            countRecentTeamsFailures: async (orgId, days) => { seen.days = days; return [
                { userId: 'u-amy', code: 'failed', count: 1 },
                { userId: 'u-amy', code: 'graph_forbidden', count: 3 },
                { userId: 'u-bob', code: 'calendar_forbidden', count: 2 },
            ]; },
        },
        hasCapability: async (cap, ctx) => { seen.capability.push([cap, ctx]); return ctx.userId !== 'u-dee'; },
        settings: {
            getOrgSettings: async () => ({ autoImport: false, autoRecordConfig: null, language: null }),
            hasTeamsScopes: settings.hasTeamsScopes,
            missingTeamsPermissions: settings.missingTeamsPermissions,
        },
        skipState: { readSkips: async (ids) => { seen.skipIds = ids; return new Map([
            ['u-bob', { reason: 'missing_scopes', missingPermissions: ['OnlineMeetingRecording.Read.All'], at: '2026-11-10T06:00:00.000Z', orgId: 'org-a' }],
            ['u-dee', { reason: 'no_credential', missingPermissions: [], at: '2026-11-10T06:00:00.000Z', orgId: 'org-b' }],
        ]); } },
        autoImportCandidates: async ({ orgId, userIds }) => { seen.candidateAsk = { orgId, userIds }; return new Set(userIds); },
        readAdminConsentOutcome: async () => ({ outcome: 'granted', error: null, aadsts: null, tenantId: TENANT, at: '2026-11-09T12:00:00.000Z' }),
        appImportCovered: async (a) => { seen.coverage = a; return new Set(); },
        log: { warn: () => {} },
        ...over,
    });
    return seen;
}

test.afterEach(() => overview.init());

test('rows, totals and org settings from stored state', async () => {
    const seen = setup();
    const o = await overview.buildOrgOverview({ orgId: 'org-a', days: 14, config, callerTenantId: null, now: new Date('2026-11-10T08:00:00Z') });
    assert.equal(seen.orgId, 'org-a');
    assert.equal(seen.days, 14);
    assert.equal(seen.limit, 2000);
    assert.deepEqual(seen.skipIds, ['u-amy', 'u-bob', 'u-cy', 'u-dee']);
    assert.ok(seen.capability.every(([cap, ctx]) => cap === 'meeting_notes' && ctx.orgId === 'org-a'));
    assert.equal(o.windowDays, 14);
    assert.equal(o.generatedAt, '2026-11-10T08:00:00.000Z');
    assert.equal(o.truncated, true);
    assert.deepEqual(o.settings, { autoImport: false, autoRecordConfig: null });

    const [amy, bob, cy, dee] = o.members;
    assert.deepEqual(amy, {
        userId: 'u-amy', displayName: 'Amy', username: 'amy', meetingNotesAccess: true, microsoft: 'active', missingPermissions: [],
        teamsReady: true, verifiedMicrosoftIdentity: true, autoImportSkip: null,
        failures: [{ code: 'graph_forbidden', count: 3 }, { code: 'failed', count: 1 }], appImportCovered: false,
    });
    assert.deepEqual(bob.missingPermissions, ['OnlineMeetingRecording.Read.All', 'OnlineMeetingTranscript.Read.All', 'OnlineMeetings.ReadWrite']);
    assert.equal(bob.teamsReady, false);
    assert.deepEqual(bob.autoImportSkip, { reason: 'missing_scopes', missingPermissions: ['OnlineMeetingRecording.Read.All'], at: '2026-11-10T06:00:00.000Z' });
    assert.equal(cy.microsoft, 'needs_reauth');
    assert.equal(cy.verifiedMicrosoftIdentity, false);
    assert.equal(dee.microsoft, 'none');
    assert.deepEqual(dee.missingPermissions, []);
    assert.equal(dee.meetingNotesAccess, false);
    assert.equal(dee.autoImportSkip, null, "a skip recorded for another org is ignored");

    assert.deepEqual(o.totals, { members: 4, connected: 2, missingPermissions: 1, needsReauth: 1, skipped: 1, failedImports: 6 });
});

test('a stored skip of a member the poller no longer visits is not shown and not counted', async () => {
    const seen = setup({ autoImportCandidates: async (a) => { seen.candidateAsk = a; return new Set(); } });
    const o = await overview.buildOrgOverview({ orgId: 'org-a', config, callerTenantId: null });
    assert.deepEqual(seen.candidateAsk, { orgId: 'org-a', userIds: ['u-bob'] }, "only members with this org's skip are asked about");
    assert.ok(o.members.every((m) => m.autoImportSkip === null));
    assert.equal(o.totals.skipped, 0);

    setup({ autoImportCandidates: async () => { throw new Error('down'); } });
    const kept = await overview.buildOrgOverview({ orgId: 'org-a', config, callerTenantId: null });
    assert.equal(kept.totals.skipped, 1, 'unreadable candidacy keeps the skip');
});

test('a username that is an e-mail address is never sent', async () => {
    const rows = [
        { ...ROWS[0], username: 'member@fixture.test' },
        { ...ROWS[1], displayName: null },
    ];
    setup({ store: { listOrgMemberRows: async () => ({ rows, truncated: false }), countRecentTeamsFailures: async () => [] } });
    const o = await overview.buildOrgOverview({ orgId: 'org-a', config, callerTenantId: null });
    assert.deepEqual(o.members.map((m) => [m.userId, m.displayName, m.username]), [['u-amy', 'Amy', null], ['u-bob', null, 'bob']]);
    assert.ok(!JSON.stringify(o).includes('@'));
    assert.equal(overview.shownUsername(null), null);
});

test('the org checks: consent link and the recorded consent', async () => {
    setup();
    const o = await overview.buildOrgOverview({ orgId: 'org-a', config, callerTenantId: null });
    assert.equal(o.windowDays, 7);
    assert.deepEqual(o.checks.map((c) => [c.id, c.status, c.code]), [
        ['org.consent_link', 'pass', 'ok'],
        ['org.admin_consent', 'pass', 'consent_granted'],
    ]);
    assert.deepEqual(o.checks[0].params, { tenantSource: 'configured', tenantId: TENANT });
});

test('the answer carries only the row type: no scope string, identity, e-mail or token', async () => {
    setup();
    const o = await overview.buildOrgOverview({ orgId: 'org-a', config, callerTenantId: null });
    const keys = ['userId', 'displayName', 'username', 'meetingNotesAccess', 'microsoft', 'missingPermissions', 'teamsReady',
        'verifiedMicrosoftIdentity', 'autoImportSkip', 'failures', 'appImportCovered'];
    for (const m of o.members) assert.deepEqual(Object.keys(m).sort(), [...keys].sort());
    const text = JSON.stringify(o.members);
    for (const leak of [OID, FULL, 'fixture-not-a-secret', 'not-a-guid']) assert.ok(!text.includes(leak), leak);
});

test('an unreadable part degrades to empty, a capability error to no access', async () => {
    setup({
        hasCapability: async () => { throw new Error('down'); },
        skipState: { readSkips: async () => { throw new Error('down'); } },
        readAdminConsentOutcome: async () => { throw new Error('down'); },
    });
    const o = await overview.buildOrgOverview({ orgId: 'org-a', config, callerTenantId: null });
    assert.ok(o.members.every((m) => m.meetingNotesAccess === false && m.autoImportSkip === null));
    assert.equal(o.checks[1].code, 'consent_not_recorded');
});

test('appImportCovered: who the organisation app import covers now, from the same rows and access answers', async () => {
    const seen = setup({ appImportCovered: async (a) => { seen.coverage = a; return new Set(['u-amy']); } });
    const o = await overview.buildOrgOverview({ orgId: 'org-a', config, callerTenantId: null });
    assert.deepEqual(o.members.map((m) => [m.userId, m.appImportCovered]), [['u-amy', true], ['u-bob', false], ['u-cy', false], ['u-dee', false]]);
    assert.equal(seen.coverage.orgId, 'org-a');
    assert.equal(seen.coverage.rows, ROWS);
    assert.equal(seen.coverage.config, config);
    assert.equal(seen.coverage.access.get('u-dee'), false, 'the capability answers already asked are reused');
    assert.equal(seen.capability.length, 4, 'no second round of capability checks');
});

test('appImportCovered: an unreadable coverage is false for everyone', async () => {
    setup({ appImportCovered: async () => { throw new Error('down'); } });
    const o = await overview.buildOrgOverview({ orgId: 'org-a', config, callerTenantId: null });
    assert.ok(o.members.every((m) => m.appImportCovered === false));
});
