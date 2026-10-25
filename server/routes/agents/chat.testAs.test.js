'use strict';

/**
 * "Test als · groep X" on the agent chat stream.
 *
 * The Testen tab previews an agent by talking to it, so the simulation has to
 * exist on the ordinary chat door as well as on the test-set runner. That door
 * is the one with the sharp edges, and this file pins the three of them:
 *
 *   • IT IS AN EDITOR'S TOOL. Simulating only ever removes knowledge, so a
 *     chatter could not gain anything by asking — but the answer to "may I
 *     preview this agent as somebody else" is `canModifyAgent`, and a check
 *     that could not RUN is not a yes.
 *   • IT REFUSES, IT NEVER DEGRADES. A group that cannot be resolved comes
 *     back as a 400/503 before the stream opens. The alternative — run the
 *     turn as the person actually typing and let the client keep its label —
 *     is a transcript that says a group saw something it did not.
 *   • IT IS EPHEMERAL. A narrowed answer written into the agent's real history
 *     would later read as what the agent said to this person, and would count
 *     as a conversation in the usage tab.
 *
 * `core/agentRuntime/testAs` is the real module; only the two reads it makes
 * are replaced.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/chat.testAs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installChatKit } = require('./chat.testkit');

const fx = {
    userId: 'me',
    agent: null,
    canModify: true,
    modifyThrows: false,
    groups: {},
    ownGroups: [],
    groupThrows: false,
    metadata: [],
    conversationReads: 0,
};

const { dispatch } = installChatKit(fx, { prefix: 'agent-chat-testas', terminalErrors: true });

test.beforeEach(() => {
    Object.assign(fx, {
        userId: 'me',
        agent: { id: 'a1', owner_id: 'me', organization_id: 'org1', is_published: true, shared_groups: [] },
        canModify: true, modifyThrows: false,
        groups: { sales: { id: 'sales', name: 'Sales', organizationId: 'org1' } },
        ownGroups: [], groupThrows: false,
        metadata: [], conversationReads: 0,
    });
});

test('an editor naming a group gets a simulated, ephemeral turn', async () => {
    await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(fx.metadata.length, 1);
    assert.deepStrictEqual(fx.metadata[0].testAs, { groupId: 'sales', groupName: 'Sales', orgId: 'org1' });
    assert.strictEqual(fx.metadata[0].ephemeral, true, 'a narrowed answer is not the agent\'s history');
    assert.strictEqual(fx.conversationReads, 0, 'nothing may be persisted for a preview');
});

test('an ordinary turn is untouched', async () => {
    await dispatch({ message: 'hi' });
    assert.strictEqual(fx.metadata[0].testAs, null);
    assert.strictEqual(fx.metadata[0].ephemeral, undefined);
    assert.strictEqual(fx.conversationReads, 1, 'a real chat still persists');
});

test('someone who may chat but not edit cannot preview as a group', async () => {
    fx.canModify = false;
    const res = await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'test_as_not_allowed');
    assert.deepStrictEqual(fx.metadata, [], 'the turn must not run');
});

test('an edit check that could not run is not permission to simulate', async () => {
    fx.modifyThrows = true;
    const res = await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'test_as_check_failed');
    assert.deepStrictEqual(fx.metadata, []);
});

test('a group that cannot be resolved refuses instead of running as the editor', async () => {
    const unknown = await dispatch({ message: 'hi', asGroup: 'marketing' });
    assert.strictEqual(unknown.statusCode, 400);
    assert.strictEqual(unknown.body.code, 'test_as_group_not_found');
    assert.deepStrictEqual(fx.metadata, []);

    fx.groupThrows = true;
    const down = await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(down.statusCode, 503);
    assert.strictEqual(down.body.code, 'test_as_group_unreadable');
    assert.deepStrictEqual(fx.metadata, []);
});

test('an embed visitor with no session cannot simulate anybody', async () => {
    // A visitor without an account reaches the turn at all only on an agent
    // with Web embed on (chat.embed.test.js); past that door the edit check
    // answers no, and no is where this stops.
    fx.userId = null;
    fx.agent = { ...fx.agent, embed_enabled: true };
    fx.canModify = false;
    const res = await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.metadata, []);
});

test('a group from another organisation is not previewable', async () => {
    fx.groups = { hr: { id: 'hr', name: 'HR', organizationId: 'org2' } };
    const res = await dispatch({ message: 'hi', asGroup: 'hr' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'test_as_group_not_found');
});
