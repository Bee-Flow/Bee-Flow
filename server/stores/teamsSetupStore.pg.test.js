'use strict';
/**
 * The read-only queries of the Teams members overview, on a real Postgres
 * (PGlite behind db.js): the org filter, active members only, the limit and
 * its truncation flag, failure counts per window, and no token, title or
 * e-mail column selected.
 *
 * Run: cd server && node --test stores/teamsSetupStore.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'teams-setup-test-master-key-0123456789abcdef0123';

const { usePglitePool } = require('../testUtils/pglitePool');
const { pg, close } = usePglitePool();

const TENANT = '11111111-2222-3333-4444-555555555555';
const OID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
let store;

before(async () => {
    const userStore = require('./userStore');
    await userStore.initDB();
    await require('./automationCredentialStore').initDB();
    await require('./teamsImportStore').initDB();
    const mk = (id, org, extra = {}) => userStore.createUser({ id, username: id, email: `${id}@fixture.test`, organizationId: org, passwordHash: 'x', ...extra });
    await mk('a-zed', 'org-a', { displayName: 'Zed' });
    await mk('a-amy', 'org-a', { displayName: 'Amy', azureTenantId: TENANT.toUpperCase(), azureUserId: OID });
    await mk('a-bob', 'org-a', { displayName: 'Bob' });
    await mk('a-gone', 'org-a', { displayName: 'Gone', status: 'suspended' });
    await mk('b-eve', 'org-b', { displayName: 'Eve' });
    await pg.query(`INSERT INTO automation_credentials (user_id, org_id, provider, access_token, refresh_token, scope, status, last_error)
        VALUES ('a-amy', 'org-a', 'microsoft', 'fixture-access-token', 'fixture-refresh-token', 'Calendars.ReadWrite', 'active', 'Fixture subject 7'),
               ('a-zed', 'org-a', 'microsoft', NULL, NULL, 'openid', 'needs_reauth', NULL),
               ('a-zed', 'org-a', 'google', NULL, NULL, 'x', 'active', NULL),
               ('b-eve', 'org-b', 'microsoft', NULL, NULL, 'openid', 'active', NULL)`);
    const job = (user, org, event, code, ageDays) => pg.query(
        `INSERT INTO teams_import_jobs (user_id, org_id, calendar_event_id, join_url, title, status, error_code, last_error, updated_at)
         VALUES ($1, $2, $3, 'https://teams.microsoft.com/l/fixture', 'Fixture subject 7', 'failed', $4, 'Fixture subject 7', NOW() - ($5::int * INTERVAL '1 day'))`,
        [user, org, event, code, ageDays]);
    await job('a-amy', 'org-a', 'e1', 'graph_forbidden', 1);
    await job('a-amy', 'org-a', 'e2', 'graph_forbidden', 2);
    await job('a-amy', 'org-a', 'e3', 'no_recording', 3);
    await job('a-amy', 'org-a', 'e4', 'graph_forbidden', 20);
    await job('a-bob', 'org-a', 'e7', 'meeting_not_available', 1);
    await job('a-bob', 'org-a', 'e8', 'needs_reauth', 1);
    await job('a-zed', 'org-a', 'e5', null, 1);
    await job('b-eve', 'org-b', 'e6', 'graph_forbidden', 1);
    store = require('./teamsSetupStore.mts');
}, { timeout: 120_000 });

after(close);

test("lists only the org's active members, sorted by display name else username", async () => {
    const { rows, truncated } = await store.listOrgMemberRows('org-a', 0);
    assert.equal(truncated, false);
    assert.deepEqual(rows.map((r) => r.userId), ['a-amy', 'a-bob', 'a-zed']);
    const amy = rows[0];
    assert.deepEqual(amy, {
        userId: 'a-amy', displayName: 'Amy', username: 'a-amy', azureTenantId: TENANT, azureUserId: OID.toLowerCase(),
        credentialStatus: 'active', credentialScope: 'Calendars.ReadWrite',
    });
    assert.equal(rows[2].credentialStatus, 'needs_reauth', 'the microsoft row, not the google one');
    assert.equal(rows[1].credentialStatus, null);
});

test('no token, title, last_error or e-mail is selected', async () => {
    const text = JSON.stringify(await store.listOrgMemberRows('org-a', 0));
    for (const leak of ['fixture-access-token', 'fixture-refresh-token', 'Fixture subject 7', '@fixture.test']) {
        assert.ok(!text.includes(leak), leak);
    }
});

test('the limit truncates and says so; 0 is no limit', async () => {
    const two = await store.listOrgMemberRows('org-a', 2);
    assert.deepEqual(two.rows.map((r) => r.userId), ['a-amy', 'a-bob']);
    assert.equal(two.truncated, true);
    const three = await store.listOrgMemberRows('org-a', 3);
    assert.equal(three.truncated, false);
    assert.equal(three.rows.length, 3);
    assert.deepEqual(await store.listOrgMemberRows('', 0), { rows: [], truncated: false });
});

test('failure counts per user and code inside the window, for one org only; expected outcomes are no failures', async () => {
    const week = await store.countRecentTeamsFailures('org-a', 7);
    const sorted = week.sort((a, b) => a.code.localeCompare(b.code));
    assert.deepEqual(sorted, [
        { userId: 'a-amy', code: 'graph_forbidden', count: 2 },
        { userId: 'a-bob', code: 'needs_reauth', count: 1 },
    ], 'no_recording and meeting_not_available are not counted');
    const month = await store.countRecentTeamsFailures('org-a', 30);
    assert.equal(month.find((r) => r.code === 'graph_forbidden').count, 3);
    assert.ok(!(await store.countRecentTeamsFailures('org-a', 30)).some((r) => r.userId === 'b-eve'));
});
