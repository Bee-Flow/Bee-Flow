/**
 * BFSF-354 — the notebook chat honours the Privacy Shield's tool block lists,
 * as direct chat and the agent loop do:
 *
 *   - a tool whose arguments carry a category on the "Outside tools" / "Own
 *     server" list is refused and never run. The check reads the values the
 *     call really carries: the notebook dispatches in token space and restores
 *     real values at its own write boundary (document edits, new sources), so
 *     those are checked on the real values; a web search keeps its tokens;
 *   - what the model reads of a tool result has those categories stripped;
 *   - the knowledge-base passages the turn injects without a tool call are
 *     stripped against the "Own server" list, as notebook_kb_search results are.
 *
 * It did none of it. A real server with the router mounted; dependencies are
 * stubbed through testUtils/stubRequire (notebookChat.testkit.js) and the real gate runs with its
 * detector injected (the real orgShield classifies the tools). Synthetic data.
 *
 * Run: cd server && node --test routes/ai/notebookChat.toolPiiGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, SIGNED_IN, REFUSED_FOR_EMAIL, gateFixture, resetFixture,
    injectEmailDetector, streamingToolCallProvider, serveRouter, postJson, kbChatGateTests,
} = require('../../testUtils/toolPiiGateHarness');
const { notebookChatStubs } = require('./notebookChat.testkit');

const fx = gateFixture({ tokenMap: {}, kbSearches: [], webSearches: [], systemPrompts: [] });

const restoreTokens = (text, map) => Object.entries(map || {}).reduce((s, [tok, real]) => s.split(tok).join(real), String(text));
const piiDetectionStub = { restoreTokens, restoreTokensInRichText: restoreTokens };

const restore = installResolveStub(notebookChatStubs(fx, {
    '../../core/providers': streamingToolCallProvider(fx),
    '../../core/kb/notebookKnowledgeSearch': {
        searchNotebookKB: async () => ({
            chunks: [{ content: `billing: ${SYNTH_EMAIL}` }],
            citations: [{ title: 'Contacts', content: `billing: ${SYNTH_EMAIL}`, score: 0.9 }],
            contextPrompt: `### Source 1: Contacts\nbilling: ${SYNTH_EMAIL}`,
        }),
        executeNotebookKBSearchTool: async (args) => { fx.kbSearches.push(args); return { chunks: [{ content: `write to ${SYNTH_EMAIL}` }] }; },
    },
    '../../integrations/agentSearchEgress': {
        runAgentSearchWithEgress: async (name, args) => { fx.webSearches.push(args); return { results: [`hit ${SYNTH_EMAIL}`] }; },
    },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    '../../core/privacy/piiDetection': piiDetectionStub,
    '../privacy/piiDetection': piiDetectionStub,
}));

injectEmailDetector(require('../../core/privacy/toolPiiGate'));

const baseUrl = serveRouter(test, require('./notebookChat'), { prefix: '/ai', session: SIGNED_IN, restore });

const NOTEBOOK_SHIELD = { ...OWN_SERVER_EMAIL, rulesWithNames: [], scope: {} };

async function turn({ shield = NOTEBOOK_SHIELD, toolCall, tokenMap = {} }) {
    resetFixture(fx, { shield, toolCall, tokenMap });
    const res = await postJson(`${baseUrl()}/chat/notebook/stream`, { message: 'who handles billing?', notebookId: 'nb-1' });
    assert.strictEqual(res.status, 200, res.body);
    return res.body;
}

// Refused and stripped as in the webpage builder's chat.
kbChatGateTests(test, { fx, turn, kbTool: 'notebook_kb_search', source: 'notebook' });

// The notebook restores real values at its own write boundary, so those are
// what the gate checks.
test('a document edit is checked on the real value its token stands for', async () => {
    await turn({
        toolCall: { name: 'notebook_doc_replace', args: { find_text: 'contact', replace_text: 'contact [email_1]' } },
        tokenMap: { '[email_1]': SYNTH_EMAIL },
    });
    assert.match(fx.toolMessages[0].content, REFUSED_FOR_EMAIL);
});
