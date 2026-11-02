'use strict';
/**
 * runInputPiiGate: a failure before the scan gave a verdict follows the
 * failure mode validateInputForPii applies (org, global, else fail_closed).
 * Run: cd server && node --test core/agentRuntime/inputPiiGate.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { runInputPiiGate } = require('./inputPiiGate');

const events = [];
const deps = {
    logGuardrailEvent: async (e) => { events.push(e); },
    validateInputForPii: async () => { throw new Error('config read failed'); },
    startPrivacyScanPhase: () => ({ onProgress: () => {}, end: () => {} }),
    messageText: () => '',
    dlpRunner: () => ({ getConversationTokenMapAsync: async () => ({}) }),
};
const run = (extra) => runInputPiiGate({
    messages: [{ role: 'user', content: 'hi' }], orgShield: null, orgPiiEnabled: true, onEvent: () => {},
    userId: 'u1', conversationId: 'c1', model: 'm', eventCtx: {}, piiReport: {}, processedUserMessage: 'hi', ...extra,
}, deps);

test('a shield with no mode set anywhere: the default fail_closed blocks the turn', async () => {
    const out = await run({ orgShield: {} });
    assert.match(String(out.moderationViolation), /Privacy protection temporarily unavailable/);
    assert.ok(events.some((e) => e.action_taken === 'blocked'));
});

test('an explicit fail_open (org or global) lets it through, as before', async () => {
    assert.equal((await run({ orgShield: {}, globalFailureMode: 'fail_open' })).moderationViolation, null);
    assert.equal((await run({ orgShield: { piiFailureMode: 'fail_open' } })).moderationViolation, null);
});

test('no shield resolved: no policy to apply, the turn continues', async () => {
    assert.equal((await run({})).moderationViolation, null);
});
