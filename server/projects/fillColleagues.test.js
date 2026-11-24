'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFillColleagues } = require('./fillColleagues.mts');

const USERS = {
    ann: { displayName: 'Ann Smit' }, bob: { displayName: 'Bob de Vries' }, vic: { displayName: 'Vic Viewer' },
    out: { displayName: 'Other Org' }, mail: { username: 'someone@example.test' },
};

function colleagues(shares) {
    return makeFillColleagues({
        getProjectShares: async () => shares,
        getUser: async (id) => { if (id === 'broken') throw new Error('unreadable'); return USERS[id] || null; },
        inProjectOrg: async (userId) => userId !== 'out',
        displayNameOf: (user) => user.displayName || 'A project member',
    });
}

test('the owner and the people the project is shared with as editors, by name', async () => {
    const list = await colleagues([
        { sharedWithType: 'user', sharedWithId: 'bob', permission: 'editor' },
        { sharedWithType: 'user', sharedWithId: 'vic', permission: 'viewer' },
        { sharedWithType: 'group', sharedWithId: 'g1', permission: 'editor' },
        { sharedWithType: 'user', sharedWithId: 'out', permission: 'editor' },
        { sharedWithType: 'user', sharedWithId: 'broken', permission: 'editor' },
        { sharedWithType: 'user', sharedWithId: 'gone', permission: 'editor' },
        { sharedWithType: 'user', sharedWithId: 'mail', permission: 'editor' },
    ])({ id: 'p1', ownerId: 'ann' });
    assert.deepEqual(list, [{ id: 'mail', name: 'A project member' }, { id: 'ann', name: 'Ann Smit' }, { id: 'bob', name: 'Bob de Vries' }],
        'no viewer, no group, nobody of another organisation, and never an e-mail address as a name');
});

test('a project nobody shares is its owner alone', async () => {
    assert.deepEqual(await colleagues(null)({ id: 'p1', ownerId: 'ann' }), [{ id: 'ann', name: 'Ann Smit' }]);
    assert.deepEqual(await colleagues([])({ id: 'p1' }), []);
});
