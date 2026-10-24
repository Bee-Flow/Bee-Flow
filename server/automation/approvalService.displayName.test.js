// @typecheck
'use strict';
/**
 * BFSF-389 - the approver's name comes from the real users columns
 * (displayName, username, email); `users` has no `name` column.
 *
 * Run: node --test automation/approvalService.displayName.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { userDisplayName } = require('./approvalService');

test('displayName wins, then username, then email', () => {
    assert.equal(userDisplayName({ displayName: 'Anne', username: 'anne', email: 'a@x.nl' }), 'Anne');
    assert.equal(userDisplayName({ username: 'anne', email: 'a@x.nl' }), 'anne');
    assert.equal(userDisplayName({ email: 'a@x.nl' }), 'a@x.nl');
});

test('a stray `name` field is ignored; a missing user gives null', () => {
    assert.equal(userDisplayName({ name: 'ghost', email: 'a@x.nl' }), 'a@x.nl');
    assert.equal(userDisplayName(null), null);
});
