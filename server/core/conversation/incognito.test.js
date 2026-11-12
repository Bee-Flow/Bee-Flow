// @typecheck
/**
 * The rules of an incognito chat (./incognito.mts): what is refused, what the
 * request is turned into, which tools are withheld and what `done` carries.
 *
 * Run: cd server && node --test core/conversation/incognito.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const {
    INCOGNITO_CODES, INCOGNITO_WITHHELD_TOOLS, isIncognito, incognitoRefusal, assertIncognitoRequest,
    applyIncognitoPolicy, isIncognitoWithheldTool, withholdIncognitoTools, incognitoDonePayload,
} = require('./incognito.mts');

/** @param {string} name */
const tool = (name) => ({ type: 'function', function: { name } });

test('only the boolean true is incognito', () => {
    assert.strictEqual(isIncognito({ incognito: true }), true);
    for (const v of [false, 'true', 1, null, undefined]) assert.strictEqual(isIncognito({ incognito: v }), false);
    assert.strictEqual(isIncognito(null), false);
    assert.strictEqual(isIncognito('incognito'), false);
});

test('a turn that is not incognito is never refused, whatever else it carries', () => {
    const body = { conversationId: 'c1', attachments: [{ name: 'a.pdf' }], modelTier: 'swarm', test: true };
    assert.strictEqual(incognitoRefusal(body, 'direct'), null);
    assert.strictEqual(incognitoRefusal(body, 'agent'), null);
    assert.doesNotThrow(() => assertIncognitoRequest(body, 'direct'));
});

test('a stored conversation id is refused on both surfaces', () => {
    for (const surface of /** @type {const} */ (['direct', 'agent'])) {
        assert.strictEqual(incognitoRefusal({ incognito: true, conversationId: 'c1' }, surface)?.code, 'incognito_conversation_id');
    }
    // An empty or absent id is no id.
    assert.strictEqual(incognitoRefusal({ incognito: true, conversationId: null }, 'direct'), null);
    assert.strictEqual(incognitoRefusal({ incognito: true, conversationId: '' }, 'direct'), null);
});

test('attachments are refused; an empty list is not an attachment', () => {
    assert.strictEqual(incognitoRefusal({ incognito: true, attachments: [{ name: 'a.pdf' }] }, 'direct')?.code, 'incognito_no_attachments');
    assert.strictEqual(incognitoRefusal({ incognito: true, attachments: [{ name: 'a.pdf' }] }, 'agent')?.code, 'incognito_no_attachments');
    assert.strictEqual(incognitoRefusal({ incognito: true, attachments: [] }, 'direct'), null);
});

test('Swarm (direct) and a test chat (agent) are unsupported modes, each on its own surface', () => {
    assert.strictEqual(incognitoRefusal({ incognito: true, modelTier: 'swarm' }, 'direct')?.code, 'incognito_unsupported_mode');
    assert.strictEqual(incognitoRefusal({ incognito: true, test: true }, 'agent')?.code, 'incognito_unsupported_mode');
    assert.strictEqual(incognitoRefusal({ incognito: true, modelTier: 'fast' }, 'direct'), null);
    assert.strictEqual(incognitoRefusal({ incognito: true, test: false }, 'agent'), null);
});

test('the refusal is an HttpError 400 with the code', () => {
    assert.throws(() => assertIncognitoRequest({ incognito: true, conversationId: 'c1' }, 'direct'), (/** @type {any} */ e) => {
        assert.strictEqual(e.name, 'HttpError');
        assert.strictEqual(e.status, 400);
        assert.strictEqual(e.code, INCOGNITO_CODES.conversationId);
        assert.strictEqual(e.expose, true);
        return true;
    });
});

test('the policy switches memory off whatever the client sent, and makes an agent turn ephemeral', () => {
    /** @type {Record<string, unknown>} */
    const direct = { incognito: true, memoryReadEnabled: true, memoryWriteEnabled: true };
    applyIncognitoPolicy(direct, 'direct');
    assert.deepStrictEqual(direct, { incognito: true, memoryReadEnabled: false, memoryWriteEnabled: false });

    /** @type {Record<string, unknown>} */
    const agent = { incognito: true, ephemeral: false };
    applyIncognitoPolicy(agent, 'agent');
    assert.deepStrictEqual(agent, { incognito: true, ephemeral: true, memoryReadEnabled: false, memoryWriteEnabled: false });

    /** @type {Record<string, unknown>} */
    const plain = { memoryReadEnabled: true, ephemeral: true };
    applyIncognitoPolicy(plain, 'agent');
    assert.deepStrictEqual(plain, { memoryReadEnabled: true, ephemeral: true }, 'a turn that is not incognito is left alone');
});

test('the withheld list is exactly the memory tools and the notebook tools', () => {
    const { MEMORY_TOOLS } = require('../../integrations/memoryTools');
    const { WORKSPACE_TOOLS } = require('../../integrations/workspaceTools');
    const real = [...MEMORY_TOOLS, ...WORKSPACE_TOOLS].map((t) => t.function.name).sort();
    assert.deepStrictEqual([...INCOGNITO_WITHHELD_TOOLS].sort(), real, 'a memory or notebook tool was added or renamed: keep the list in step');
});

test('withholding drops those tools only on an incognito turn, and keeps everything else in order', () => {
    const tools = [tool('agent_search'), tool('memory_search'), tool('notebook_write'), tool('set_reminder'), tool('memory_remember'), { name: 'notebook_read' }];
    assert.deepStrictEqual(withholdIncognitoTools(tools, true).map((t) => t.function?.name ?? t.name), ['agent_search', 'set_reminder']);
    assert.strictEqual(withholdIncognitoTools(tools, false), tools, 'not incognito: the same list');
    assert.strictEqual(withholdIncognitoTools(tools, undefined), tools);
    assert.strictEqual(isIncognitoWithheldTool('memory_remember'), true);
    assert.strictEqual(isIncognitoWithheldTool('kb_search'), false);
    assert.strictEqual(isIncognitoWithheldTool(undefined), false);
});

test('done carries everything but the conversation id', () => {
    assert.deepStrictEqual(incognitoDonePayload({ conversationId: 'ephemeral-1', message: 'hi', conversationLength: 2 }), { message: 'hi', conversationLength: 2 });
    assert.deepStrictEqual(incognitoDonePayload({ conversationId: null }), {});
});
