// @typecheck strict
const test = require('node:test');
const assert = require('node:assert/strict');
const { converse } = require('./coworkConversation');

test('questions use the selected steps of the current owned plan and the owner’s model tier', async () => {
    const item = { id: 'c', userId: 'owner', modelTier: 'deep', title: 'Digest' };
    const pick = { message: 'Where does this go?', scope: { stepIds: ['send', 'sum'], fingerprint: 'f' }, view: 'overview', history: [] };
    const steps = [{ id: 'read' }, { id: 'sum' }, { id: 'send' }];
    const deps = {
        planStateOf: async () => /** @type {any} */ ({ draft: { fingerprint: 'f', view: { steps }, recipients: { send: 'owner' } } }),
        latestRun: async () => ({ status: 'failed', error: 'Mailbox unavailable' }),
        output: async () => undefined,
        user: async () => ({ organizationId: 'org' }),
        /** @param {Parameters<typeof import('../core/cowork/coworkCompose').coworkTextTurn>[0]} turn */
        coworkTextTurn: async turn => {
            assert.equal(turn.tier, 'deep');
            assert.deepEqual([turn.userOrgId, turn.userId], ['org', 'owner']);
            const facts = JSON.parse(turn.messages[1].content);
            assert.deepEqual(facts.state.latestRun, { status: 'failed', error: 'Mailbox unavailable' });
            assert.equal(facts.message, pick.message);
            assert.deepEqual(facts.state.steps, steps.slice(1));
            return JSON.stringify({ action: 'answer', answer: 'Only to you.' });
        },
    };
    assert.deepEqual(await converse(item, pick, deps), { action: 'answer', answer: 'Only to you.', instruction: '' });
    for (const bad of [{ fingerprint: 'old' }, { stepIds: ['unknown'] }]) {
        await assert.rejects(converse(item, { ...pick, scope: { ...pick.scope, ...bad } }, deps), { code: 'cowork_steps_changed' });
    }
});
