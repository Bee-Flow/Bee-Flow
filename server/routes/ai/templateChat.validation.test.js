/**
 * What POST /ai/chat/template/stream accepts, and what it does with it
 * (routes/ai/templateChat.js).
 *
 * The meeting-note picker on the templates page has no limit and said "7
 * selected", while the route loaded the first five and dropped the rest.
 * The privacy-shield token map was scoped by whatever conversation id the
 * caller sent, someone else's included. What this pins:
 *
 *   - every selected meeting note reaches the prompt, the budget shared;
 *   - a caller's conversation id cannot open another user's token map;
 *   - the composer's shared payload is accepted, a misspelling is not, and
 *     a refusal is a JSON 400 before the stream opens.
 *
 * Run: cd server && node --test routes/ai/templateChat.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

let sentMessages = null;     // what the model was handed
const dlpScopes = [];        // every conversation id the privacy shield keyed on
let shieldOn = false;
const pass = (req, res, next) => next();

const MOCKS = {
    '../../core/aiAgent': {
        getAIConfig: async () => ({ model: 'm1' }),
        getProviderForModel: async () => ({ providerType: 'test', url: '', apiKey: 'k' }),
    },
    '../../stores/configStore': { getConfig: async () => null },
    '../../core/providers': {
        getAdapter: () => ({
            stream: async (key, url, model, messages, opts, cb) => { sentMessages = messages; cb('text', { text: '{"party":"A"}' }); },
        }),
    },
    '../../stores/templateStore': {
        getTemplate: async () => ({ name: 'NDA', fileName: 'nda.docx', parameters: ['party'], knowledgeBaseIds: [] }),
    },
    '../../stores/transcriptionStore': {
        getTranscription: async (id) => ({ title: id, fullText: 'y'.repeat(5000), createdAt: 0 }),
        getTranscriptions: async () => [],
    },
    '../../core/serviceAuth': {},
    '../../auth/permissions': { requireAuth: pass },
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null },
    '../../auth': { resolveUserOrgIds: async () => new Set() },
    '../../core/llm/modelResolver': {
        resolveModelForTier: async () => 'm1',
        getTierConfig: async () => ({}),
        resolveEffectiveOrgId: async () => null,
        TIER_DEFAULTS: { fast: { maxTokens: 100, temperature: 0 } },
    },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => (shieldOn ? { enabled: true } : null) },
    '../../core/dlp/attachmentScanner': {
        scanAttachmentText: async ({ text, conversationId }) => { dlpScopes.push(conversationId); return { action: 'allow', text }; },
    },
    '../../core/dlp/tokenPreservationPrompt': { buildTokenPreservationAddendum: () => '' },
    '../../core/dlp/dlpRunner': { getConversationTokenMap: (id) => { dlpScopes.push(id); return {}; } },
    '../../core/dlp/untokeniseStream': {
        createUntokeniser: (getMap) => { getMap(); return { push: (t) => t, flush: () => '' }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:template-chat-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /ai[\\/]templateChat\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./templateChat');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function post(body) {
    const url = '/chat/template/stream';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false, writableEnded: false, destroyed: false, chunks: [],
            status(c) { this.statusCode = c; return this; },
            writeHead(c) { this.statusCode = c; this.headersSent = true; return this; },
            write(chunk) { this.chunks.push(String(chunk)); return true; },
            on() { return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.writableEnded = true; this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through: POST /chat/template/stream'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

// What the templates page sends through the shared composer.
const COMPOSER = {
    message: 'Fill it in', templateId: 'tpl1', modelTier: 'auto', attachments: [],
    imageGenSettings: {}, nanoBananaSettings: {}, disabledMedia: {}, webSearchEnabled: true,
    memoryWriteEnabled: true, timezone: 'Europe/Amsterdam',
};

test.beforeEach(() => { sentMessages = null; dlpScopes.length = 0; shieldOn = false; });

test('every selected meeting note reaches the prompt — not just the first five', async () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const res = await post({ ...COMPOSER, meetingNoteIds: ids });
    assert.strictEqual(res.statusCode, 200);
    const system = sentMessages[0].content;
    for (const id of ids) assert.ok(system.includes(`title="${id}"`), `${id} is in the prompt`);
    // The five-note budget, shared: 20,000 / 7 characters of each transcript.
    assert.ok(!system.includes('y'.repeat(Math.floor(20000 / 7) + 1)));
});

test('a single id instead of a list is refused, instead of loading no note at all', async () => {
    const res = await post({ ...COMPOSER, meetingNoteIds: 'n1' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.meetingNoteIds'));
    assert.strictEqual(sentMessages, null);
});

test('past twenty notes the answer is a 400 that names the cap, not a quiet cut', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `n${i}`);
    const res = await post({ ...COMPOSER, meetingNoteIds: ids });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'meetingNoteIds is a list of up to 20 meeting note ids.');
    assert.strictEqual(sentMessages, null);
});

test('a history that is not a list is refused, instead of dropped', async () => {
    const res = await post({ ...COMPOSER, history: '[{"role":"user","content":"eerder"}]' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.history'));
    assert.strictEqual(sentMessages, null);
});

test('history content that is not text is a 400, not an internal TypeError in the stream', async () => {
    const res = await post({ ...COMPOSER, history: [{ role: 'user', content: 42 }] });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.history.0.content'));
});

test('a zone Node does not know still chats — ICU says Etc/Unknown when the browser cannot tell', async () => {
    // The direct chat beside this route takes the same composer payload and
    // the same fallback clock; a template chat that refused it would be shut
    // for exactly those people.
    const res = await post({ ...COMPOSER, timezone: 'Etc/Unknown' });
    assert.strictEqual(res.statusCode, 200);
    assert.match(sentMessages[0].content, /\nNow: /);
    const typed = await post({ ...COMPOSER, timezone: 42 });
    assert.strictEqual(typed.statusCode, 400, 'a zone that is not text is still refused');
    assert.ok(typed.body.details.some((d) => d.path === 'body.timezone'));
});

test('the composer payload is accepted; a misspelling of a key this route reads is not', async () => {
    const ok = await post(COMPOSER);
    assert.strictEqual(ok.statusCode, 200);
    const typo = await post({ ...COMPOSER, meetingNoteIDs: ['n1'] });
    assert.strictEqual(typo.statusCode, 400);
});

test('a caller\'s conversation id is namespaced before it keys the privacy-shield map', async () => {
    shieldOn = true;
    const res = await post({
        ...COMPOSER,
        conversationId: 'someone-elses-conversation',
        attachments: [{ name: 'a.txt', type: 'text/plain', content: 'hello' }],
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(dlpScopes.length > 0, 'the shield ran');
    for (const scope of dlpScopes) assert.strictEqual(scope, 'tmpl-u1-someone-elses-conversation');
});
