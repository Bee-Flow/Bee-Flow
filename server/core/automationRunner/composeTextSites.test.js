/**
 * Every executor that renders a compose-capable text field renders a compose
 * as readable text.
 *
 * The AI builder (M5) stores a text field whose placeholders all read plain
 * paths as a compose, and the editor will write one too. A compose renders
 * through the same interpolateTemplate call a `{{ }}` string does, so every
 * executor reads it without a change of its own — this file runs each one,
 * with a compose in each field sites.mjs lists as `compose: true`, and checks
 * the text it produced: the values in it, a list as "Stoel, Tafel", a table
 * as one "Stoel · 2" per row, and never JSON.
 *
 * Driven by the table, not by a list of its own: a text site added to
 * sites.mjs without a harness here fails the first test until one is added.
 *
 * REGRESSION (confirmed bug "Text mixed with a list or an object renders as
 * raw JSON"): the same text written as a template renders the list as JSON,
 * the compose does not.
 *
 * Run: cd server && node --test core/automationRunner/composeTextSites.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installResolveStub } = require('../../testUtils/stubRequire');

process.env.NODE_ENV = 'test';

// ── doubles: every outside world the executors below reach ─────────────────

const seen = {
    bell: [], fetch: [], chat: [], render: [], deck: [], fill: [], copies: [], ingest: [],
};
const reset = () => { for (const k of Object.keys(seen)) seen[k].length = 0; };

const automationStore = {
    async getAutomation() { return null; },
    async recordRunStep() {},
    async recordGeneratedFile(row) { return { id: 'file-1', ...row }; },
};
const storageStore = {
    isAvailable: () => true,
    buildAutomationFileKey: (userId, automationId, sha) => `auto/${automationId}/${sha}`,
    async uploadFile() {},
};
const FILL_DOC = { id: 'doc_1', userId: 'user-1', name: 'Factuur', docType: 'invoice', bodyHtml: '<p>{{naam}}</p>', css: '', settings: {} };

const restore = installResolveStub({
    '../../stores/automationStore': automationStore,
    '../../stores/storageStore': storageStore,
    '../../stores/configStore': {
        async getConfig(key) { return key === 'data_extraction_model' ? 'model-extract' : null; },
        async setConfig() {},
    },
    '../../stores/notificationStore': { async createNotification(n) { seen.bell.push(n); return { id: 'n1' }; } },
    '../../stores/userStore': { async getUser() { return { email: 'owner@example.com' }; } },
    '../../utils/emailService': { async getServiceEmailConfig() { return { configured: false }; }, async sendServiceEmail() {} },
    '../../stores/usageStore': { async logUsage() {} },
    '../../stores/terminationStore': { async logTermination() {} },
    '../../stores/documentStore': {
        async getDocumentVersion(id) { return id === FILL_DOC.id ? { ...FILL_DOC } : null; },
        async createDocument(doc) { seen.copies.push(doc); return { ...doc, id: 'doc_copy', versionId: 'v1' }; },
    },
    '../../utils/ssrfGuard': {
        async safeFetch(url, opts) {
            seen.fetch.push({ url, opts });
            return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        },
        isPrivateAddressError: () => false,
    },
    './httpAuth': {
        MASK_VALUES: Symbol.for('beeflow.automation.maskValues'),
        async resolveHttpAuthHeaders() { return { headers: {}, maskValues: [] }; },
        evictToken() {},
    },
    '../llm/modelResolver': { async getUserTierMap() { return { fast: { modelId: 'model-fast', maxTokens: 2048 } }; } },
    '../entitlements/userTiers': { async getPermittedTierKeys() { return null; } },
    '../llm/promptClassifier': { async classifyWithLLM() { return { tier: 'fast' }; } },
    '../aiAgent': {
        async getProviderForModel(modelId) { return { apiKey: 'k', url: 'u', providerType: 'test', modelId }; },
        async getAIConfig() { return { model: 'model-fast' }; },
    },
    '../providers': {
        getAdapter: () => ({
            async chat(_key, _url, _modelId, messages) {
                seen.chat.push(JSON.parse(JSON.stringify(messages)));
                return { content: '{"naam":"x"}', usage: {} };
            },
        }),
    },
    './safety': {
        async resolveAutomationPolicy() { return { action: 'off' }; },
        buildAuditBase() { return {}; },
        async guardAiInput() { return { blocked: false }; },
        async guardAiOutput(content) { return { content }; },
        async guardToolInput(value) { return { value }; },
        prepareForEgress: (v) => v,
        async logEgress() {},
        async guardToolOutput(result) { return { result }; },
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    '../../services/documentRenderer': {
        FORMATS: ['pdf', 'docx'],
        CONTENT_TYPES: { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        async renderDocument(opts) { seen.render.push(opts); return { buffer: Buffer.from('%PDF-1.7'), contentType: 'application/pdf', degraded: false, marking: null }; },
    },
    '../../services/presentationRenderer': {
        async renderPresentation(opts) {
            seen.deck.push(opts);
            return { buffer: Buffer.from('PK'), contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', format: 'pptx', extension: 'pptx', slideCount: 2, warnings: [], degraded: false, marking: null, houseStyle: true };
        },
        makeUserImageResolver: () => async () => null,
    },
    '../documents/renderFilledDocument': {
        async renderFilledDocument(args) {
            seen.fill.push(args);
            return { buffer: Buffer.from('%PDF-1.7'), contentType: 'application/pdf', extension: 'pdf', degraded: false, marking: null, fill: { bodyHtml: '', missing: [], sections: [], issues: [], notLists: [], truncated: [], tooDeep: [], errors: [] } };
        },
        documentFileName: (raw, fallback = 'document', ext = 'pdf') => `${String(raw || fallback).trim() || fallback}.${ext}`,
    },
    '../../integrations/kbIngestTools': {
        async executeKbIngestTool(tool, args) { seen.ingest.push(args); return { ok: true, documentId: 'kd1', chunks: 1 }; },
    },
});

const { STEP_SITES } = require('../../shared/mapping/index.mjs');
const { execAiStep } = require('./execAi');
const { execNotification, execHttpRequest } = require('./execOutbound');
const { execStopError } = require('./execControl');
const { renderApprovalPrompt } = require('./execApproval');
const { execDataExtraction } = require('./execDataExtraction');
const { execGenerateDocument } = require('./execDocument');
const { execFillDocument } = require('./execFillDocument');
const { execKnowledgeWrite } = require('./execKnowledgeWrite');
const { execSlide, execPresentation } = require('./execPresentation');
const port = require('./documentMarking');

after(() => { restore(); port.setMarkingResolver(null); });
beforeEach(reset);

// ── the run, the compose, the text it must become ──────────────────────────

const STATE = () => ({
    trigger: { output: {} },
    steps: {
        src: {
            status: 'success',
            output: { naam: 'Jan', orders: [{ product: 'Stoel', n: 2 }, { product: 'Tafel', n: 1 }] },
        },
    },
    vars: {}, secrets: {}, loop: {}, _templateWarnings: [],
});
const from = (...path) => ({ root: 'steps', id: 'src', path });

/** One line, so it also survives the fields that become a file name. */
const COMPOSE = {
    kind: 'compose', v: 1,
    parts: [
        'Beste ', { from: from('naam'), take: 'one', as: 'text', label: 'Naam' },
        ': ', { from: from('orders', 'product'), take: 'all', as: 'text', join: 'comma', label: 'Product' },
        ' / ', { from: from('orders'), take: 'one', as: 'text', join: 'comma', label: 'Orders' },
    ],
};
const EXPECTED = 'Beste Jan: Stoel, Tafel / Stoel · 2, Tafel · 1';
/** The same text as a template: the list and the table come out as JSON. */
const TEMPLATE = 'Beste {{steps.src.output.naam}}: {{steps.src.output.orders[*].product}} / {{steps.src.output.orders}}';

