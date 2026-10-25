// @typecheck strict
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeProjectTaskStore } = require('./projectTaskStore');

test('makeProjectTaskStore exposes exactly the documented API', () => {
    const store = makeProjectTaskStore({ query: async () => ({ rows: [] }) });
    assert.deepEqual(Object.keys(store).sort(), [
        'advancePokerSession', 'cancelPokerSession', 'castPokerVote', 'createTask', 'deleteTask', 'dropLinksTo',
        'finishPokerSession', 'getPokerSession', 'getTask', 'listBoard', 'listSearchTasks', 'listTasks', 'moveTask',
        'revealPokerVotes', 'startPokerSession', 'tasksFromMeeting', 'unassignUser', 'updateTask',
    ]);
});
