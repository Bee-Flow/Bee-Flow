/**
 * Notebook chat, knowledge-base tool loop:
 *
 *   - WP2: the same read-only call twice in one answer runs once; the second
 *     gets a short "already retrieved" message, and passages already shown
 *     (injected up front or returned by an earlier search) are not repeated.
 *   - WP3: the org setting `privacy_scan_knowledge_bases` also governs
 *     query-time tokenising of knowledge-base content. Off: the injected
 *     passages and notebook_kb_search results are not scanned; web search
 *     results still are. Default (true / absent): scanned as before.
 *
 * Scaffolding: notebookChat.testkit.js (shared with notebookChat.toolPiiGate.test.js). Synthetic data.
 *
 * Run: cd server && node --test routes/ai/notebookChat.kbScanning.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const {
    SIGNED_IN, gateFixture, resetFixture, serveRouter, postJson,
} = require('../../testUtils/toolPiiGateHarness');
const { notebookChatStubs } = require('./notebookChat.testkit');

const fx = gateFixture({ tokenMap: {}, kbSearches: [], scans: [], ledgerScans: [], systemPrompts: [], calls: [], kbResults: [] });

// A model that makes `fx.calls` in round 1 and ends the turn in round 2.
const provider = {
    getAdapter: () => ({
        stream: async (_k, _u, _m, messages, _o, cb) => {
            const answers = messages.filter(m => m.role === 'tool');
            if (answers.length > 0) { fx.toolMessages.push(...answers); cb('text', { text: 'Done.' }); return; }
            fx.systemPrompts.push(messages[0].content);
            fx.calls.forEach((c, i) => cb('tool_use', { id: `call_${i}`, name: c.name, input: c.args }));
        },
    }),
};

const restore = installResolveStub(notebookChatStubs(fx, {
    '../../core/providers': provider,
    '../../core/kb/notebookKnowledgeSearch': {
        searchNotebookKB: async () => ({
            chunks: [{ chunk_id: 'c1', content: 'meeting notes alpha' }],
            citations: [{ title: 'Notes', content: 'meeting notes alpha', score: 0.9 }],
            contextPrompt: '### Source 1: Notes\nmeeting notes alpha',
        }),
        executeNotebookKBSearchTool: async (args) => {
            fx.kbSearches.push(args);
            return { query: args.query, resultCount: fx.kbResults.length, results: fx.kbResults, instruction: 'x' };
        },
    },
    '../../integrations/agentSearchEgress': { runAgentSearchWithEgress: async () => ({ results: ['web hit'] }) },
    '../../core/dlp/attachmentScanner': { scanAttachmentText: async ({ text, filename }) => { fx.scans.push(filename); return { action: 'pass', text }; } },
    '../../core/dlp/composeScan': { composeScan: async ({ units }) => { fx.ledgerScans.push(units[0]); return { units, stats: { segments: 0 } }; } },
}));

const baseUrl = serveRouter(test, require('./notebookChat'), { prefix: '/ai', session: SIGNED_IN, restore });

const shieldWith = (extra = {}) => ({
    enabled: true, privacyAction: 'redact', rulesWithNames: [], scope: {},
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
    ...extra,
});

async function turn({ shield, calls, kbResults = [] }) {
    resetFixture(fx, { shield, calls, kbResults });
    const res = await postJson(`${baseUrl()}/chat/notebook/stream`, { message: 'summarise the meeting', notebookId: 'nb-1' });
    assert.strictEqual(res.status, 200, res.body);
    return res.body;
}

const kbCall = (query) => ({ name: 'notebook_kb_search', args: { query } });

test('two identical notebook_kb_search calls run once; the second gets the repeat message', async () => {
    const body = await turn({
        shield: null, calls: [kbCall('meeting'), kbCall('meeting')],
        kbResults: [{ result_number: 1, chunk_id: 'c9', title: 'Notes', content: 'beta' }],
    });
    assert.strictEqual(fx.kbSearches.length, 1);
    assert.strictEqual(fx.toolMessages.length, 2);
    assert.match(fx.toolMessages[0].content, /beta/);
    assert.match(fx.toolMessages[1].content, /Already retrieved earlier in this answer/);
    assert.strictEqual((body.match(/event: tool_end/g) || []).length, 2, 'the UI still sees both calls end');
});

test('a different query still runs', async () => {
    await turn({ shield: null, calls: [kbCall('meeting'), kbCall('budget')], kbResults: [{ chunk_id: 'c9', content: 'beta' }] });
    assert.strictEqual(fx.kbSearches.length, 2);
});

test('passages already injected up front are not returned again', async () => {
    await turn({
        shield: null, calls: [kbCall('meeting')],
        kbResults: [{ chunk_id: 'c1', title: 'Notes', content: 'meeting notes alpha' }],
    });
    assert.match(fx.toolMessages[0].content, /No new passages beyond those already retrieved/);
});

test('the prompt tells the model the passages are already retrieved', async () => {
    await turn({ shield: null, calls: [kbCall('meeting')] });
    assert.match(fx.systemPrompts[0], /\[KNOWLEDGE BASE\][\s\S]*never repeat a search/);
});

test('default: injected passages and a kb search result are scanned, web results too', async () => {
    await turn({
        shield: shieldWith(), calls: [kbCall('budget'), { name: 'agent_search', args: { query: 'x' } }],
        kbResults: [{ chunk_id: 'c9', content: 'beta' }],
    });
    assert.strictEqual(fx.ledgerScans.length, 1);
    assert.deepStrictEqual(fx.scans.sort(), ['agent_search-result', 'notebook_kb_search-result']);
});

test('privacy_scan_knowledge_bases=true behaves as the default', async () => {
    await turn({ shield: shieldWith({ privacy_scan_knowledge_bases: true }), calls: [kbCall('budget')], kbResults: [{ chunk_id: 'c9', content: 'beta' }] });
    assert.strictEqual(fx.ledgerScans.length, 1);
    assert.deepStrictEqual(fx.scans, ['notebook_kb_search-result']);
});

test('privacy_scan_knowledge_bases=false: KB content is not scanned, web search still is', async () => {
    await turn({
        shield: shieldWith({ privacy_scan_knowledge_bases: false }),
        calls: [kbCall('budget'), { name: 'agent_search', args: { query: 'x' } }],
        kbResults: [{ chunk_id: 'c9', content: 'beta' }],
    });
    assert.deepStrictEqual(fx.ledgerScans, [], 'injected passages must not be tokenised');
    assert.deepStrictEqual(fx.scans, ['agent_search-result']);
    assert.match(fx.toolMessages[0].content, /beta/);
});
