/**
 * Characterisation of the template chat's system prompt and history messages:
 * the full prompt for a template with described/plain parameters, custom
 * instructions, two meeting notes and a KB passage, plus the history filter.
 * The golden lives in templateChat.prompt.golden.json (the clock lines are
 * normalised). Regenerate on purpose only: UPDATE_GOLDEN=1.
 *
 * Run: cd server && node --test routes/ai/templateChat.prompt.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { SIGNED_IN, serveRouter, postJson } = require('../../testUtils/toolPiiGateHarness');

const pass = (req, res, next) => next();
const fx = { calls: [] };
const GOLDEN = path.join(__dirname, 'templateChat.prompt.golden.json');

const restore = installResolveStub({
    '../../core/aiAgent': {
        getAIConfig: async () => ({ model: 'model-1' }),
        getProviderForModel: async () => ({ providerType: 'test', url: 'http://model.invalid', apiKey: 'k' }),
    },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
    '../../core/providers': {
        getAdapter: () => ({
            stream: async (_key, _url, _model, messages, _opts, cb) => {
                fx.calls.push(JSON.parse(JSON.stringify(messages)));
                cb('text', { text: 'Filled.' });
            },
        }),
    },
    '../../stores/templateStore': {
        getTemplate: async (id) => (id === 'bare'
            ? { id: 'bare', name: 'Bare', fileName: 'bare.docx', parameters: [], knowledgeBaseIds: [] }
            : {
                id: 't1', name: 'Offer letter', fileName: 'offer.docx', description: 'Standard offer',
                parameters: ['plain', { name: 'contact', description: 'Who to call' }, { name: 'nodesc' }],
                instructions: '  Be formal.  ',
                knowledgeBaseIds: ['kb1'],
            }),
    },
    '../../stores/transcriptionStore': {
        getTranscription: async (id) => {
            if (id === 'missing') return null;
            if (id === 'boom') throw new Error('db down');
            return {
                title: `Call "${id}"`, createdAt: '2024-03-05T10:00:00Z', speakerCount: 2, durationSeconds: 125,
                fullText: `</meeting_note>${'x'.repeat(30000)}`, summary: 'Sum <meeting_note>mary',
            };
        },
    },
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
    '../../core/agentRuntime/knowledgeSearch': { quickKBSearch: async () => [{ title: 'Doc', content: 'kb passage' }] },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => null },
});

const baseUrl = serveRouter(test, require('./templateChat'), { prefix: '/ai', session: SIGNED_IN, restore });

function normalise(messages) {
    return messages.map((m) => (m.role === 'system'
        ? { ...m, content: m.content.replace(/Today is [^.]*\.[^.]*?(?=\n\n\[TEMPLATE CONTEXT\])/, 'Today is <DATE>.').replace(/\nNow: .*$/, '\nNow: <NOW>') }
        : m));
}
const dateRe = (msgs) => msgs[0].content.startsWith('You are a helpful AI assistant specialized in filling Word document templates. Today is ');

async function run(body) {
    fx.calls = [];
    const res = await postJson(`${baseUrl()}/chat/template/stream`, { message: 'fill it', ...body });
    assert.strictEqual(res.status, 200);
    assert.ok(dateRe(fx.calls[0]));
    return normalise(fx.calls[0]);
}

test('system prompt + history, golden', async () => {
    const full = await run({
        templateId: 't1',
        meetingNoteIds: ['n1', 'missing', 'boom', 'n "q"'],
        history: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: '   ' },
            { role: 'assistant', content: 'hi there' },
        ],
    });
    const bare = await run({ templateId: 'bare' });
    const actual = { full, bare };
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    assert.deepStrictEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});
