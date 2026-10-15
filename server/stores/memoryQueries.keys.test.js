'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryQueries } = require('./memoryQueries');

test('createMemoryQueries exposes exactly the documented API, in order', () => {
    const q = createMemoryQueries({ db: {}, ensureReady: async () => {} });
    assert.deepEqual(Object.keys(q), [
        'presentMemories', 'listMemories', 'listActiveByIds', 'listRecent', 'listReview', 'getStats',
        'setType', 'deleteByConversation', 'deleteSensitiveForUser', 'deleteSensitiveForOrg', 'listOrgUserIds', 'listForExport',
    ]);
});
