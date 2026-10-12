/**
 * read_url in the direct-chat tool stack: offered wherever agent_search is,
 * removed together with it when the user turned web search off or the
 * disableSearchOnUpload policy applies.
 */

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { READ_URL_TOOLS } = require('../../../integrations/readUrlTools');
const { AGENT_SEARCH_TOOLS } = require('../../../integrations/agentSearchTools');

const searchTools = () => AGENT_SEARCH_TOOLS.map(t => ({ ...t }));

const restore = installResolveStub({
    '../../../stores/agentStore': { getDirectConversation: async () => null, getDirectConversationMeta: async () => null },
    '../../../stores/configStore': { getConfig: async () => undefined },
    '../../../core/tools/directChatToolStack': {
        buildDirectChatToolStack: async () => ({ tools: searchTools(), n8nOrgId: null }),
    },
    '../../../auth/permissions': { hasPermission: async () => false },
    '../../../core/entitlements/entitlements': { hasCapability: async () => false },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => false },
});
const { assembleToolStack } = require('./toolStackAssembly');
test.after(() => restore());

async function names(over = {}) {
    const out = await assembleToolStack({
        req: { session: {} }, send: () => {}, userId: 'u1', conversationId: null, resolvedTier: 'fast',
        attachments: [], history: [], disabledMedia: null, webSearchEnabled: true, disableSearchOnUpload: false,
        message: 'hi', notebookspaceContent: undefined, activeSkillIds: [], userOrgForTiers: null,
        ...over,
    });
    return out.directChatTools.map(t => t.function.name);
}

test('the web-search app carries read_url', () => {
    assert.deepStrictEqual(READ_URL_TOOLS.map(t => t.function.name), ['read_url']);
    assert.ok(AGENT_SEARCH_TOOLS.some(t => t.function.name === 'read_url'));
    assert.ok(AGENT_SEARCH_TOOLS.some(t => t.function.name === 'agent_search'));
});

test('read_url is present by default', async () => {
    const n = await names();
    assert.ok(n.includes('agent_search'));
    assert.ok(n.includes('read_url'));
});

test('read_url is removed when the user turned web search off', async () => {
    const n = await names({ webSearchEnabled: false });
    assert.ok(!n.includes('agent_search'));
    assert.ok(!n.includes('read_url'));
});

test('read_url is removed by disableSearchOnUpload when files are attached', async () => {
    const n = await names({ disableSearchOnUpload: true, attachments: [{ name: 'a.pdf' }] });
    assert.ok(!n.includes('agent_search'));
    assert.ok(!n.includes('read_url'));
    const kept = await names({ disableSearchOnUpload: true });
    assert.ok(kept.includes('read_url'), 'policy only applies once a file is in the conversation');
});
