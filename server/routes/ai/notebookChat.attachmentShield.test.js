/**
 * Notebook chat: the Privacy Shield on attachments and the typed message.
 *
 *   - A 'block' verdict on an attachment ends the turn. It used to fall
 *     through to the ORIGINAL attachment text, and with an image in the turn
 *     the message gate scans only the typed question, so nothing caught it.
 *   - A personal account (no organisation) is scanned with its user-level
 *     shield. The content scans read only the stored ORG shield document, so
 *     a personal account's attachments, document and typed text reached the
 *     model unscanned (the direct-chat equivalent was BFSF-290/291).
 *   - A regex 'redact' rule redacts the content the model receives, so the
 *     tokens the PII gate put in stay in and the attachment text stays.
 *
 * A real server with the router mounted; dependencies are stubbed through
 * testUtils/stubRequire, the real guardrailsRunner runs. Synthetic data.
 *
 * Run: cd server && node --test routes/ai/notebookChat.attachmentShield.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { SIGNED_IN, AI_AGENT_STUB, configStoreStub, serveRouter, postJson } = require('../../testUtils/toolPiiGateHarness');

const pass = (req, res, next) => next();
const fx = {
    shield: null,
    orgId: 'org-1',
    scan: null,
    scanCalls: [],
    validate: null,
    sent: [],
};

const toolDef = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const restoreTokens = (text, map) => Object.entries(map || {}).reduce((s, [tok, real]) => s.split(tok).join(real), String(text));
const dlpRunnerStub = {
    getConversationTokenMap: () => ({}),
    getConversationTokenMapAsync: async () => ({}),
    mergeTokenMap: () => {},
};
const piiDetectionStub = {
    restoreTokens,
    restoreTokensInRichText: restoreTokens,
    windowCountFor: () => 1,
    validateInputForPii: (...args) => (fx.validate ? fx.validate(...args) : null),
};
const recordingProvider = {
    getAdapter: () => ({
        stream: async (_key, _url, _model, messages, _opts, cb) => {
            fx.sent.push(JSON.stringify(messages));
            cb('text', { text: 'Done.' });
        },
    }),
};

const restore = installResolveStub({
    '../../core/aiAgent': AI_AGENT_STUB,
    // The stored org shield document is the resolved one here, so the block
    // and fail-closed cases do not depend on which of the two the route reads.
    '../../stores/configStore': {
        ...configStoreStub({}),
        getConfig: async (key) => (fx.orgId && key === `org_privacy_shield_${fx.orgId}` ? fx.shield : null),
    },
    '../../core/providers': recordingProvider,
    '../../stores/notebookStore': {
        getNotebook: async () => ({ id: 'nb-1', name: 'Matter', knowledgeBaseIds: [], documentMd: '' }),
        getSources: async () => [],
        touchActivity: async () => {},
    },
    '../../stores/notebookConversationStore': { appendMessages: async () => {} },
    '../../support/kbAccess': { partitionAccessibleKBIds: async (req, ids) => ({ allowed: ids, denied: [] }) },
    '../../core/entitlements/betaFeatures': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null },
    '../../auth': { resolveUserOrgIds: async () => (fx.orgId ? new Set([fx.orgId]) : new Set()) },
    '../../auth/permissions': { requireAuth: pass },
    '../../core/llm/modelResolver': {
        getEUAwareTiers: async () => ({ fast: { modelId: 'model-1' } }),
        resolveEffectiveOrgId: async () => fx.orgId,
        TIER_DEFAULTS: { fast: { maxTokens: 1024, temperature: 0.2 } },
    },
    '../../core/http/sseHelpers': { startSseHeartbeat: () => () => {} },
    '../../core/kb/notebookKnowledgeSearch': {
        searchNotebookKB: async () => ({ chunks: [], citations: [], contextPrompt: '' }),
        executeNotebookKBSearchTool: async () => ({ chunks: [] }),
        NOTEBOOK_KB_SEARCH_TOOL: toolDef('notebook_kb_search'),
        findSourceForChunk: () => null,
    },
    '../../integrations/agentSearchTools': { AGENT_SEARCH_TOOLS: [toolDef('agent_search')], isAgentSearchTool: (n) => n === 'agent_search' },
    '../../integrations/agentSearchEgress': { runAgentSearchWithEgress: async () => ({ results: [] }) },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield, mergeWithOrgShield: (org) => org },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async () => {} },
    '../../core/dlp/dlpRunner': dlpRunnerStub,
    './dlpRunner': dlpRunnerStub,
    '../dlp/dlpRunner': dlpRunnerStub,
    '../../core/privacy/piiDetection': piiDetectionStub,
    '../privacy/piiDetection': piiDetectionStub,
    '../../core/dlp/attachmentScanner': {
        scanAttachmentText: async (args) => { fx.scanCalls.push(args.filename); return fx.scan(args); },
    },
    '../../core/dlp/composeScan': { composeScan: async ({ units }) => ({ units, stats: { segments: 0 } }) },
    '../../agents/notebooks/sourceIngestion': { ingestTextSource: async () => {} },
});

const baseUrl = serveRouter(test, require('./notebookChat'), { prefix: '/ai', session: SIGNED_IN, restore });

const NOTES = 'Dossier Jan Jansen BSN 123456782';
const PHOTO = { name: 'photo.png', type: 'image/png', content: 'data:image/png;base64,AAAA' };
const NOTES_TXT = { name: 'notes.txt', type: 'text/plain', content: NOTES };

async function turn({ shield, orgId = 'org-1', scan = async ({ text }) => ({ action: 'pass', text }), validate = null, message = 'Vat de notities samen', attachments }) {
    Object.assign(fx, { shield, orgId, scan, validate, scanCalls: [], sent: [] });
    const res = await postJson(`${baseUrl()}/chat/notebook/stream`, { message, notebookId: 'nb-1', attachments });
    assert.strictEqual(res.status, 200, res.body);
    return res.body;
}

test('a blocked attachment ends the turn and never reaches the model, also next to an image', async () => {
    const body = await turn({
        shield: { enabled: true, piiDetectionAction: 'block', rulesWithNames: [], scope: {} },
        scan: async () => ({ action: 'block', text: null, summary: { byCategory: { NationalIdentificationNumber: 1 } } }),
        attachments: [PHOTO, NOTES_TXT],
    });
    const sent = fx.sent.join('\n');
    assert.ok(!sent.includes('Jan Jansen'), 'the blocked name reached the model');
    assert.ok(!sent.includes('123456782'), 'the blocked BSN reached the model');
    assert.match(body, /Privacy Shield blocked this request/);
});

test('a scan that throws under fail_closed ends the turn', async () => {
    const body = await turn({
        shield: { enabled: true, piiDetectionAction: 'tokenize', dlpFailureMode: 'fail_closed', rulesWithNames: [], scope: {} },
        scan: async () => { throw new Error('guard down'); },
        attachments: [PHOTO, NOTES_TXT],
    });
    assert.ok(!fx.sent.join('\n').includes('123456782'), 'an unchecked attachment reached the model');
    assert.match(body, /Privacy Shield could not verify this content/);
});

test('a personal account (no organisation) has its attachment scanned with its own shield', async () => {
    await turn({
        orgId: null,
        shield: { enabled: true, piiDetectionAction: 'tokenize', rulesWithNames: [], scope: {} },
        scan: async ({ text }) => ({ action: 'tokenize', text: text.replace('Jan Jansen', '[person_1]').replace('123456782', '[bsn_1]') }),
        attachments: [NOTES_TXT],
    });
    assert.deepStrictEqual(fx.scanCalls, ['notes.txt']);
    const sent = fx.sent.join('\n');
    assert.ok(sent.includes('[person_1]'), sent);
    assert.ok(!sent.includes('Jan Jansen'), 'the personal shield never scanned the attachment');
});

test('a regex redaction keeps the PII tokens and the attachment text', async () => {
    const message = 'Bel Jan Jansen over CASE-4821';
    await turn({
        message,
        shield: {
            enabled: true,
            piiDetectionAction: 'tokenize',
            rulesWithNames: [{ name: 'case-ref', pattern: 'CASE-\\d{4}' }],
            scope: { userInput: true, agentOutput: true },
            action: 'redact',
        },
        attachments: [{ name: 'agenda.txt', type: 'text/plain', content: 'Agenda: kwartaalcijfers' }],
        // The PII gate tokenises the whole last message (typed text + attachment).
        validate: async (msgs) => {
            const last = msgs[msgs.length - 1];
            return { tokenizedText: last.content.replace('Jan Jansen', '[person_1]'), tokenMap: { '[person_1]': 'Jan Jansen' }, entities: [{ label: 'Person', category: 'Person' }] };
        },
    });
    const sent = fx.sent.join('\n');
    assert.ok(sent.includes('[REDACTED: case-ref]'), sent);
    assert.ok(!sent.includes('Jan Jansen'), `the real name went back into the prompt: ${sent}`);
    assert.ok(sent.includes('kwartaalcijfers'), `the attachment text was dropped: ${sent}`);
});
