/**
 * Tests for appStudio/aiRuntime.js — the acts-as-owner AI runtime.
 *
 * Run: node --test appStudio/aiRuntime.test.js
 *
 * Every collaborator (modelResolver, llmClient, usageStore, knowledgeSearch,
 * studioAppDataStore, storageStore, attachmentExtractor, aiAgent) is mocked via
 * the require cache BEFORE aiRuntime is required, so no DB/provider is touched.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { Readable } = require('stream');

function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// ── Mutable mock state (tests flip these) ────────────────────────────────────
const state = {
    tierMap: { fast: { modelId: 'm-fast' }, standard: { modelId: 'm-std' }, thinking: { modelId: 'claude-fable-5' } },
    tierConfig: { maxTokens: 1024, temperature: 0.2, reasoningEffort: 'low' },
    globalModel: null,
    visibleKbIds: null,
    structured: { rows: [{ vendor: 'ACME', amount: '10' }] },
    text: 'a summary',
    usageCalls: [],
    kbChunks: [{ title: 'Handbook', content: 'Policy body', score: 0.9 }],
    attachments: {
        good: { id: 'good', sha256: 'a'.repeat(64), mimeType: 'application/pdf', size: 100, scanned: true, quarantined: false },
        dirty: { id: 'dirty', sha256: 'b'.repeat(64), mimeType: 'application/pdf', size: 100, scanned: false, quarantined: false },
        docx: { id: 'docx', sha256: 'c'.repeat(64), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 100, scanned: true, quarantined: false },
    },
    extract: { kind: 'text', text: 'INVOICE #123 ACME 10.00', source: 'pdfjs', meta: {} },
    extractCalls: [],
    fileBytes: Buffer.from('file-bytes'),
    forcedToolOptions: null,
};

// canonicalTierName is the REAL implementation, deliberately. Re-spelling the
// tier:/alias rules in a stub is how 'tier:smart' stayed broken for a whole
// wave: the stub agreed with the bug, so the test confirmed it. Only the
// DB-touching lookups are stubbed. (It is a pure string function; requiring
// modelResolver here pulls in configStore but calls nothing on it.)
const { canonicalTierName } = require('../core/llm/modelResolver');

mock('../core/llm/modelResolver', {
    getUserTierMap: async () => state.tierMap,
    getTierConfig: async () => state.tierConfig,
    canonicalTierName,
});
mock('../core/llm/llmClient', {
    chatForcedTool: async (_m, _msgs, _tool, options) => {
        state.forcedToolOptions = options;
        return { structured: state.structured, content: null, usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
    chat: async () => ({ content: state.text, usage: { prompt_tokens: 8, completion_tokens: 4 } }),
    stream: async (modelId, messages, options, onEvent) => {
        onEvent('text', { text: 'hello' });
        onEvent('done', { usage: { prompt_tokens: 3, completion_tokens: 2 } });
    },
});
mock('../stores/usageStore', {
    logUsage: async (entry) => { state.usageCalls.push(entry); },
});
// K5: grounding filters the requested ids against the VIEWER before it
// searches. Stubbed with the rest so no store is touched; `state.visibleKbIds`
// null means "everything requested survives".
mock('../core/kb/kbVisibility', {
    filterKbIdsForUser: async (ids) => (state.visibleKbIds === null ? ids : ids.filter(id => state.visibleKbIds.includes(id))),
    filterKbIdsForEmbed: async (ids) => ids,
});
mock('../core/kb/askerContext', { askerContext: async () => ({ orgIds: new Set(['org1']), userGroups: [] }) });

mock('../core/agentRuntime/knowledgeSearch', {
    quickKBSearch: async () => state.kbChunks,
});
mock('../stores/studioAppDataStore', {
    getAttachment: async (fileId) => state.attachments[fileId] || null,
});
mock('../stores/storageStore', {
    buildStudioAppAttachmentKey: (ownerId, appId, sha256) => `studio-apps/${ownerId}/${appId}/attachments/${sha256}`,
    streamFile: async () => ({ stream: Readable.from([state.fileBytes]), contentType: 'application/pdf', contentLength: state.fileBytes.length }),
});
mock('../core/documents/attachmentExtractor', {
    extractAttachment: async (att, opts) => { state.extractCalls.push({ name: att.name, type: att.type, opts }); return state.extract; },
    formatTextHeader: (att) => `[${att.name} — extracted]`,
    formatImagesHeader: (att) => `[${att.name} — images]`,
    formatFailureNote: (att) => `[${att.name} — failed]`,
});
mock('../core/aiAgent', {
    getAIConfig: async () => ({ model: state.globalModel }),
});

const aiRuntime = require('./aiRuntime');

const APP = { id: 'app1', userId: 'owner1', organizationId: 'org1', name: 'Ops' };

test('resolveOwnerModel: honours a configured tier + returns options and vision flag', async () => {
    const m = await aiRuntime.resolveOwnerModel(APP, 'thinking');
    assert.strictEqual(m.modelId, 'claude-fable-5');
    assert.strictEqual(m.tierName, 'thinking');
    assert.strictEqual(m.supportsVision, true); // claude-fable matches the vision regex
    assert.strictEqual(m.options.maxTokens, 1024);
});

test('resolveOwnerModel: auto / unconfigured tier falls back to a configured tier (never the global default)', async () => {
    const auto = await aiRuntime.resolveOwnerModel(APP, 'auto');
    assert.strictEqual(auto.modelId, 'm-std'); // prefers standard
    const stale = await aiRuntime.resolveOwnerModel(APP, 'no-such-tier');
    assert.strictEqual(stale.modelId, 'm-std');
});

test('resolveOwnerModel: accepts a tier: prefix and a legacy alias', async () => {
    // Tier maps are keyed by bare names. 'tier:smart' missed the lookup and fell
    // through to the standard fallback, so the support desk's "smart" draft
    // button has never once used the smart model — silently, which is why it
    // survived. 'smart' is the legacy alias for 'thinking'.
    for (const asked of ['tier:thinking', 'smart', 'tier:smart']) {
        const m = await aiRuntime.resolveOwnerModel(APP, asked);
        assert.strictEqual(m.tierName, 'thinking', `${asked} should resolve to thinking`);
        assert.strictEqual(m.modelId, 'claude-fable-5', `${asked} should reach the thinking model`);
    }
});

test('resolveOwnerModel: throws 400 when the owner has no configured model at all', async () => {
    const saved = state.tierMap;
    state.tierMap = {};
    state.globalModel = null;
    try {
        await assert.rejects(() => aiRuntime.resolveOwnerModel(APP, 'fast'), (e) => e.status === 400);
    } finally {
        state.tierMap = saved;
    }
});

test('runStructured: returns the parsed object and logs owner-attributed usage', async () => {
    state.usageCalls = [];
    const model = await aiRuntime.resolveOwnerModel(APP, 'standard');
    const params = aiRuntime.fieldsToObjectSchema([{ name: 'vendor', type: 'string', required: true }]);
    const { structured } = await aiRuntime.runStructured(APP, model, { system: 'sys', user: 'extract', parameters: params });
    assert.deepStrictEqual(structured, state.structured);
    assert.strictEqual(state.usageCalls.length, 1);
    assert.strictEqual(state.usageCalls[0].user_id, 'owner1');
    assert.strictEqual(state.usageCalls[0].organization_id, 'org1');
    assert.strictEqual(state.usageCalls[0].source, 'studio_app_ai');
    assert.strictEqual(state.usageCalls[0].prompt_tokens, 10);
});

test('runStructured: throws 422 when the model returns no structured output', async () => {
    const saved = state.structured;
    state.structured = null;
    try {
        const model = await aiRuntime.resolveOwnerModel(APP, 'standard');
        await assert.rejects(
            () => aiRuntime.runStructured(APP, model, { system: 's', user: 'u', parameters: { type: 'object' } }),
            (e) => e.status === 422,
        );
    } finally {
        state.structured = saved;
    }
});

test('runText: returns content and logs usage', async () => {
    state.usageCalls = [];
    const model = await aiRuntime.resolveOwnerModel(APP, 'fast');
    const { text } = await aiRuntime.runText(APP, model, { system: 's', user: 'summarize this' });
    assert.strictEqual(text, 'a summary');
    assert.strictEqual(state.usageCalls.length, 1);
});

test('groundWithKB: empty context without kbIds; builds a numbered context block otherwise', async () => {
    const VIEWER = { id: 'u_viewer' };
    const none = await aiRuntime.groundWithKB(APP, { knowledgeBaseIds: [], query: 'x', viewer: VIEWER });
    assert.deepStrictEqual(none, { context: '', chunks: [] });

    const g = await aiRuntime.groundWithKB(APP, { knowledgeBaseIds: ['kb1'], query: 'what is the policy?', viewer: VIEWER });
    assert.match(g.context, /\[\[1\]\] Handbook/);
    assert.match(g.context, /Policy body/);
    assert.strictEqual(g.chunks.length, 1);
});

test('groundWithKB: the VIEWER decides which bases are searched, not the owner', async () => {
    // It used to search as app.userId and reason that a viewer therefore
    // "can never reach a KB the owner can't" — true, and the wrong bound: an
    // app published to the organisation would answer out of its author's
    // private material.
    state.visibleKbIds = [];
    try {
        const g = await aiRuntime.groundWithKB(APP, {
            knowledgeBaseIds: ['kb_owner_private'], query: 'what is the policy?', viewer: { id: 'u_viewer' },
        });
        assert.deepStrictEqual(g, { context: '', chunks: [] });
    } finally {
        state.visibleKbIds = null;
    }
});

test('groundWithKB: the public role grounds on nothing', async () => {
    // An app open to the internet grounding on somebody's private notes is
    // the case this prevents. "No identity" cannot resolve into a permission.
    const g = await aiRuntime.groundWithKB(APP, { knowledgeBaseIds: ['kb1'], query: 'policy?', viewer: null });
    assert.deepStrictEqual(g, { context: '', chunks: [] });

    const g2 = await aiRuntime.groundWithKB(APP, { knowledgeBaseIds: ['kb1'], query: 'policy?' });
    assert.deepStrictEqual(g2, { context: '', chunks: [] });
});

test('extractDocuments: builds a text block for a clean owner attachment', async () => {
    const blocks = await aiRuntime.extractDocuments(APP, [{ fileId: 'good', name: 'invoice.pdf' }], { modelSupportsVision: false });
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'text');
    assert.match(blocks[0].text, /INVOICE #123/);
});

test('extractDocuments: rejects a foreign fileId (owner-scoped) and an unscanned file', async () => {
    await assert.rejects(
        () => aiRuntime.extractDocuments(APP, [{ fileId: 'foreign' }], {}),
        (e) => e.status === 400,
    );
    await assert.rejects(
        () => aiRuntime.extractDocuments(APP, [{ fileId: 'dirty' }], {}),
        (e) => e.status === 400 && /malware scan/i.test(e.message),
    );
});

test('extractDocuments: a non-owner viewer must be able to READ the file', async () => {
    // ai_extract's `source` resolves from client-supplied formValues/vars/item.
    // Owner-scope plus a scan flag was enough while the only way in was
    // uploading to your own form; it stopped being enough once a mailbox
    // started filling a file column with other people's documents. Without this
    // check any signed-in viewer could name any fileId in the app and have the
    // model read it out — and with writeTo, copy it into a table they can read.
    const attachmentAccess = require('./attachmentAccess');
    const realCheck = attachmentAccess.viewerMayReadAttachment;
    attachmentAccess.viewerMayReadAttachment = async () => false;
    try {
        await assert.rejects(
            () => aiRuntime.extractDocuments(APP, [{ fileId: 'good' }], {
                viewer: { id: 'not-the-owner', role: 'agent' },
                model: { tables: [] },
            }),
            (e) => e.status === 403,
        );
        // The OWNER is not subject to it — it is their own storage envelope.
        attachmentAccess.viewerMayReadAttachment = async () => false;
        const blocks = await aiRuntime.extractDocuments(APP, [{ fileId: 'good' }], {
            viewer: { id: APP.userId, role: 'owner' },
            model: { tables: [] },
        });
        assert.strictEqual(blocks.length, 1);
    } finally {
        attachmentAccess.viewerMayReadAttachment = realCheck;
    }
});

test('runStructured passes a hard timeout to the provider', async () => {
    // 8 documents x 60k chars inside a loop is two clicks away. Without a
    // ceiling nothing can end that request: it holds an Express handler, a DB
    // connection and the viewer's spinner for as long as the provider likes.
    const model = await aiRuntime.resolveOwnerModel(APP, 'standard');
    await aiRuntime.runStructured(APP, model, { system: 's', user: 'u', parameters: { type: 'object' } });
    const opts = state.forcedToolOptions;
    assert.strictEqual(opts.timeoutMs, aiRuntime.STUDIO_APP_AI_TIMEOUT_MS);
    assert.ok(opts.timeoutMs > 0);
});

test('fieldsToObjectSchema + coercion helpers', () => {
    const schema = aiRuntime.fieldsToObjectSchema([
        { name: 'amount', type: 'number', required: true },
        { name: 'paid', type: 'boolean' },
        { name: 'bad name', type: 'string' }, // invalid identifier — dropped
    ]);
    assert.deepStrictEqual(Object.keys(schema.properties), ['amount', 'paid']);
    assert.deepStrictEqual(schema.required, ['amount']);
    assert.strictEqual(aiRuntime.coerceValue('number', '€ 12.50'), 12.5);
    assert.strictEqual(aiRuntime.coerceValue('boolean', 'yes'), true);
    assert.deepStrictEqual(aiRuntime.coerceRowToFields({ amount: '3', extra: 'x' }, [{ name: 'amount', type: 'number' }]), { amount: 3 });
});

// ── Document budgets (MAX_DOCS + the aggregate ceilings) ─────────────────────

test('document caps: MAX_DOCS is 20 and every aggregate ceiling is exported', () => {
    assert.strictEqual(aiRuntime.MAX_DOCS, 20);
    assert.strictEqual(aiRuntime.MAX_TOTAL_DOC_CHARS, 200_000);
    assert.strictEqual(aiRuntime.MAX_TOTAL_DOC_BYTES, 16 * 1024 * 1024);
    assert.strictEqual(aiRuntime.MAX_TOTAL_DOC_IMAGES, 30);
});

test('extractDocuments: 22 documents → 20 processed + ONE note naming the 2 left out', async () => {
    const descriptors = Array.from({ length: 22 }, (_, i) => ({ fileId: 'good', name: `doc${i + 1}.pdf` }));
    const blocks = await aiRuntime.extractDocuments(APP, descriptors, { modelSupportsVision: false });

    assert.strictEqual(blocks.length, 21, '20 text blocks + 1 note');
    const notes = blocks.filter((b) => /not included/.test(b.text || ''));
    assert.strictEqual(notes.length, 1, 'exactly one aggregate note, never one per file');
    assert.strictEqual(blocks.at(-1), notes[0], 'the note trails the batch');
    assert.match(notes[0].text, /2 of 22 documents/);
    assert.match(notes[0].text, /doc21\.pdf/);
    assert.match(notes[0].text, /doc22\.pdf/);
});

test('extractDocuments: exhausting the aggregate char budget lands later docs in the note', async () => {
    // 60k per doc (MAX_DOC_CHARS): four docs drain the 200k aggregate, so the
    // fifth can contribute nothing but its name — and the model must be TOLD,
    // never left to assume its evidence was complete.
    const saved = state.extract;
    state.extract = { kind: 'text', text: 'x'.repeat(70_000), source: 'pdfjs', meta: {} };
    try {
        const descriptors = Array.from({ length: 5 }, (_, i) => ({ fileId: 'good', name: `doc${i + 1}.pdf` }));
        const blocks = await aiRuntime.extractDocuments(APP, descriptors, { modelSupportsVision: false });

        const texts = blocks.filter((b) => b.type === 'text' && !/not included/.test(b.text));
        assert.strictEqual(texts.length, 4, 'only four documents fit the budget');
        const note = blocks.at(-1);
        assert.match(note.text, /1 of 5 documents were not included/);
        assert.match(note.text, /doc5\.pdf/, 'the skipped document is NAMED, not silently truncated');
    } finally {
        state.extract = saved;
    }
});

// ── Native {type:'document'} PDF blocks ──────────────────────────────────────

const isDocBlock = (b) => b.type === 'document';

test('extractDocuments: nativeDocuments adds the raw-PDF block ALONGSIDE the text block', async () => {
    const blocks = await aiRuntime.extractDocuments(APP, [{ fileId: 'good', name: 'invoice.pdf' }], {
        modelSupportsVision: false, nativeDocuments: true,
    });
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].type, 'text', 'the extracted text stays — it is the guaranteed-readable channel');
    assert.match(blocks[0].text, /INVOICE #123/);
    assert.strictEqual(blocks[1].type, 'document');
    assert.deepStrictEqual(blocks[1].source, {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from('file-bytes').toString('base64'),
    });
});

test('extractDocuments: no native block without the capability, with redacted text, or in text mode', async () => {
    const pdf = [{ fileId: 'good', name: 'invoice.pdf' }];
    const off = await aiRuntime.extractDocuments(APP, pdf, { nativeDocuments: false });
    assert.ok(!off.some(isDocBlock), 'a provider that cannot take the block never gets it');

    const redacted = await aiRuntime.extractDocuments(APP, pdf, { nativeDocuments: true, textWasRedacted: true });
    assert.ok(!redacted.some(isDocBlock), 'redacted text must not ship the unredacted original alongside');

    const textMode = await aiRuntime.extractDocuments(APP, pdf, { nativeDocuments: true, documentMode: 'text' });
    assert.ok(!textMode.some(isDocBlock), 'documentMode:text keeps the request text-only');
});

test('extractDocuments: only PDFs get a native block — a docx never does', async () => {
    const blocks = await aiRuntime.extractDocuments(APP, [{ fileId: 'docx', name: 'report.docx' }], {
        nativeDocuments: true,
    });
    assert.ok(blocks.length >= 1);
    assert.ok(!blocks.some(isDocBlock));
});

test('extractDocuments: a PDF past the raw-byte budget drops its native block, keeps its text', async () => {
    const saved = state.fileBytes;
    state.fileBytes = Buffer.alloc(aiRuntime.MAX_TOTAL_DOC_BYTES + 1);
    try {
        const blocks = await aiRuntime.extractDocuments(APP, [{ fileId: 'good', name: 'huge.pdf' }], {
            nativeDocuments: true,
        });
        assert.ok(!blocks.some(isDocBlock), 'over budget → no raw block for this one');
        assert.strictEqual(blocks[0].type, 'text', 'the extracted text still travels');
    } finally {
        state.fileBytes = saved;
    }
});

test('extractDocuments: documentMode is handed through to the extractor', async () => {
    state.extractCalls = [];
    await aiRuntime.extractDocuments(APP, [{ fileId: 'good', name: 'a.pdf' }], {
        modelSupportsVision: true, documentMode: 'images',
    });
    assert.strictEqual(state.extractCalls.length, 1);
    assert.strictEqual(state.extractCalls[0].opts.documentMode, 'images');
    assert.strictEqual(state.extractCalls[0].opts.modelSupportsVision, true);
});

// ── Vision results (images + ride-along text) ────────────────────────────────

test('extractDocuments: forced rendering keeps the title-block text AND the images, capped at 30', async () => {
    const saved = state.extract;
    state.extract = {
        kind: 'images',
        images: Array.from({ length: 35 }, (_, i) => ({ mimeType: 'image/png', base64: `IMG${i}` })),
        text: 'TITLE BLOCK: TN-1 staal 5mm',
        source: 'vision-forced',
    };
    try {
        const blocks = await aiRuntime.extractDocuments(APP, [{ fileId: 'good', name: 'drawing.pdf' }], {
            modelSupportsVision: true, documentMode: 'images',
        });
        const images = blocks.filter((b) => b.type === 'image_url');
        assert.strictEqual(images.length, aiRuntime.MAX_TOTAL_DOC_IMAGES, '35 rendered pages cap at 30');
        assert.strictEqual(images[0].image_url.url, 'data:image/png;base64,IMG0');
        assert.ok(blocks.some((b) => b.type === 'text' && /TITLE BLOCK/.test(b.text)),
            'the ride-along text is inlined — it is the cheapest half of the drawing');
        assert.ok(blocks.some((b) => b.type === 'text' && /drawing\.pdf — images/.test(b.text)), 'the images header names the file');
    } finally {
        state.extract = saved;
    }
});

test('coerceValue(number): locale-ambiguous separators keep their real magnitude', () => {
    const n = (v) => aiRuntime.coerceValue('number', v);
    assert.strictEqual(n('1.234,56'), 1234.56, 'EU: last separator is the decimal one');
    assert.strictEqual(n('1,234.56'), 1234.56, 'US: last separator is the decimal one');
    assert.strictEqual(n('1234'), 1234);
    assert.strictEqual(n('1.234'), 1234, 'a lone separator with 3 trailing digits is a thousands separator');
    assert.strictEqual(n('1,5'), 1.5, 'a lone separator with 1 trailing digit is decimal');
    assert.strictEqual(n('€ 1.234.567,89'), 1234567.89);
    assert.strictEqual(n('-1.234,56'), -1234.56);
    assert.strictEqual(n('1,234,567'), 1234567, 'a repeated separator is a thousands separator');
    assert.strictEqual(n('1.5e3'), 1500, 'exponent notation is unambiguous');
    assert.strictEqual(n('not a number'), null);
});
