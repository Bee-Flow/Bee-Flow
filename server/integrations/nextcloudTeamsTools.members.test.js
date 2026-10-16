/** Teams: add_members reports per user what really happened. */
const test = require('node:test');
const assert = require('node:assert/strict');
const ncClient = require('./nextcloudClient');
const { json, installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');

test.after(resetFakeNc);
const { executeNextcloudTeamsTool } = require('./nextcloudTeamsTools');

function install(validUsers) {
    const members = [{ id: 'm0', userId: 'owner1', level: 9 }];
    return installFakeNc(({ url, method, body }) => {
        if (method === 'POST' && /members\/multi$/.test(url)) {
            for (const m of body.members) {
                if (validUsers.includes(m.id)) members.push({ id: `m-${m.id}`, userId: m.id, level: 1 });
            }
            return json(200, { ocs: { data: [] } });
        }
        if (/\/members$/.test(url)) return json(200, { ocs: { data: members } });
        if (method === 'POST') return json(200, { ocs: { data: { id: 'c1', name: 'T', population: 0 } } });
        return json(403, { ocs: { meta: { message: 'no' } } });
    });
}

test('add_members separates added, skipped and failed users', async () => {
    install(['alice1']);
    const out = await executeNextcloudTeamsTool('nextcloud_teams_add_members', { teamId: 'c1', userIds: ['alice1', 'nosuchuser', 'owner1'] }, 'u', {});
    assert.deepEqual(out.added, ['alice1']);
    assert.deepEqual(out.skipped, ['owner1']);
    assert.deepEqual(out.errors.map(e => e.userId), ['nosuchuser']);
    assert.match(out.error, /Not added: nosuchuser/);
    assert.equal(out.success, undefined);
});

test('add_members with only valid users is a success', async () => {
    install(['alice1']);
    const out = await executeNextcloudTeamsTool('nextcloud_teams_add_members', { teamId: 'c1', userIds: ['alice1'] }, 'u', {});
    assert.equal(out.success, true);
    assert.deepEqual(out.errors, []);
});

test('create reports the owner as a member', async () => {
    install([]);
    const out = await executeNextcloudTeamsTool('nextcloud_teams_create', { name: 'T' }, 'u', {});
    assert.equal(out.team.memberCount, 1);
});

test('a 403 is a permission error, not a connector outage', async () => {
    install([]);
    const out = await executeNextcloudTeamsTool('nextcloud_teams_get', { teamId: 'bogus' }, 'u', {});
    assert.match(out.error, /Permission denied/);
    assert.doesNotMatch(out.error, /connector/i);
});

test('a group member does not count as the user being a member', async () => {
    install([]);
    const base = ncClient.resolveAuth;
    ncClient.resolveAuth = async () => {
        const ctx = await base();
        const groupMember = { id: 'g', userId: 'alice1', userType: 2 };
        const withGroup = async (url, opts = {}) => {
            if (/\/members$/.test(url) && !opts.method) return json(200, { ocs: { data: [groupMember] } });
            return ctx.fetch(url, opts);
        };
        return { ...ctx, fetch: withGroup };
    };
    const out = await executeNextcloudTeamsTool('nextcloud_teams_add_members', { teamId: 'c1', userIds: ['alice1'] }, 'u', {});
    assert.deepEqual(out.skipped, []);
});

test('a failed verification read after a sent add is an error that says so', async () => {
    install(['alice1']);
    const base = ncClient.resolveAuth;
    let lists = 0;
    ncClient.resolveAuth = async () => {
        const ctx = await base();
        const secondListFails = async (url, opts = {}) => {
            if (/\/members$/.test(url) && !opts.method && ++lists === 2) return json(500, 'x');
            return ctx.fetch(url, opts);
        };
        return { ...ctx, fetch: secondListFails };
    };
    const out = await executeNextcloudTeamsTool('nextcloud_teams_add_members', { teamId: 'c1', userIds: ['alice1'] }, 'u', {});
    assert.match(out.error, /could not be verified/);
});
