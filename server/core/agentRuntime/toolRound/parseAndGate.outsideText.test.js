/**
 * Gate 1b of a tool round (./parseAndGate.js): a Cowork run that read outside text sends nothing more
 * (core/cowork/outsideTextGuard.mts). The round's context and the policy decision are handed in, so nothing is mocked.
 *
 * Run: cd server && node --test core/agentRuntime/toolRound/parseAndGate.outsideText.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { gateOfferedName } = require('./parseAndGate');
const { decideToolCall } = require('../toolPolicy/callDecision');
const { createRunActivity, noteToolOutcome, summariseActivity } = require('../../cowork/runActivity.mts');

function round(metadata) {
    const events = [];
    return { events, rc: { onEvent: (name, data) => events.push([name, data]), toolPolicy: null, messageMetadata: metadata } };
}
const call = (toolName) => ({ toolCall: { id: `id-${toolName}`, function: { name: toolName } }, toolName, toolArgs: {} });

test('in a Cowork run, a send after a web read is refused before it runs, with the reason the run\'s history keeps', () => {
    const coworkRun = createRunActivity({ appOf: () => null });
    const { rc, events } = round({ coworkRun });
    assert.strictEqual(gateOfferedName(rc, { decideToolCall }, call('outlook_compose')).refusal, null, 'nothing outside read yet');
    assert.strictEqual(gateOfferedName(rc, { decideToolCall }, call('read_url')).refusal, null);
    const held = gateOfferedName(rc, { decideToolCall }, call('outlook_compose')).refusal;
    assert.ok(held);
    assert.strictEqual(held.policyReason, 'outside_text');
    assert.match(String(held.finalToolResult), /no longer sends anything to other people/);
    assert.deepStrictEqual(events.at(-1), ['tool_start', { name: 'outlook_compose', args: {} }]);
    assert.strictEqual(gateOfferedName(rc, { decideToolCall }, call('outlook_create_draft')).refusal, null, 'a draft stays possible');

    noteToolOutcome(coworkRun, held);
    const activity = summariseActivity(coworkRun, new Map());
    assert.deepStrictEqual(activity.tools.find((t) => t.name === 'outlook_compose')?.reasons, ['outside_text']);
    assert.strictEqual(activity.readOutsideText, true);
});

test('a run a new mail started, and a turn that is no Cowork run, are not held here', () => {
    for (const metadata of [{ coworkRun: createRunActivity({ appOf: () => null }), mailTrigger: { messageId: 'm1' } }, {}, null]) {
        const { rc } = round(metadata);
        gateOfferedName(rc, { decideToolCall }, call('read_url'));
        assert.strictEqual(gateOfferedName(rc, { decideToolCall }, call('outlook_compose')).refusal, null, JSON.stringify(metadata && Object.keys(metadata)));
    }
});