const CTX = { userId: 'user-1', orgId: 'org-1', automationId: 'auto-1', runId: 'run-1', automationTitle: 'Routine', session: {}, definition: { steps: [] } };

const textOf = (messages) => messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

/**
 * How each text site is rendered: run the executor with `value` in the field
 * and hand back the text it produced. Keyed `<step type>.<field>`.
 */
const HARNESS = {
    'ai_step.prompt': async (value) => {
        await execAiStep({ id: 'ai1', type: 'ai_step', prompt: value, inputs: {}, modelTier: 'fast' }, CTX, STATE(), 'live');
        return textOf(seen.chat.at(-1));
    },
    'approval.prompt': async (value) => renderApprovalPrompt({ id: 'ap1', type: 'approval', prompt: value }, STATE()),
    'notification.title': async (value) => (await execNotification({ id: 'n1', type: 'notification', title: value }, CTX, STATE(), 'dry_run')).output.wouldNotify.title,
    'notification.body': async (value) => (await execNotification({ id: 'n1', type: 'notification', title: 'T', body: value }, CTX, STATE(), 'dry_run')).output.wouldNotify.body,
    'http_request.url': async (value) => {
        // A url is a url: the readable text goes in a query value.
        await execHttpRequest({ id: 'h1', type: 'http_request', method: 'GET', url: { ...value, parts: ['https://example.org/?q=', ...value.parts] } }, CTX, STATE(), 'live');
        return decodeURIComponent(seen.fetch.at(-1).url.replace('https://example.org/?q=', ''));
    },
    'http_request.body': async (value) => {
        await execHttpRequest({ id: 'h1', type: 'http_request', method: 'POST', url: 'https://example.org/hook', body: value }, CTX, STATE(), 'live');
        return seen.fetch.at(-1).opts.body;
    },
    'stop_error.message': async (value) => {
        try { await execStopError({ id: 's1', type: 'stop_error', message: value }, CTX, STATE()); } catch (e) { return e.message; }
        return null;
    },
    'data_extraction.source': async (value) => {
        await execDataExtraction({ id: 'ex1', type: 'data_extraction', source: value, fields: [{ name: 'naam', type: 'string', description: 'Name' }] }, CTX, STATE(), 'live');
        return textOf(seen.chat.at(-1));
    },
    'generate_document.content': async (value) => {
        await execGenerateDocument({ id: 'd1', type: 'generate_document', content: value }, CTX, STATE(), 'live');
        return seen.render.at(-1).content;
    },
    'generate_document.title': async (value) => {
        await execGenerateDocument({ id: 'd1', type: 'generate_document', content: 'x', title: value }, CTX, STATE(), 'live');
        return seen.render.at(-1).title;
    },
    'generate_document.fileName': async (value) => (await execGenerateDocument({ id: 'd1', type: 'generate_document', content: 'x', fileName: value }, CTX, STATE(), 'live')).output.filename,
    'fill_document.fileName': async (value) => (await execFillDocument({ id: 'f1', type: 'fill_document', documentId: 'doc_1', values: {}, fileName: value }, CTX, STATE(), 'live')).output.filename,
    'fill_document.copyName': async (value) => {
        await execFillDocument({ id: 'f1', type: 'fill_document', documentId: 'doc_1', values: {}, saveCopy: true, copyName: value }, CTX, STATE(), 'live');
        return seen.copies.at(-1).name;
    },
    'fill_document.values': async (value) => {
        await execFillDocument({ id: 'f1', type: 'fill_document', documentId: 'doc_1', values: { naam: value } }, CTX, STATE(), 'live');
        return seen.fill.at(-1).values.naam;
    },
    'knowledge_write.content': async (value) => {
        await execKnowledgeWrite({ id: 'k1', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: value }, CTX, STATE(), 'live');
        return seen.ingest.at(-1).content;
    },
    'knowledge_write.title': async (value) => {
        await execKnowledgeWrite({ id: 'k1', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: 'x', title: value }, CTX, STATE(), 'live');
        return seen.ingest.at(-1).title;
    },
    'knowledge_write.sourceUri': async (value) => {
        await execKnowledgeWrite({ id: 'k1', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: 'x', sourceUri: value }, CTX, STATE(), 'live');
        return seen.ingest.at(-1).sourceUri;
    },
    'slide.title': async (value) => (await execSlide({ id: 'sl1', type: 'slide', title: value }, CTX, STATE())).output.slide.title,
    'slide.content': async (value) => JSON.stringify((await execSlide({ id: 'sl1', type: 'slide', title: 'T', content: value }, CTX, STATE())).output.slide),
    'slide.notes': async (value) => (await execSlide({ id: 'sl1', type: 'slide', title: 'T', notes: value }, CTX, STATE())).output.slide.notes,
    // A slide's picture is a storage key: the readable text is its last part.
    'slide.image': async (value) => (await execSlide({ id: 'sl1', type: 'slide', title: 'T', image: { ...value, parts: ['users/user-1/img/', ...value.parts] } }, CTX, STATE())).output.slide.image.storageKey,
    'presentation.title': async (value) => {
        await execPresentation({ id: 'p1', type: 'presentation', title: value, slides: '# Deck\n\n## Een\n- punt' }, CTX, STATE(), 'live');
        return seen.deck.at(-1).title;
    },
    'presentation.subtitle': async (value) => {
        await execPresentation({ id: 'p1', type: 'presentation', title: 'Deck', subtitle: value, slides: '## Een\n- punt' }, CTX, STATE(), 'live');
        return JSON.stringify(seen.deck.at(-1).deck);
    },
    'presentation.fileName': async (value) => (await execPresentation({ id: 'p1', type: 'presentation', title: 'Deck', fileName: value, slides: '## Een\n- punt' }, CTX, STATE(), 'live')).output.filename,
    'presentation.copyName': async (value) => {
        await execPresentation({ id: 'p1', type: 'presentation', title: 'Deck', saveCopy: true, copyName: value, slides: '## Een\n- punt' }, CTX, STATE(), 'live');
        return seen.copies.at(-1).name;
    },
};

