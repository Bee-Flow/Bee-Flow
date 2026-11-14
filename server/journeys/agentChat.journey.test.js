'use strict';

/**
 * Journey: an agent is built, a colleague chats with it, the turn is stored and billed.
 *
 * The installation has one model provider (an OpenAI provider whose adapter is
 * the world's scripted stub, journeyWorld.testkit.js stubModel). The
 * organisation admin creates an agent on the stub model and publishes it to the
 * organisation; a colleague chats one turn over the real SSE stream (the real
 * agent turn: model resolution, the provider call, the conversation store); the
 * answer streams back, the conversation is stored with both messages, the
 * owner's usage tab and the organisation's usage summary count the call with
 * the price the price list gives for those tokens; a member of another
 * organisation can neither chat with the agent nor read the conversation.
 *
 * Run: cd server && npm run test:journeys
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld, STUB_MODEL, PRICES } = require('./journeyWorld.testkit');

const PW = 'Cobalt-meadow-8830!';
const QUESTION = 'When does the warehouse open?';

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;

before(async () => {
    world = await openWorld({ mounts: ['auth', 'agents', 'usage'] });
    await world.configureModelProvider();
    await world.seedOrg({ id: 'org-chat-a', name: 'Chat org A' });
    await world.seedOrg({ id: 'org-chat-b', name: 'Chat org B' });
    await world.seedUser({ id: 'chat-admin', password: PW, organizationId: 'org-chat-a', orgRole: 'org_admin' });
    await world.seedUser({ id: 'chat-colleague', password: PW, organizationId: 'org-chat-a', orgRole: 'member' });
    await world.seedUser({ id: 'chat-outsider', password: PW, organizationId: 'org-chat-b', orgRole: 'org_admin' });
}, { timeout: 120_000 });

after(() => world?.close());

test('create an agent → publish → a colleague chats a turn → stored, counted and priced; another organisation is refused', { timeout: 90_000 }, async () => {
    const admin = await world.login('chat-admin', PW);
    const colleague = await world.login('chat-colleague', PW);
    const outsider = await world.login('chat-outsider', PW);

    const created = await admin.call('POST', '/agents', {
        body: { name: 'Warehouse helper', description: 'Answers questions about the warehouse', systemPrompt: 'You help with the warehouse.', model: STUB_MODEL, organizationId: 'org-chat-a' },
    });
    assert.equal(created.status, 200, created.text);
    const agentId = created.body.id;

    const published = await admin.call('PATCH', `/agents/${agentId}/publish`, { body: { isPublished: true } });
    assert.equal(published.status, 200, published.text);

    const turn = await colleague.stream(`/agents/${agentId}/chat/stream`, { message: QUESTION });
    assert.equal(turn.status, 200, turn.text.slice(0, 600));
    const errors = turn.events.filter((e) => e.event === 'error');
    assert.deepEqual(errors, [], 'the turn streams without an error');
    const content = turn.events.filter((e) => e.event === 'content').map((e) => e.data.text).join('');
    assert.equal(content, `Stub answer to: ${QUESTION}`);
    const done = turn.events.find((e) => e.event === 'done');
    assert.ok(done?.data?.conversationId, `done names the stored conversation: ${turn.text.slice(-400)}`);
    const conversationId = done.data.conversationId;

    const streamed = world.model.calls.filter((c) => c.method === 'stream');
    assert.equal(streamed.length, 1, 'one model call for one turn');
    assert.equal(streamed[0].model, STUB_MODEL);

    const stored = await colleague.call('GET', `/agents/${agentId}/conversations/${conversationId}`);
    assert.equal(stored.status, 200, stored.text);
    const messages = (stored.body.messages || stored.body.conversation?.messages || []).map((/** @type {{ role: string, content: unknown }} */ m) => [m.role, m.content]);
    assert.deepEqual(messages.slice(-2), [['user', QUESTION], ['assistant', `Stub answer to: ${QUESTION}`]]);

    // The price the price list gives for the stub's tokens (USD per 1M).
    const { prompt_tokens: pin, completion_tokens: pout } = world.model.usage;
    const expected = (pin * PRICES[STUB_MODEL].input + pout * PRICES[STUB_MODEL].output) / 1e6;

    const agentUsage = await admin.call('GET', `/agents/${agentId}/usage`);
    assert.equal(agentUsage.status, 200, agentUsage.text);
    assert.equal(agentUsage.body.chat.conversationCount, 1, `the owner's usage tab counts the colleague's conversation: ${agentUsage.text}`);

    // The organisation's view of the summary is the customer allow-list
    // (routes/usage.js maybeRedact): who used it and what it cost.
    const summary = await admin.call('GET', '/api/usage/summary');
    assert.equal(summary.status, 200, summary.text);
    assert.equal(summary.body.scope.organizationId, 'org-chat-a', summary.text);
    assert.equal(Number(summary.body.unique_users), 1, `the colleague is counted: ${summary.text}`);
    assert.ok(Math.abs(Number(summary.body.billed_cost) - expected) < 1e-9, `the turn is billed at the price list's rate (${expected}): ${summary.text}`);

    const foreignChat = await outsider.stream(`/agents/${agentId}/chat/stream`, { message: 'Let me in' });
    assert.ok(foreignChat.status === 403 || foreignChat.status === 404, `another organisation chats: ${foreignChat.status} ${foreignChat.text.slice(0, 200)}`);
    const foreignRead = await outsider.call('GET', `/agents/${agentId}/conversations/${conversationId}`);
    assert.ok(foreignRead.status === 403 || foreignRead.status === 404, `another organisation reads the conversation: ${foreignRead.status}`);
    assert.equal(world.model.calls.filter((c) => c.method === 'stream').length, 1, 'a refused chat never reaches the model');
});
