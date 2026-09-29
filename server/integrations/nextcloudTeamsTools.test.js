/**
 * Nextcloud Teams (Circles) tools.
 *
 * Two things here are easy to get subtly wrong and impossible to notice at a
 * glance: the member id is NOT the Nextcloud user id (removing the wrong one
 * silently no-ops or removes someone else), and levels are integers upstream
 * while agents reason in names.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    NEXTCLOUD_TEAMS_TOOLS,
    isNextcloudTeamsTool,
    MEMBER_LEVELS,
    mapTeam,
    mapMember,
} = require('./nextcloudTeamsTools');

test('the prefix test covers the share tool without swallowing plain shares', () => {
    assert.equal(isNextcloudTeamsTool('nextcloud_teams_list'), true);
    assert.equal(isNextcloudTeamsTool('nextcloud_share_with_team'), true);
    // These belong to nextcloudTools.js — matching them here would shadow the
    // real handler, since the dispatcher checks sub-apps before the generic
    // nextcloud_ prefix.
    assert.equal(isNextcloudTeamsTool('nextcloud_share_with_group'), false);
    assert.equal(isNextcloudTeamsTool('nextcloud_share_with_user'), false);
    assert.equal(isNextcloudTeamsTool('nextcloud_create_share'), false);
});

test('every tool declares a name, description and parameters object', () => {
    for (const t of NEXTCLOUD_TEAMS_TOOLS) {
        assert.equal(t.type, 'function');
        assert.ok(t.function.description.length > 20, `${t.function.name} needs a real description`);
        assert.equal(t.function.parameters.type, 'object');
    }
});

test('member levels round-trip between name and integer', () => {
    assert.equal(MEMBER_LEVELS.member, 1);
    assert.equal(MEMBER_LEVELS.moderator, 4);
    assert.equal(MEMBER_LEVELS.admin, 8);
    assert.equal(MEMBER_LEVELS.owner, 9);
    // The level tool must not offer 'owner' — ownership transfer is a
    // different upstream operation.
    const levelTool = NEXTCLOUD_TEAMS_TOOLS.find(t => t.function.name === 'nextcloud_teams_set_member_level');
    assert.deepEqual(levelTool.function.parameters.properties.level.enum, ['member', 'moderator', 'admin']);
});

test('a team maps to the fields an agent can act on', () => {
    const team = mapTeam({
        id: 'abc123',
        displayName: 'Hiking group',
        description: 'Monthly walks',
        population: 7,
        config: 0,
        initiator: { level: 8 },
    });
    assert.equal(team.id, 'abc123');
    assert.equal(team.name, 'Hiking group');
    assert.equal(team.memberCount, 7);
    assert.equal(team.myLevel, 'admin', 'the caller\'s own level decides what they may do next');
    assert.equal(team.personal, false);
});

test('a personal team is flagged from the config bitmask', () => {
    assert.equal(mapTeam({ id: 'x', displayName: 'Mine', config: 2 }).personal, true);
});

test('a member exposes BOTH ids, because they are different things', () => {
    // `id` addresses the membership (what remove/level take); `userId` is the
    // Nextcloud account. Conflating them is the footgun this asserts against.
    const m = mapMember({ id: 'member-77', userId: 'ralph', displayName: 'Ralph', level: 1 });
    assert.equal(m.id, 'member-77');
    assert.equal(m.userId, 'ralph');
    assert.notEqual(m.id, m.userId);
    assert.equal(m.level, 'member');
});

test('an unknown level degrades to its raw value rather than throwing', () => {
    assert.equal(mapMember({ id: 'a', level: 42 }).level, '42');
});

test('the remove tool names the id it actually needs', () => {
    // The description is load-bearing: an agent handed "ralph" instead of the
    // member id gets a confusing 404 from Nextcloud.
    const tool = NEXTCLOUD_TEAMS_TOOLS.find(t => t.function.name === 'nextcloud_teams_remove_member');
    assert.match(tool.function.parameters.properties.memberId.description, /NOT the Nextcloud user id/i);
});
