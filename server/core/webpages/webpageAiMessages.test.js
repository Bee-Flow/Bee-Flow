/**
 * BFSF-354 — the webpage AI bridges ground their answer on the page's
 * knowledge bases by injecting passages into the system prompt, without a
 * tool call. The same passages fetched through page_knowledge_search are
 * stripped against the Privacy Shield's "own server" list; these were not.
 * The bridge acts as the page's author, so it is the author's shield.
 *
 * Retrieval and the shield are stubbed through testUtils/stubRequire; the real
 * gate runs with its detector injected. Test data is synthetic.
 *
 * Run: cd server && node --test core/webpages/webpageAiMessages.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { SYNTH_EMAIL, OWN_SERVER_EMAIL, injectEmailDetector } = require('../../testUtils/toolPiiGateHarness');

const fx = { shield: null, shieldCalls: [], contextPrompt: '' };

const restore = installResolveStub({
    './webpageKnowledgeSearch': { searchWebpageKB: async () => ({ contextPrompt: fx.contextPrompt }) },
    '../privacy/orgShield': {
        resolveShieldFor: async (who) => { fx.shieldCalls.push(who); return fx.shield; },
    },
});
test.after(() => restore());

injectEmailDetector(require('../privacy/toolPiiGate'));

const { buildAiMessages } = require('./webpageAiMessages');

const CTX = {
    webpage: { name: 'Support page', knowledgeBaseIds: ['kb1'] },
    authorUserId: 'author-1',
    authorOrgId: 'org-1',
    bridgeGrants: { ai: { groundOnPage: true, publicGroundOnPage: true } },
};

test.beforeEach(() => {
    fx.shield = null;
    fx.shieldCalls = [];
    fx.contextPrompt = `### Source 1: Contacts\nwrite to ${SYNTH_EMAIL}`;
});

test('grounding passages lose what the author\'s own-server list blocks', async () => {
    fx.shield = OWN_SERVER_EMAIL;
    const messages = await buildAiMessages(CTX, { prompt: 'who do I write to?' });
    assert.ok(!messages[0].content.includes(SYNTH_EMAIL), 'the blocked value reached the prompt');
    assert.ok(messages[0].content.includes('write to [blocked:email]'));
    assert.deepStrictEqual(fx.shieldCalls, [{ orgId: 'org-1', userId: 'author-1' }], 'the author\'s shield');
});

test('the anonymous public bridge gets the same treatment', async () => {
    fx.shield = OWN_SERVER_EMAIL;
    const messages = await buildAiMessages(CTX, { prompt: 'who do I write to?' }, { groundGrantKey: 'publicGroundOnPage' });
    assert.ok(!messages[0].content.includes(SYNTH_EMAIL));
});

test('no shield, or no own-server list: the passages are untouched', async () => {
    for (const shield of [null, { enabled: true, toolPiiPolicy: { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } } }]) {
        fx.shield = shield;
        const messages = await buildAiMessages(CTX, { prompt: 'who do I write to?' });
        assert.ok(messages[0].content.includes(`write to ${SYNTH_EMAIL}`));
    }
});
