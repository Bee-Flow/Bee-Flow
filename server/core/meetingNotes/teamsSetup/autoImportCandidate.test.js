'use strict';
/**
 * Whether the Teams poller still visits a user (the rule of discoverUser):
 * the effective autoImport setting, or a live explicit record mark.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/autoImportCandidate.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const candidate = require('./autoImportCandidate.mts');

function setup({ on = [], marked = [] } = {}) {
    const seen = { resolved: [], prefLoads: 0, markLists: 0 };
    candidate.init({
        resolveTeamsNotesSettings: async ({ orgId, userId }) => { seen.resolved.push([orgId, userId]); return { autoImport: on.includes(userId) }; },
        loadMeetingPrefs: async ({ provider, userId }) => { seen.prefLoads++; assert.equal(provider, 'teams'); return { rows: marked.includes(userId) ? [{ userId, record: true }] : [] }; },
        hasLiveRecordOptIn: (rows) => rows.some((r) => r.record === true),
        listUsersWithRecordOptIn: async ({ provider }) => { seen.markLists++; assert.equal(provider, 'teams'); return marked; },
    });
    return seen;
}

test.afterEach(() => candidate.init());

test('one user: the setting, else a live mark', async () => {
    let seen = setup({ on: ['u-on'], marked: ['u-marked'] });
    assert.equal(await candidate.isAutoImportCandidate({ userId: 'u-on', orgId: 'org-a' }), true);
    assert.equal(seen.prefLoads, 0, 'no preference read when the setting is on');
    assert.equal(await candidate.isAutoImportCandidate({ userId: 'u-marked', orgId: 'org-a' }), true);
    assert.equal(await candidate.isAutoImportCandidate({ userId: 'u-off', orgId: 'org-a' }), false);

    seen = setup();
    assert.equal(await candidate.isAutoImportCandidate({ userId: 'u-x', orgId: 'org-a', autoImport: true }), true);
    assert.deepEqual(seen.resolved, [], 'a known setting is not read again');
});

test('many users: one mark query, only when someone has the setting off', async () => {
    let seen = setup({ on: ['a', 'b'] });
    assert.deepEqual([...await candidate.autoImportCandidates({ orgId: 'org-a', userIds: ['a', 'b'] })], ['a', 'b']);
    assert.equal(seen.markLists, 0);
    assert.deepEqual(seen.resolved, [['org-a', 'a'], ['org-a', 'b']]);

    seen = setup({ on: ['a'], marked: ['c'] });
    assert.deepEqual([...await candidate.autoImportCandidates({ orgId: 'org-a', userIds: ['a', 'b', 'c'] })], ['a', 'c']);
    assert.equal(seen.markLists, 1);
});
