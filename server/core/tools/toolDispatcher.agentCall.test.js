/**
 * toolDispatcher × agent_call automations: reachable ONLY through a bound agent.
 *
 * The dispatcher is the one door every surface reaches an automation tool
 * through, and the name gate in front of it (toolPolicy enforceNames) is OFF for
 * an agent nobody curated, so the dispatcher itself must refuse what is not
 * bound. This test is BEHAVIOURAL: it calls the real dispatcher with real
 * contexts and looks at what ran.
 *
 * Proven:
 *   - an agent the automation is bound to starts it, as the automation's owner
 *     (the asker is only recorded), from a chat context and from an AI step's
 *     `callerAgentId`;
 *   - an UNCURATED agent that is not bound cannot, even naming the tool exactly;
 *   - direct chat, Cowork, voice and /mcp reach the dispatcher with no agent and
 *     start nothing;
 *   - the agent's own curation holds at the door too: a bound automation its owner
 *     switched off does not run from voice or the non-streaming chat (which send
 *     whatever name the model emits), and one on 'ask' runs only when the
 *     streaming tool round vouches for its confirm layer;
 *   - the binding removed between the offer and the call is refused at the door.
 *
 * Plain-script style with an explicit exit, like the dispatcher tests beside it:
 * requiring the dispatcher pulls modules that keep the loop alive.
 *
 * Run: cd server && node core/tools/toolDispatcher.agentCall.test.js
 */

const assert = require('node:assert/strict');

const automation = {
    id: 'auto-1', userId: 'owner', isActive: true, title: 'Send invoice',
    definition: { trigger: { kind: 'agent_call', toolName: 'send_invoice' } },
};
const bindings = [['auto-1', 'agt-bound'], ['auto-1', 'agt-off'], ['auto-1', 'agt-ask']];
const runs = [];

// The dispatcher reaches these through the live exports objects at call time,
// so replacing a function on the real module is enough: no module-system tricks.
const automationStore = require('../../stores/automationStore');
automationStore.getAutomation = async (id) => (id === automation.id ? { ...automation } : null);
automationStore.listAutomationsBoundToAgent = async (agentId) => (bindings.some(([, g]) => g === agentId) ? [{ ...automation }] : []);
automationStore.hasAgentBinding = async (a, g) => bindings.some(([x, y]) => x === a && y === g);
automationStore.getCallableStepsForUser = async () => [];
require('../automationRunner').executeAutomation = async (a, opts) => {
    runs.push({ automationId: a.id, opts });
    return { lastOutput: { sent: true } };
};
// The owner may use the agent (their own, published): the binding module's own
// tests cover that rule, this one only needs it to hold.
const agentConfigs = {
    'agt-off': { tools: { automations: {} } },
    'agt-ask': { tools: { automations: { 'auto-1': { confirm: 'ask' } } } },
};
require('../../stores/agentStore').getForRuntime = async (id) => ({
    id, owner_id: 'owner', is_published: 1, published_version: 1, config: agentConfigs[id] || {},
});
require('../../stores/userStore').getUser = async (id) => ({ id, organizationId: 'org1', groups: [] });

const { executeTool } = require('./toolDispatcher');

(async () => {
    // ── a bound agent, from a chat turn: runs as the owner, records the asker ──
    runs.length = 0;
    let out = await executeTool('send_invoice', { n: 1 }, {
        userId: 'colleague', askerUserId: 'colleague', agentId: 'agt-bound', conversationId: 'conv-1',
    });
    assert.deepEqual(out, { sent: true });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].automationId, 'auto-1');
    assert.equal(runs[0].opts.startedByUserId, 'colleague', 'the asker is recorded, not the run user');
    assert.equal(runs[0].opts.callerAgentId, 'agt-bound');
    assert.equal(runs[0].opts.callerConversationId, 'conv-1');

    // ── a bound agent, from an AI step (the caller key, not agentId) ──
    runs.length = 0;
    out = await executeTool('send_invoice', {}, { userId: 'owner', callerAgentId: 'agt-bound', runScope: { runId: 'r1', rootRunId: 'r1' } });
    assert.deepEqual(out, { sent: true });
    assert.equal(runs[0].opts.callerAgentId, 'agt-bound');

    // ── an uncurated agent that is not bound: nothing runs, whatever the model typed ──
    runs.length = 0;
    out = await executeTool('send_invoice', {}, { userId: 'owner', agentId: 'agt-unbound', conversationId: 'c' });
    assert.equal(runs.length, 0, 'an unbound agent must not start the automation');
    assert.notDeepEqual(out, { sent: true });

    // ── no agent at all: direct chat, Cowork, voice, /mcp ──
    for (const ctx of [{ userId: 'owner' }, { userId: 'owner', conversationId: 'c' }, { userId: 'owner', session: { user: { id: 'owner' } } }]) {
        out = await executeTool('send_invoice', {}, ctx);
        assert.equal(runs.length, 0, 'no agent, no access');
    }

    // ── bound, but the agent's owner switched every automation off ──
    runs.length = 0;
    out = await executeTool('send_invoice', {}, { userId: 'colleague', askerUserId: 'colleague', agentId: 'agt-off', conversationId: 'c' });
    assert.equal(runs.length, 0, 'a bound but ungranted automation must not run from a surface without a whitelist');
    assert.equal(out.code, 'agent_not_allowed');

    // ── bound and granted on "ask": only the streaming round (confirm layer) may run it ──
    out = await executeTool('send_invoice', {}, { userId: 'colleague', askerUserId: 'colleague', agentId: 'agt-ask', conversationId: 'c' });
    assert.equal(runs.length, 0, 'voice / non-streaming chat have nobody to ask');
    assert.equal(out.code, 'confirmation_required');
    out = await executeTool('send_invoice', {}, { userId: 'colleague', askerUserId: 'colleague', agentId: 'agt-ask', conversationId: 'c', confirmLayer: true });
    assert.deepEqual(out, { sent: true });
    assert.equal(runs.length, 1);

    // ── the binding goes between the offer and the call ──
    runs.length = 0;
    bindings.length = 0;
    out = await executeTool('send_invoice', {}, { userId: 'owner', agentId: 'agt-bound', conversationId: 'c' });
    assert.equal(runs.length, 0, 'a removed binding stops the next call');

    console.log('toolDispatcher.agentCall: ok');
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
