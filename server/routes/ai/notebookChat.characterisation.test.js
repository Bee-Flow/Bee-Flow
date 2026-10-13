/**
 * The golden behaviour of a notebook chat turn, pinned before the route was
 * split into context / input gates / tool loop / finalize modules behind
 * `routes/ai/notebookChat.js`.
 *
 * A real server with the router mounted, every collaborator stubbed through
 * notebookChat.testkit.js. What is pinned per scenario: every SSE event in
 * order (name and payload), every request the model received (messages and
 * options), and every store / feed call the turn made. A pure move must leave
 * all of it as is. Timestamps and the clock lines in the system prompt are
 * normalised; nothing else is.
 *
 * Golden: notebookChat.characterisation.golden.json. Regenerate only for a
 * deliberate behaviour change: UPDATE_GOLDEN=1 node --test <this file>.
 *
 * Run: cd server && node --test routes/ai/notebookChat.characterisation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { makeSwaps } = require('../../testUtils/swaps');
const { SIGNED_IN, serveRouter, postJson } = require('../../testUtils/toolPiiGateHarness');
const { notebookChatStubs } = require('./notebookChat.testkit');

const GOLDEN_PATH = path.join(__dirname, 'notebookChat.characterisation.golden.json');

// ── The recorder ─────────────────────────────────────────────────────
const fx = {
    shield: null, tokenMap: {}, rounds: [], trace: [], calls: [],
    notebook: null, sources: [], validate: null, ledger: null, appendError: null, regexHits: [],
};

const replaceAll = (text, map) => Object.entries(map || {}).reduce((s, [tok, real]) => s.split(tok).join(real), String(text));
const piiDetectionStub = {
    restoreTokens: replaceAll,
    restoreTokensInRichText: replaceAll,
    windowCountFor: () => 1,
    validateInputForPii: async (...args) => (fx.validate ? fx.validate(...args) : null),
};
const dlpRunnerStub = {
    getConversationTokenMap: () => fx.tokenMap,
    getConversationTokenMapAsync: async () => fx.tokenMap,
    mergeTokenMap: (id, map) => { fx.trace.push(['dlp.mergeTokenMap', id, map]); Object.assign(fx.tokenMap, map); },
};
const rec = (name, ret) => async (...args) => { fx.trace.push([name, ...args]); return typeof ret === 'function' ? ret(...args) : ret; };

const provider = {
    getAdapter: () => ({
        supportsVision: () => false,
        stream: async (key, apiUrl, modelId, messages, opts, cb) => {
            const round = fx.rounds.shift();
            fx.calls.push({
                key, apiUrl, modelId,
                messages: JSON.parse(JSON.stringify(messages)),
                opts: {
                    ...opts,
                    signal: opts.signal ? 'AbortSignal' : opts.signal,
                    tools: Array.isArray(opts.tools) ? opts.tools.map(t => t.function?.name) : opts.tools,
                },
            });
            if (!round) return;
            if (round.throw) throw new Error(round.throw);
            if (round.mint) Object.assign(fx.tokenMap, round.mint);
            for (const [type2, data] of round.events) cb(type2, data);
        },
    }),
};

const restore = installResolveStub(notebookChatStubs(fx, {
    '../../core/providers': provider,
    '../../stores/configStore': {
        getConfig: async (key) => (key === 'agent_search_url' ? 'http://search.invalid' : null),
        getSecret: async () => null, setConfig: async () => true, getAllConfig: async () => ({}),
    },
    '../../stores/knowledgeBases': { getKB: async () => null },
    '../../stores/notebookStore': {
        getNotebook: async () => fx.notebook,
        getSources: async () => fx.sources,
        touchActivity: rec('store.touchActivity', undefined),
        countSources: rec('store.countSources', 1),
        addSource: rec('store.addSource', (a) => ({ id: 'src-new', ...a })),
        updateNotebookCas: rec('store.updateNotebookCas', () => ({ ok: true, version: 8 })),
        recordVersion: rec('store.recordVersion', () => ({ id: 'ver-1', deduped: false })),
    },
    '../../stores/notebookConversationStore': {
        appendMessages: async (id, userId, key, turn) => {
            fx.trace.push(['conv.appendMessages', id, userId, key, turn.map(m => ({ ...m, createdAt: 'T' }))]);
            if (fx.appendError) throw fx.appendError;
        },
    },
    '../../core/kb/notebookKnowledgeSearch': {
        searchNotebookKB: rec('kb.search', () => ({
            chunks: [{ chunk_id: 'c1', content: 'alpha passage' }],
            citations: [{ title: 'Notes.pdf', content: 'alpha passage', score: 0.9, sourceId: 's1' }],
            contextPrompt: '### Source 1: Notes.pdf\nalpha passage',
        })),
        executeNotebookKBSearchTool: rec('kb.tool', () => ({ query: 'q', resultCount: 1, results: [{ chunk_id: 'c7', content: 'gamma' }] })),
    },
    '../../integrations/agentSearchEgress': { runAgentSearchWithEgress: rec('web.search', { results: ['web hit'] }) },
    '../../core/dlp/dlpRunner': dlpRunnerStub,
    './dlpRunner': dlpRunnerStub,
    '../../core/privacy/piiDetection': piiDetectionStub,
    '../privacy/piiDetection': piiDetectionStub,
    '../../core/privacy/guardrails': {
        checkRegexPatterns: (text) => (fx.regexHits.length && /secret/.test(text) ? fx.regexHits : []),
    },
    '../../core/dlp/composeScan': {
        composeScan: async ({ units }) => {
            fx.trace.push(['dlp.composeScan', units[0]]);
            return fx.ledger ? fx.ledger(units) : { units, stats: { segments: 0 } };
        },
    },
    '../../core/dlp/attachmentScanner': {
        scanAttachmentText: async ({ text, filename }) => { fx.trace.push(['dlp.attachmentScan', filename]); return { action: 'pass', text }; },
    },
    '../../agents/notebooks/sourceIngestion': {
        ingestTextSource: rec('ingest.text', undefined), MAX_SOURCE_TEXT_CHARS: 100000, MAX_SOURCES_PER_NOTEBOOK: 50,
    },
}));

const route = require('./notebookChat');
const { swap, restore: unswap } = makeSwaps();
swap(route.seams, 'collab', () => null);
swap(route.seams, 'feed', () => ({
    sourcesAdded: rec('feed.sourcesAdded', undefined),
    contentChanged: rec('feed.contentChanged', undefined),
}));
test.after(unswap);

const baseUrl = serveRouter(test, route, { prefix: '/ai', session: { ...SIGNED_IN, encryptionKey: 'dek' }, restore });

function parseSse(body) {
    const events = [];
    for (const block of body.split('\n\n')) {
        const ev = /^event: (.*)$/m.exec(block);
        const data = /^data: (.*)$/m.exec(block);
        if (!ev) continue;
        let payload = data ? data[1] : null;
        try { payload = JSON.parse(payload); } catch (_) { /* keep text */ }
        if (payload && typeof payload === 'object' && 'durationMs' in payload) payload.durationMs = 'ms';
        if (payload && typeof payload === 'object' && typeof payload.timestamp === 'number') payload.timestamp = 'T';
        events.push([ev[1], payload]);
    }
    return events;
}

