'use strict';

/**
 * routes/projects/memberDirectory.js: the labels a member list shows, served
 * with a fake user store and the organisation lookups swapped on their own
 * module object (no module-system mocking).
 *
 * Proven:
 *   - an emoji or a url avatar goes inline; an uploaded picture becomes a link
 *     to the avatar route, versioned by its content; anything else is dropped;
 *   - only people and groups of the project's own organisation are named, from
 *     an allow-list of fields (never an e-mail address);
 *   - a lookup that fails leaves that principal unnamed instead of failing.
 *
 * Run: cd server && node --test routes/projects/memberDirectory.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');

// The organisation answers, swapped BEFORE the module under test destructures them.
const projectOrg = require('../../projects/projectOrg');
const ORGS = { alice: 'org1', bob: 'org1', mallory: 'org2' };
const swaps = makeSwaps();
swaps.swap(projectOrg, 'projectOrgOf', async (project) => project.organizationId || '');
swaps.swap(projectOrg, 'belongsToProjectOrg', async (userId, org) => {
    if (userId === 'broken') throw new Error('directory down');
    return (ORGS[userId] || '') === org;
});
const { memberAvatar, makeMemberDirectory } = require('./memberDirectory');
test.after(swaps.restore);

test('an emoji or url avatar goes inline, an uploaded picture as a versioned link, anything else not at all', () => {
    assert.deepStrictEqual(memberAvatar('p1', 'alice', { avatar: '🐝', avatarType: 'emoji' }), { avatar: '🐝', avatarType: 'emoji' });
    assert.deepStrictEqual(memberAvatar('p1', 'alice', { avatar: '/img/a.png', avatarType: 'url' }), { avatar: '/img/a.png', avatarType: 'url' });

    const picture = memberAvatar('p1', 'a b', { avatar: 'data:image/png;base64,AAAA', avatarType: 'image' });
    assert.strictEqual(picture.avatarType, 'image');
    assert.match(picture.avatar, /^\/api\/projects\/p1\/avatars\/a%20b\?v=[0-9a-f]{10}$/);
    const changed = memberAvatar('p1', 'a b', { avatar: 'data:image/png;base64,BBBB', avatarType: 'image' });
    assert.notStrictEqual(changed.avatar, picture.avatar, 'a changed picture is fetched again');

    assert.strictEqual(memberAvatar('p1', 'alice', { avatar: 'x'.repeat(2049), avatarType: 'url' }), null);
    assert.strictEqual(memberAvatar('p1', 'alice', { avatar: '🐝', avatarType: 'sticker' }), null);
    assert.strictEqual(memberAvatar('p1', 'alice', { avatar: '', avatarType: 'emoji' }), null);
});

test('only the project organisation\'s people and groups are named, never with an address', async () => {
    const users = {
        alice: { id: 'alice', displayName: 'Alice', email: 'alice@example.test', avatar: '🐝', avatarType: 'emoji' },
        bob: { id: 'bob', username: 'bob', email: 'bob@example.test' },
        mallory: { id: 'mallory', displayName: 'Mallory', email: 'm@example.test' },
    };
    const groups = {
        g1: { id: 'g1', name: 'Team', organizationId: 'org1' },
        g2: { id: 'g2', name: 'Other tenant', organizationId: 'org2' },
    };
    const { describeMembers } = makeMemberDirectory({
        userStore: {
            getUser: async (id) => users[id] || null,
            getGroup: async (id) => groups[id] || null,
        },
    });
    const project = { id: 'p1', ownerId: 'alice', organizationId: 'org1' };
    const shares = [
        { sharedWithType: 'user', sharedWithId: 'bob' },
        { sharedWithType: 'user', sharedWithId: 'mallory' },
        { sharedWithType: 'group', sharedWithId: 'g1' },
        { sharedWithType: 'group', sharedWithId: 'g2' },
    ];
    const { people, groups: named } = await describeMembers(project, shares);
    assert.deepStrictEqual(people, {
        alice: { name: 'Alice', avatar: '🐝', avatarType: 'emoji' },
        bob: { name: 'bob' },
    });
    assert.deepStrictEqual(named, { g1: { name: 'Team' } });
    assert.ok(!JSON.stringify({ people, named }).includes('@'), 'no e-mail address in the answer');
});

test('a lookup that fails leaves that principal unnamed instead of failing the list', async () => {
    const { describeMembers } = makeMemberDirectory({
        userStore: {
            getUser: async (id) => { if (id === 'ghost') throw new Error('db down'); return { id, displayName: id }; },
            getGroup: async () => { throw new Error('db down'); },
        },
    });
    const project = { id: 'p1', ownerId: 'alice', organizationId: 'org1' };
    const { people, groups } = await describeMembers(project, [
        { sharedWithType: 'user', sharedWithId: 'ghost' },
        { sharedWithType: 'user', sharedWithId: 'broken' },
        { sharedWithType: 'group', sharedWithId: 'g1' },
    ]);
    assert.deepStrictEqual(people, { alice: { name: 'alice' } });
    assert.deepStrictEqual(groups, {});
});