/** Every `<type>.<field>` sites.mjs lists as a compose-capable text. */
function composeSites() {
    const out = [];
    for (const [type, entry] of Object.entries(STEP_SITES)) {
        for (const site of entry.text || []) if (site.compose) out.push(`${type}.${site.field}`);
    }
    return out;
}

test('every compose-capable text site has a harness here, and no harness names a site that is not one', () => {
    const sites = composeSites();
    assert.ok(sites.length >= 25, `sanity: the table lists the text sites (${sites.length})`);
    assert.deepEqual(sites.filter(s => !HARNESS[s]), [], 'a text site without a harness');
    assert.deepEqual(Object.keys(HARNESS).filter(s => !sites.includes(s)), [], 'a harness for a site the table does not list');
});

for (const site of composeSites()) {
    test(`${site}: a compose renders as readable text`, async () => {
        const run = HARNESS[site];
        assert.ok(run, `no harness for ${site}`);
        const text = await run(COMPOSE);
        assert.equal(typeof text, 'string', `${site} produced no text`);
        // The JSON a template would give for the list or the table, nowhere.
        assert.ok(!text.includes('["Stoel"') && !text.includes('{"product"') && !text.includes('{\\"product'), `${site} rendered JSON: ${text}`);
        assert.ok(!text.includes('[object Object]'), `${site} rendered [object Object]: ${text}`);
        if (site === 'slide.content' || site === 'presentation.subtitle') {
            // These land inside a structure; the text is in there whole.
            assert.ok(text.includes(EXPECTED), `${site}: ${text}`);
        } else if (site.endsWith('.fileName')) {
            // A file name is the text, made safe and given its extension.
            assert.match(text, /^Beste Jan/, `${site}: ${text}`);
            assert.ok(text.includes('Stoel') && text.includes('Tafel'), `${site}: ${text}`);
        } else {
            assert.ok(text.includes(EXPECTED), `${site}: expected "${EXPECTED}" in ${JSON.stringify(text)}`);
        }
    });
}

test('REGRESSION: the same text as a template still renders the list as JSON; the compose does not', async () => {
    const legacy = (await execNotification({ id: 'n1', type: 'notification', title: 'T', body: TEMPLATE }, CTX, STATE(), 'dry_run')).output.wouldNotify.body;
    assert.equal(legacy, 'Beste Jan: ["Stoel","Tafel"] / [{"product":"Stoel","n":2},{"product":"Tafel","n":1}]', 'a stored template renders exactly as it always has');
    const composed = (await execNotification({ id: 'n1', type: 'notification', title: 'T', body: COMPOSE }, CTX, STATE(), 'dry_run')).output.wouldNotify.body;
    assert.equal(composed, EXPECTED);
});
