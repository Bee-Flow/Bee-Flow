/**
 * The golden behaviour of a webpage builder chat turn, pinned before the route
 * was split into prompt / input / tool / loop / finalize modules behind
 * `routes/ai/webpageChat.js`.
 *
 * A real server with the router mounted, every collaborator with a side
 * effect stubbed (the pure ones, such as the doc tools, the framework prompt,
 * the validator and the DLP stream helpers, run for real). What is pinned per
 * scenario: every SSE event in order (name and payload), every request the
 * model received (messages and options), and every store / tool / log call the
 * turn made. A pure move must leave all of it as is. Timestamps, durations and
 * the clock lines in the system prompt are normalised; nothing else is.
 *
 * Golden: webpageChat.characterisation.golden.json. Regenerate only for a
 * deliberate behaviour change: UPDATE_GOLDEN=1 node --test <this file>.
 *
 * Run: cd server && node --test routes/ai/webpageChat.characterisation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { quietSse } = require('../../testUtils/quietSse');
const { SIGNED_IN, serveRouter, postJson, injectEmailDetector, SYNTH_EMAIL } = require('../../testUtils/toolPiiGateHarness');
const { withStepAliases, toolDef, pass } = require('./notebookChat.testkit');

const GOLDEN_PATH = path.join(__dirname, 'webpageChat.characterisation.golden.json');

// ── The recorder ─────────────────────────────────────────────────────
const fx = {};
function resetFx(over = {}) {
    for (const k of Object.keys(fx)) delete fx[k];
    Object.assign(fx, {
        shield: null, tokenMap: {}, rounds: [], trace: [], calls: [], vision: false,
        config: { agent_search_url: 'http://search.invalid' }, secretThrows: false,
        webpage: {
            id: 'wp-1', name: 'Landing', title: 'Landing', description: 'A landing page', instructions: 'Keep it calm',
            knowledgeBaseIds: [], htmlSize: 10, cssSize: 5, jsSize: 0, htmlSha: 'h0', cssSha: 'c0', jsSha: null,
        },
        sources: [{ id: 's1', name: 'Brief', type: 'text', status: 'ready', wordCount: 1200 }, { id: 's2', name: 'Draft', type: 'url', status: 'processing' }],
        extras: [], limitError: null, providerThrows: false, attachmentAction: null,
    }, over);
}
resetFx();

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const rec = (name, ret) => async (...args) => { fx.trace.push([name, ...clone(args)]); return typeof ret === 'function' ? ret(...args) : ret; };

const provider = {
    getAdapter: (type, url) => ({
        supportsVision: () => fx.vision,
        stream: async (key, apiUrl, modelId, messages, opts, cb) => {
            const round = fx.rounds.shift();
            fx.calls.push({
                type, url, key, apiUrl, modelId,
                messages: clone(messages),
                opts: {
                    ...opts,
                    signal: opts.signal ? 'AbortSignal' : opts.signal,
                    tools: Array.isArray(opts.tools) ? opts.tools.map(t => t.function?.name || t.name) : opts.tools,
                },
            });
            if (!round) return;
            if (round.throw) throw new Error(round.throw);
            if (round.mint) Object.assign(fx.tokenMap, round.mint);
            for (const [type2, data] of round.events) cb(type2, data);
        },
    }),
};

const webpageStoreStub = {
    getWebpage: rec('store.getWebpage', () => fx.webpage),
    getSources: rec('store.getSources', () => fx.sources),
    addSource: rec('store.addSource', (a) => ({ id: 'src-new', ...a })),
    listExtraFiles: rec('store.listExtraFiles', () => fx.extras),
    readExtraFile: rec('store.readExtraFile', ({ path: p }) => ({ text: `// ${p}` })),
    createVersion: rec('store.createVersion', { id: 'ver-1' }),
    writeSlot: rec('store.writeSlot', (u, w, slot, content) => ({ sha: `sha-${slot}`, size: String(content).length })),
    updateWebpageMetadata: rec('store.updateWebpageMetadata', undefined),
};
const dlpRunnerStub = {
    getConversationTokenMap: () => fx.tokenMap,
    getConversationTokenMapAsync: async () => fx.tokenMap,
    mergeTokenMap: (id, map) => { fx.trace.push(['dlp.mergeTokenMap', id, map]); Object.assign(fx.tokenMap, map); },
};

const restore = installResolveStub(withStepAliases({
    '../../core/aiAgent': {
        getAIConfig: async () => ({ model: 'model-default' }),
        getProviderForModel: async (modelId) => {
            if (fx.providerThrows) throw new Error(`no provider for ${modelId}`);
            return { providerType: 'test', url: 'http://model.invalid//', apiKey: 'k' };
        },
    },
    '../../stores/configStore': {
        getConfig: async (key) => fx.config[key] ?? null,
        getSecret: async (key) => { if (fx.secretThrows) throw new Error(`secret store down (${key})`); return null; },
        setConfig: async () => true, getAllConfig: async () => ({}),
    },
    '../../core/providers': provider,
    '../../stores/webpageStore': webpageStoreStub,
    '../stores/webpageStore': webpageStoreStub,
    '../../core/http/sseHelpers': quietSse(),
    '../../core/webpages/webpageUsageSync': { reconcileWebpageUsageDetached: (id) => { fx.trace.push(['usage.reconcile', id]); } },
    '../../integrations/webpagePlanTool': {
        PROPOSE_WEBPAGE_PLAN_TOOL: toolDef('propose_webpage_plan'),
        executeProposeWebpagePlan: (args) => { fx.trace.push(['plan.propose', clone(args)]); return { _action: 'webpage_plan_proposed', planId: 'plan-1', plan: args, message: 'Plan proposed.' }; },
    },
    '../../integrations/webpageMultiFileTools': {
        WEBPAGE_MULTI_FILE_TOOLS: [toolDef('webpage_create_file'), toolDef('webpage_delete_file')],
        isMultiFileTool: (n) => n === 'webpage_create_file' || n === 'webpage_delete_file',
        executeMultiFileTool: rec('multi.exec', (name, args) => (name === 'webpage_create_file'
            ? { _action: 'webpage_extra_update', path: args.path, meta: { size: 3 }, content: 'big content' }
            : { _action: 'webpage_extra_deleted', path: args.path })),
    },
    '../../integrations/webpageDbTools': {
        WEBPAGE_DB_TOOLS: [toolDef('webpage_db_exec'), toolDef('webpage_db_query')],
        isDbTool: (n) => n === 'webpage_db_exec' || n === 'webpage_db_query',
        executeDbTool: rec('db.exec', (name) => (name === 'webpage_db_exec'
            ? { _action: 'webpage_db_update', changes: 1, lastInsertRowid: 4, multi: false, message: 'ok', extra: 'dropped' }
            : { rows: Array.from({ length: 52 }, (_, i) => ({ i })), columns: ['i'] })),
    },
    '../../integrations/webpageBridgeTools': {
        WEBPAGE_BRIDGE_TOOLS: [toolDef('webpage_grant_ai')],
        isBridgeTool: (n) => n === 'webpage_grant_ai',
        executeBridgeTool: async (name, args, ctx) => { fx.trace.push(['bridge.exec', name, args, { ...ctx, session: !!ctx.session }]); return { success: true }; },
    },
    '../../integrations/agentSearchTools': { AGENT_SEARCH_TOOLS: [toolDef('agent_search'), toolDef('read_url')], isAgentSearchTool: (n) => n === 'agent_search' },
    '../../integrations/agentSearchEgress': { runAgentSearchWithEgress: rec('web.search', { results: ['web hit'] }) },
    '../../integrations/webpageScreenshotTools': {
        WEBPAGE_SCREENSHOT_TOOL: toolDef('webpage_screenshot'),
        isScreenshotTool: (n) => n === 'webpage_screenshot',
        executeScreenshotTool: rec('screenshot.exec', () => ({ content: 'No console errors.', _screenshotDataUrl: 'data:image/png;base64,QUJD', _screenshotViewport: 'desktop' })),
    },
    '../../core/webpages/webpageKnowledgeSearch': {
        searchWebpageKB: rec('kb.search', () => ({
            chunks: [{ content: 'alpha passage' }],
            citations: [{ title: 'Brief.pdf', content: 'alpha passage', score: 0.9 }],
            contextPrompt: '\n### Source 1: Brief.pdf\nalpha passage',
        })),
        executeWebpageKBSearchTool: rec('kb.tool', { results: [{ content: 'gamma' }] }),
        WEBPAGE_KB_SEARCH_TOOL: toolDef('webpage_kb_search'),
    },
    '../../agents/webpages/sourceIngestion': { ingestTextSource: rec('ingest.text', undefined) },
    '../../stores/terminationStore': {
        logTermination: async (row) => { fx.trace.push(['termination', { ...row, duration_ms: row.duration_ms === undefined ? undefined : 'ms' }]); },
    },
    '../../auth/permissions': { requireAuth: pass },
    '../../core/entitlements/limits': { checkSubscriptionLimits: rec('limits.check', () => fx.limitError) },
    '../../auth': { resolveUserOrgIds: async () => new Set(['org-1']) },
    '../../core/llm/modelResolver': {
        getEUAwareTiers: async () => ({ fast: { modelId: 'model-1' }, thinking: { modelId: 'model-2', maxTokens: 4000, temperature: 0 } }),
        resolveEffectiveOrgId: async () => 'org-1',
        TIER_DEFAULTS: { fast: { maxTokens: 1024, temperature: 0.2 }, thinking: { maxTokens: 2048, temperature: 0.5 } },
    },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield },
    '../../core/dlp/attachmentScanner': {
        scanAttachmentText: async ({ text, filename, conversationId }) => {
            fx.trace.push(['dlp.attachmentScan', filename, conversationId]);
            if (fx.attachmentAction === 'block') return { action: 'block', summary: { byCategory: { Email: 1 } } };
            if (fx.attachmentAction === 'tokenise') {
                Object.assign(fx.tokenMap, { '[email_1]': SYNTH_EMAIL });
                return { action: 'tokenise', text: text.split(SYNTH_EMAIL).join('[email_1]') };
            }
            return { action: 'pass', text };
        },
    },
    '../../core/documents/attachmentExtractor': {
        extractAttachment: rec('extract', () => ({ kind: 'text', text: 'pdf body text', source: 'pdf-parse' })),
        formatTextHeader: (att) => `[Document: ${att.name}]`,
        formatImagesHeader: (att) => `[Images: ${att.name}]`,
        formatFailureNote: (att) => `[Failed: ${att.name}]`,
    },
    '../../core/documents/nativePdf': {
        nativePdfPart: (o) => { fx.trace.push(['nativePdf', { ...o, adapter: !!o.adapter }]); return null; },
        isShieldActive: (s) => !!s?.enabled,
    },
    '../../core/dlp/dlpRunner': dlpRunnerStub,
    './dlpRunner': dlpRunnerStub,
    '../../stores/guardrailEventStore': { logGuardrailEvent: rec('guardrail.log', undefined) },
}));

injectEmailDetector(require('../../core/privacy/toolPiiGate'));

const baseUrl = serveRouter(test, require('./webpageChat'), { prefix: '/ai', session: SIGNED_IN, restore });

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
    resetFx(s.setup || {});
    if (s.webpage) Object.assign(fx.webpage, s.webpage);
    fx.rounds = (s.rounds || []).slice();
    const res = await postJson(`${baseUrl()}/chat/webpage/stream`, s.body);
    // The system prompt is long and the same in every round of a turn: kept in
    // full in the first call, a later identical copy is pinned by reference.
    let firstPrompt = null;
    for (const [i, c] of fx.calls.entries()) {
        for (const m of c.messages) {
            if (m.role !== 'system') continue;
            m.content = normPrompt(m.content);
            if (i === 0 && firstPrompt === null) firstPrompt = m.content;
            else if (i > 0 && m.content === firstPrompt) m.content = '<the system prompt of calls[0]>';
        }
    }
    return {
        status: res.status,
        events: res.status === 200 ? parseSse(res.body) : null,
        body: res.status === 200 ? null : res.body,
        calls: fx.calls,
        trace: fx.trace,
    };
}

const textAtt = (name, text) => ({ name, type: 'text/plain', content: `data:text/plain;base64,${Buffer.from(text).toString('base64')}` });
const call = (id, name, input) => ['tool_use', { id, name, input }];

const SCENARIOS = {
    'auto turn: kb, selection, history, attachments, every tool family, validation repair, persist': {
        setup: { vision: true, extras: [{ path: 'logo.svg', isText: true }, { path: 'app.js', isText: true }] },
        webpage: { knowledgeBaseIds: ['kb1'] },
        body: {
            message: 'Add a hero', webpageId: 'wp-1', modelTier: 'fast', timezone: 'Europe/Amsterdam', chatMode: 'auto',
            htmlContent: '<main>Hello</main>', cssContent: 'main { color: red; }', jsContent: '',
            webpageSelection: { text: 'Hello', file: 'html', action: 'rewrite' },
            history: [
                { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'earlier answer' },
                { role: 'system', content: 'ignored' }, { role: 'user', content: '   ' },
            ],
            attachments: [
                textAtt('notes.txt', 'attached body'),
                { name: 'pic.png', type: 'image/png', content: 'data:image/png;base64,QUJD' },
                { name: 'brief.pdf', type: 'application/pdf', content: 'data:application/pdf;base64,JVBERg==' },
            ],
        },
        rounds: [
            { events: [
                ['thinking_start', { partId: 'p1' }], ['thinking', { text: 'plan', partId: 'p1' }], ['thinking_stop', { partId: 'p1' }],
                ['text', { text: 'Working on it. ' }],
                call('c1', 'webpage_file_read', { file: 'html' }),
                call('c2', 'webpage_file_replace', { file: 'html', find_text: 'Hello', replace_text: 'Hi <a href="#nowhere">there</a>' }),
                call('c3', 'webpage_create_file', { path: 'app.js', content: 'x' }),
                call('c4', 'webpage_delete_file', { path: 'old.css' }),
                call('c5', 'webpage_db_exec', { sql: 'CREATE TABLE t (a)' }),
                call('c6', 'webpage_db_query', { sql: 'SELECT * FROM t' }),
                call('c7', 'webpage_grant_ai', { enabled: true }),
                call('c8', 'webpage_set_framework', { framework: 'vanilla' }),
                call('c9', 'webpage_add_source', { name: 'Found', content: 'some web text here', metadata: { url: 'https://x.invalid' } }),
                call('c10', 'webpage_add_source', { content: '  ' }),
                call('c11', 'webpage_kb_search', { query: 'beta' }),
                call('c12', 'agent_search', { query: 'hero patterns' }),
                call('c13', 'read_url', { url: 'https://x.invalid' }),
                call('c14', 'webpage_screenshot', { viewport: 'desktop' }),
                call('c15', 'propose_webpage_plan', { summary: 'nope' }),
                call('c16', 'mystery_tool', { a: 1 }),
                ['done', { prompt_tokens: 100, completion_tokens: 20, stop_reason: 'tool_use' }],
            ] },
            { events: [['text', { text: 'Done, the hero is in.' }], ['done', { prompt_tokens: 50, completion_tokens: 5, stop_reason: 'end_turn' }]] },
            { events: [['text', { text: 'Fixed the anchor.' }], ['done', { prompt_tokens: 60, completion_tokens: 6, stop_reason: 'end_turn' }]] },
        ],
    },
    'plan mode: the plan is proposed, one wrap-up round without tools, nothing persisted': {
        body: { message: 'Redesign the page', webpageId: 'wp-1', chatMode: 'plan', htmlContent: '<p>x</p>' },
        rounds: [
            { events: [['text', { text: 'Let me plan. ' }], call('p1', 'propose_webpage_plan', { summary: 'New layout', steps: ['a', 'b'] })] },
            { events: [['text', { text: 'Here is the plan.' }]] },
        ],
    },
    'ask mode, approved plan executes: no plan tool, authorisation injected, max_tokens logged': {
        body: {
            message: 'go', webpageId: 'wp-1', chatMode: 'ask', modelTier: 'thinking',
            planExecution: { planId: 'plan-9', action: 'execute' }, cssContent: 'a{}',
        },
        rounds: [
            { events: [call('w1', 'webpage_file_write', { file: 'css', content: 'body { margin: 0; }', title: 'Reset' })] },
            { events: [['text', { text: 'Cut off' }], ['done', { prompt_tokens: 1, completion_tokens: 2, finish_reason: 'length' }]] },
        ],
    },
    'the tool round cap: one round, then a summary without tools and a max_iterations log': {
        setup: { config: { agent_search_url: null, max_tool_rounds_chat: '1', search_provider: 'disabled' } },
        body: { message: 'loop', webpageId: 'wp-1' },
        rounds: [
            { events: [call('r1', 'webpage_file_read', { file: 'js' })] },
            { events: [['text', { text: 'Summary.' }]] },
        ],
    },
    'stream error: termination logged, error event, turn still done': {
        body: { message: 'hello', webpageId: 'wp-1', modelTier: 'auto' },
        rounds: [{ throw: 'provider down' }],
    },
    'shield on: tokenised attachment, args restored except search, reply untokenised': {
        setup: { shield: { enabled: true }, attachmentAction: 'tokenise' },
        body: { message: 'use the contact', webpageId: 'wp-1', attachments: [textAtt('contact.txt', `mail ${SYNTH_EMAIL}`)] },
        rounds: [
            { events: [
                call('t1', 'webpage_file_write', { file: 'html', content: '<p>[email_1]</p>' }),
                call('t2', 'agent_search', { query: 'who is [email_1]' }),
            ] },
            { events: [['text', { text: 'Wrote [email' }], ['text', { text: '_1] into the page.' }]] },
        ],
    },
    'shield on: a blocked attachment ends the turn before any model call': {
        setup: { shield: { enabled: true }, attachmentAction: 'block' },
        body: { message: 'read this', webpageId: 'wp-1', attachments: [textAtt('secret.txt', 'x')] },
        rounds: [],
    },
    'an error outside the loop: termination row and error event': {
        setup: { secretThrows: true },
        body: { message: 'hello', webpageId: 'wp-1' },
        rounds: [],
    },
    'refusals before the stream opens': {
        body: { message: '', webpageId: 'wp-1' },
        rounds: [],
    },
    'unknown webpage': {
        setup: { webpage: null },
        body: { message: 'hi', webpageId: 'wp-x' },
        rounds: [],
    },
    'subscription limit': {
        setup: { limitError: 'Monthly chat limit reached' },
        body: { message: 'hi', webpageId: 'wp-1' },
        rounds: [],
    },
    'provider resolution fails': {
        setup: { providerThrows: true },
        body: { message: 'hi', webpageId: 'wp-1' },
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
