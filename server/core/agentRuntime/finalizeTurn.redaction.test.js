// @typecheck
/**
 * The redacted form of this turn's user message lands in the same write as
 * the turn: the stored row never holds the unredacted text, not even between
 * two writes (finalizeStreamTurn and the guardrail hard block).
 *
 * Run: cd server && node --test core/agentRuntime/finalizeTurn.redaction.test.js
 */

'use strict';

require('../../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
const test = require('node:test');
const assert = require('node:assert');
const { finalizeStreamTurn, turnRedactedContent } = require('./finalizeTurn');
const { respondGuardrailHardBlock } = require('./guardrailHardBlock');

/** Records a snapshot of the user row at every persist. */
function recorder(userSave) {
    /** @type {Array<{ content: unknown, isRedacted: unknown }>} */
    const writes = [];
    return { writes, persistDurable: async () => { writes.push({ content: userSave.content, isRedacted: userSave.isRedacted }); } };
}

function turn(over = {}) {
    return {
        fullResponse: 'Hello', useNativeAdapter: true, onEvent: () => {}, messageMetadata: {},
        _emailDrafts: [], _calendarDrafts: [], _linkedInDrafts: [], _mapEmbeds: [], _audioFiles: [],
        _toolHistory: [], _kbSources: [], _thinkingParts: [], _thinking: '',
        conversation: { id: 'c1' }, durableMessages: [], messages: [],
        memoryPolicy: { read: true, write: false, reason: 'off' }, isEphemeral: false, agent: { id: 'a1', organization_id: 'org1', config: {} }, agentId: 'a1', userId: 'u1',
        guardrailViolation: null, userAuth: {}, extractMemoriesEnabled: false, validProjectId: null,
        modelToUse: 'm', toolCalls: [],
        ...over,
    };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a redacted turn is stored redacted in its one write', async () => {
    const userSave = { role: 'user', content: 'call Jan 0612345678' };
    const { writes, persistDurable } = recorder(userSave);
    const result = await finalizeStreamTurn(turn({
        userSave, persistDurable, userMessage: 'call Jan 0612345678', processedUserMessage: 'call [PERSON_1] [PHONE_1]',
    }));
    await tick();
    assert.deepStrictEqual(writes, [{ content: 'call [PERSON_1] [PHONE_1]', isRedacted: true }]);
    assert.strictEqual(result.userMessageRedacted, true);
});

test('an unredacted turn is stored as typed', async () => {
    const userSave = { role: 'user', content: 'hi' };
    const { writes, persistDurable } = recorder(userSave);
    await finalizeStreamTurn(turn({ userSave, persistDurable, userMessage: 'hi', processedUserMessage: 'hi' }));
    await tick();
    assert.deepStrictEqual(writes, [{ content: 'hi', isRedacted: undefined }]);
});

test('turnRedactedContent: redact mode keeps the tokenised text, delete mode replaces it', () => {
    assert.strictEqual(turnRedactedContent({ processedUserMessage: 'a [X]', userMessage: 'a b' }), 'a [X]');
    assert.strictEqual(turnRedactedContent({ guardrailViolation: 'v', processedUserMessage: 'a', userMessage: 'a' }), '[Message removed - policy violation]');
    assert.strictEqual(turnRedactedContent({ processedUserMessage: 'a', userMessage: 'a' }), null);
});

test('the guardrail hard block stores the removed message in the same write as its reply', async () => {
    const userSave = { role: 'user', content: 'forbidden text' };
    const { writes, persistDurable } = recorder(userSave);
    await respondGuardrailHardBlock({
        moderationViolation: null, guardrailViolation: 'policy', onEvent: () => {}, messageMetadata: {},
        durableMessages: [userSave], userSave, persistDurable, isEphemeral: false, conversation: /** @type {any} */ ({ id: 'c1' }),
        processedUserMessage: 'forbidden text', userMessage: 'forbidden text', modelToUse: 'm',
    });
    await tick();
    assert.deepStrictEqual(writes, [{ content: '[Message removed - policy violation]', isRedacted: true }]);
});
