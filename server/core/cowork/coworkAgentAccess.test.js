const { test } = require('node:test');
const assert = require('node:assert');
const { canRunCoworkAgent } = require('./coworkAgentAccess.mts');

// The chat rule is handed in: what it answers is auth/agentAccess's own tests.
function rule(answer) {
    const asked = [];
    return {
        asked,
        async canChatAgent(agent, userId, req) { asked.push({ agent: agent.id, userId, sessionUser: req.session.user.id }); return answer; },
    };
}

test('the owner may always run their own agent, without asking the chat rule', async () => {
    const r = rule(false);
    assert.strictEqual(await canRunCoworkAgent({ id: 'a1', owner_id: 'u1', is_published: false }, 'u1', r), true);
    assert.deepStrictEqual(r.asked, []);
});

test('an agent shared with the person (the chat audience) may be run by them', async () => {
    const r = rule(true);
    assert.strictEqual(await canRunCoworkAgent({ id: 'a1', owner_id: 'owner', is_published: true }, 'u2', r), true);
    assert.deepStrictEqual(r.asked, [{ agent: 'a1', userId: 'u2', sessionUser: 'u2' }]);
});

test('someone outside the chat audience is refused', async () => {
    assert.strictEqual(await canRunCoworkAgent({ id: 'a1', owner_id: 'owner', is_published: true }, 'u2', rule(false)), false);
});

test('a failing lookup refuses rather than grants', async () => {
    const broken = { async canChatAgent() { throw new Error('db down'); } };
    assert.strictEqual(await canRunCoworkAgent({ id: 'a1', owner_id: 'owner' }, 'u2', broken), false);
});

test('no agent or no user is refused', async () => {
    assert.strictEqual(await canRunCoworkAgent(null, 'u1', rule(true)), false);
    assert.strictEqual(await canRunCoworkAgent({ id: 'a1', owner_id: '' }, '', rule(true)), false);
});