const normPrompt = (s) => (typeof s === 'string'
    ? s.replace(/Today is [^.]+\./, 'Today is <DATE>.').replace(/\nNow: [^\n]*/, '\nNow: <NOW>')
    : s);

async function runScenario(s) {
    Object.assign(fx, {
        shield: null, tokenMap: {}, trace: [], calls: [], validate: null, ledger: null, appendError: null, regexHits: [],
        notebook: { id: 'nb-1', userId: 'u1', name: 'Matter', description: 'A matter', instructions: 'Be brief', role: 'owner', knowledgeBaseIds: [], documentMd: 'stale md', version: 7, projectId: 'p1' },
        sources: [{ id: 's1', name: 'Notes.pdf', type: 'pdf', status: 'ready', wordCount: 1200 }, { id: 's2', name: 'Draft', type: 'text', status: 'processing' }],
    }, s.setup || {});
    if (s.notebook) Object.assign(fx.notebook, s.notebook);
    fx.rounds = (s.rounds || []).slice();
    const res = await postJson(`${baseUrl()}/chat/notebook/stream`, s.body);
    for (const c of fx.calls) {
        for (const m of c.messages) if (m.role === 'system') m.content = normPrompt(m.content);
    }
    return {
        status: res.status,
        events: parseSse(res.body),
        body: res.status === 200 ? null : res.body,
        calls: fx.calls,
        trace: fx.trace,
    };
}

