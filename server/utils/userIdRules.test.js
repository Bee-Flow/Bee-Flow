'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { userIdProblem, isAllowedUserId } = require('./userIdRules');

test('ordinary usernames and e-mail addresses are fine', () => {
    for (const id of ['alice', 'alice.b', 'a-b_c', 'alice@example.com', 'Jan de Vries', 'ünï']) {
        assert.strictEqual(userIdProblem(id), null, id);
    }
});

test('an id that would name another path, prefix or route is refused', () => {
    // each of these was a working exploit: storage prefix nesting, directory
    // traversal, and a raw-versus-decoded URL segment
    for (const id of ['alice/uploads', '../../../../proc/self', 'a\\b', 'vic%74im', 'a?b', 'a#b', 'a\nb', '.', '..']) {
        assert.strictEqual(isAllowedUserId(id), false, JSON.stringify(id));
    }
});

test('the owner ids of the built-in agents cannot be registered', () => {
    for (const id of ['system', 'swarm', 'System', ' SWARM ']) assert.strictEqual(userIdProblem(id), 'reserved', id);
    assert.strictEqual(userIdProblem('systems'), null);
});

test('nothing that is not a non-empty string is an id', () => {
    for (const id of ['', null, undefined, 42]) assert.strictEqual(userIdProblem(id), 'empty');
});
