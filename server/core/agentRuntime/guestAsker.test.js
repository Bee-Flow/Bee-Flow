// @typecheck
'use strict';
/**
 * Who counts as a visitor, and when the owner's tools are withheld from one
 * (core/agentRuntime/guestAsker.js).
 *
 * Run: cd server && node --test core/agentRuntime/guestAsker.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isGuestAsker, withholdOwnerToolsFrom, visitorsMayUseOwnerTools, VISITOR_TOOLS_FLAG } = require('./guestAsker');

test('a guest id is a visitor; a signed-in id is not, with or without a session', () => {
    assert.equal(isGuestAsker({ userId: 'guest_0123456789abcdef01234567' }), true);
    assert.equal(isGuestAsker({ userId: null }), true, 'no id at all is nobody signed in');
    assert.equal(isGuestAsker({ userId: 'u1' }), false);
    // A schedule or an AI task runs under the owner's id with no session: still the owner.
    assert.equal(withholdOwnerToolsFrom({ userId: 'owner-1', agentConfig: null }), false);
});

test('owner-standing tools are withheld from a visitor unless the owner opened them for this agent', () => {
    assert.equal(withholdOwnerToolsFrom({ userId: 'guest_abc', agentConfig: null }), true);
    assert.equal(withholdOwnerToolsFrom({ userId: 'guest_abc', agentConfig: { tools: {} } }), true);
    assert.equal(withholdOwnerToolsFrom({ userId: 'guest_abc', agentConfig: { tools: { [VISITOR_TOOLS_FLAG]: true } } }), false);
    // Only a literal true opens the door: a truthy string in a stored config is not a choice.
    assert.equal(withholdOwnerToolsFrom({ userId: 'guest_abc', agentConfig: { tools: { [VISITOR_TOOLS_FLAG]: 'yes' } } }), true);
    assert.equal(visitorsMayUseOwnerTools({ tools: [VISITOR_TOOLS_FLAG] }), false, 'an array is not a tools map');
    assert.equal(visitorsMayUseOwnerTools('x'), false);
});