const LONG = 'x'.repeat(50000);
const SCENARIOS = {
    'editor turn: kb, history trim, selection, attachment, tool round, persist': {
        notebook: { knowledgeBaseIds: ['kb1'] },
        body: {
            message: 'Rewrite this please', notebookId: 'nb-1', modelTier: 'fast', timezone: 'Europe/Amsterdam',
            documentContent: '<p>Hello world</p>', docVersion: 7,
            history: [
                { role: 'user', content: LONG }, { role: 'assistant', content: 'old answer' },
                { role: 'system', content: 'ignored' }, { role: 'user', content: '   ' },
                { role: 'user', content: 'recent question' }, { role: 'assistant', content: 'recent answer' },
            ],
            notebookSelection: { text: 'Hello world', action: 'rewrite' },
            attachments: [{ name: 'notes.txt', type: 'text/plain', content: `data:text/plain;base64,${Buffer.from('attached body').toString('base64')}` }],
        },
        rounds: [
            { events: [
                ['thinking_start', {}], ['thinking', { text: 'plan' }], ['thinking_stop', {}],
                ['text', { text: 'Working on it. ' }],
                ['tool_use', { id: 'call_a', name: 'notebook_doc_read', input: {} }],
                ['tool_use', { id: 'call_b', name: 'notebook_doc_replace', input: { find_text: 'Hello world', replace_text: 'Hi world' } }],
                ['tool_use', { id: 'call_c', name: 'notebook_add_source', input: { name: 'Found', content: 'web text', metadata: { url: 'https://x.invalid' } } }],
                ['tool_use', { id: 'call_d', name: 'notebook_kb_search', input: { query: 'beta' } }],
                ['tool_use', { id: 'call_e', name: 'agent_search', input: { query: 'law' } }],
                ['tool_use', { id: 'call_f', name: 'mystery_tool', input: { a: 1 } }],
            ] },
            { events: [['tool_use', { id: 'call_g', name: 'notebook_doc_read', input: {} }]] },
            { events: [['text', { text: 'Done, I rewrote it.' }]] },
        ],
    },
    'viewer turn with the shield on: PII tokens, refused write, output redaction, privacy panel': {
        setup: {
            shield: { enabled: true, showRawPayload: true, privacyAction: 'redact', rulesWithNames: [{ name: 'Secret', pattern: 'secret' }], scope: { agentOutput: true }, action: 'redact' },
            regexHits: [{ ruleName: 'Secret' }],
            validate: async () => ({
                tokenizedText: 'Ask [person_1] about it',
                tokenMap: { '[person_1]': 'Jan' },
                entities: [{ label: 'Person', category: 'PERSON' }],
            }),
        },
        notebook: { role: 'viewer' },
        body: { message: 'Ask Jan about it', notebookId: 'nb-1', documentContent: '<p>Doc of Jan</p>' },
        rounds: [
            { events: [
                ['text', { text: 'Writing for [person_1]. ' }],
                ['tool_use', { id: 'call_v', name: 'notebook_doc_write', input: { content: '# For [person_1]' } }],
                ['tool_use', { id: 'call_w', name: 'notebook_add_source', input: { content: 'x' } }],
            ] },
            { events: [['text', { text: 'I cannot change it; the secret stays with [person_1].' }]] },
        ],
    },
    'stream error, empty answer fallback, history locked': {
        setup: { appendError: Object.assign(new Error('locked'), { code: 'HISTORY_LOCKED' }) },
        notebook: { documentMd: '' },
        body: { message: 'hello', notebookId: 'nb-1', reasoningEffort: 'none' },
        rounds: [{ throw: 'provider down' }],
    },
    'the document scan blocks: the turn ends before any model call': {
        setup: {
            shield: { enabled: true },
            ledger: () => ({ blocked: true, units: [], stats: { segments: 1, hits: 1, fresh: 1 } }),
        },
        body: { message: 'hello', notebookId: 'nb-1', documentContent: '<p>Secret doc</p>' },
        rounds: [],
    },
    'the document is tokenised; a token minted after the write is restored at the end': {
        setup: {
            shield: { enabled: true },
            tokenMap: { '[email-1]': 'a@b.invalid' },
            ledger: (units) => ({ units: [units[0].replace('a@b.invalid', '[email-1]')], tokenMap: { '[email-1]': 'a@b.invalid' }, count: 1, mentions: 1, stats: { segments: 1, hits: 1, fresh: 1 } }),
        },
        body: { message: 'tidy the doc', notebookId: 'nb-1', documentContent: '<p>Mail a@b.invalid</p>' },
        rounds: [
            { events: [['tool_use', { id: 'call_t', name: 'notebook_doc_write', input: { content: 'Mail [email-1] and [person-9] today' } }]] },
            { mint: { '[person-9]': 'Piet' }, events: [['text', { text: 'Wrote to [email-1].' }]] },
        ],
    },
    'missing fields are refused before anything runs': {
        body: { message: '', notebookId: 'nb-1' },
        rounds: [],
    },
};

const results = {};
for (const [name, s] of Object.entries(SCENARIOS)) {
    test(name, async () => {
        results[name] = await runScenario(s);
    });
}

test('the turns match the golden record', () => {
    const actual = JSON.parse(JSON.stringify(results));
    if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(GOLDEN_PATH)) {
        fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 1)}\n`);
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    for (const name of Object.keys(SCENARIOS)) {
        assert.deepStrictEqual(actual[name], golden[name], name);
    }
});
