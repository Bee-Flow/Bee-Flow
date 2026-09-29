/**
 * BFSF-354 — a template's knowledge bases are searched and their passages
 * injected into the prompt without a tool call. The Privacy Shield's "own
 * server" block list applies to them as it does to kb_search: the passage
 * text, and the "### Source N: <label>" line it is shown under (a document's
 * title can carry the same data, e.g. an e-mail archive's "<sender> — <subject>").
 *
 * A real server with the router mounted; dependencies are stubbed through
 * testUtils/stubRequire and the real gate runs with its detector injected.
 * Test data is synthetic.
 *
 * Run: cd server && node --test routes/ai/templateChat.kb.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { SYNTH_EMAIL, OWN_SERVER_EMAIL, SIGNED_IN, injectEmailDetector, serveRouter, postJson } = require('../../testUtils/toolPiiGateHarness');

const pass = (req, res, next) => next();
const fx = { shield: null, chunks: [], prompts: [] };

const restore = installResolveStub({
    '../../core/aiAgent': {
        getAIConfig: async () => ({ model: 'model-1' }),
        getProviderForModel: async () => ({ providerType: 'test', url: 'http://model.invalid', apiKey: 'k' }),
    },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
    '../../core/providers': {
        getAdapter: () => ({
            stream: async (_key, _url, _model, messages, _opts, cb) => {
                fx.prompts.push(messages[0].content);
                cb('text', { text: 'Filled.' });
            },
        }),
    },
    '../../stores/templateStore': {
        getTemplate: async () => ({
            id: 't1', name: 'Offer letter', fileName: 'offer.docx', parameters: [{ name: 'contact' }],
            knowledgeBaseIds: ['kb1'],
        }),
    },
    '../../stores/transcriptionStore': { getTranscription: async () => null },
    '../../core/serviceAuth': {},
    '../../auth/permissions': { requireAuth: pass },
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null },
    '../../auth': { resolveUserOrgIds: async () => new Set(['org-1']) },
    '../../core/llm/modelResolver': {
        resolveModelForTier: async () => 'model-1',
        getTierConfig: async () => ({}),
        resolveEffectiveOrgId: async () => 'org-1',
        TIER_DEFAULTS: { fast: { maxTokens: 1024, temperature: 0.2 } },
    },
    '../../core/agentRuntime/knowledgeSearch': { quickKBSearch: async () => fx.chunks.map(c => ({ ...c })) },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield },
    '../../core/dlp/attachmentScanner': { scanAttachmentText: async ({ text }) => ({ action: 'pass', text }) },
});

injectEmailDetector(require('../../core/privacy/toolPiiGate'));

const baseUrl = serveRouter(test, require('./templateChat'), { prefix: '/ai', session: SIGNED_IN, restore });

async function turn(shield) {
    fx.shield = shield;
    fx.prompts = [];
    fx.chunks = [
        { title: 'Contacts', content: `billing: ${SYNTH_EMAIL}` },
        { title: `${SYNTH_EMAIL} — offer`, content: 'the offer is attached' },
    ];
    const res = await postJson(`${baseUrl()}/chat/template/stream`, { message: 'fill in the contact', templateId: 't1' });
    assert.strictEqual(res.status, 200);
    return fx.prompts[0];
}

test('the template\'s passages and their source labels lose what the own-server list blocks', async () => {
    const prompt = await turn(OWN_SERVER_EMAIL);
    assert.ok(!prompt.includes(SYNTH_EMAIL), 'the blocked value reached the prompt');
    assert.ok(prompt.includes('billing: [blocked:email]'));
    assert.ok(prompt.includes('### Source 2: [blocked:email] — offer'));
});

test('no shield: the passages go in as before', async () => {
    const prompt = await turn(null);
    assert.ok(prompt.includes(`billing: ${SYNTH_EMAIL}`));
    assert.ok(prompt.includes(`### Source 2: ${SYNTH_EMAIL} — offer`));
});
