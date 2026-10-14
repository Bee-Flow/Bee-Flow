/**
 * POST /ai/chat/template/stream keeps a long, silent turn alive and stops
 * when the client does (routes/ai/templateChat.js, core/http/sseHelpers.openSse).
 *
 * The template route set the SSE headers but never started the keep-alive
 * the webpage and notebook chats run: a template turn that thought for more
 * than the Nextcloud AppAPI proxy's idle window was cut off as a 504 and
 * surfaced as a false "Error generating response." (BFSF-221). What this pins:
 *
 *   - while the model is silent, the stream carries the `: ping` comment and
 *     the no-op `ping` event every 10 s;
 *   - the keep-alive stops once the turn ends;
 *   - the client closing the response aborts the model request.
 *
 * Test data is synthetic.
 *
 * Run: cd server && node --test routes/ai/templateChat.heartbeat.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const pass = (req, res, next) => next();
// The model call parks here until the test releases it.
const fx = { started: null, release: null, signal: null };

const restore = installResolveStub({
    '../../core/aiAgent': {
        getAIConfig: async () => ({ model: 'model-1' }),
        getProviderForModel: async () => ({ providerType: 'test', url: 'http://model.invalid', apiKey: 'k' }),
    },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
    '../../core/providers': {
        getAdapter: () => ({
            stream: async (_key, _url, _model, _messages, opts, cb) => {
                fx.signal = opts.signal;
                await new Promise((resolve, reject) => {
                    fx.release = resolve;
                    opts.signal.addEventListener('abort', () => {
                        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
                    });
                    fx.started();
                });
                cb('text', { text: 'Filled.' });
            },
        }),
    },
    '../../stores/templateStore': {
        getTemplate: async () => ({ id: 't1', name: 'Offer letter', fileName: 'offer.docx', parameters: ['party'], knowledgeBaseIds: [] }),
    },
    '../../stores/transcriptionStore': { getTranscription: async () => null },
    '../../core/serviceAuth': {},
    '../../auth/permissions': { requireAuth: pass },
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null },
    '../../auth': { resolveUserOrgIds: async () => new Set() },
    '../../core/llm/modelResolver': {
        resolveModelForTier: async () => 'model-1',
        getTierConfig: async () => ({}),
        resolveEffectiveOrgId: async () => null,
        TIER_DEFAULTS: { fast: { maxTokens: 100, temperature: 0 } },
    },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => null },
});

const router = require('./templateChat');
test.after(restore);

/** A response double that records writes and lets the test fire 'close'. */
function fakeRes() {
    const handlers = {};
    return {
        statusCode: 200, headersSent: false, writableEnded: false, destroyed: false, chunks: [], headers: null,
        status(c) { this.statusCode = c; return this; },
        writeHead(c, h) { this.statusCode = c; this.headers = h; this.headersSent = true; return this; },
        write(chunk) { this.chunks.push(String(chunk)); return true; },
        on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
        emit(ev) { for (const fn of handlers[ev] || []) fn(); },
        json(b) { this.body = b; this.headersSent = true; this.done(); return this; },
        end() { this.writableEnded = true; this.headersSent = true; this.emit('finish'); this.emit('close'); this.done(); return this; },
        done() {},
    };
}

/** Start a turn and wait until the (stubbed) model call is in flight. */
async function startTurn() {
    const res = fakeRes();
    const finished = new Promise((resolve) => { res.done = resolve; });
    const started = new Promise((resolve) => { fx.started = resolve; });
    const url = '/chat/template/stream';
    const req = {
        method: 'POST', url, originalUrl: url, path: url, query: {}, headers: {},
        body: { message: 'Fill it in', templateId: 't1' },
        session: { user: { id: 'u1' } }, get() { return undefined; },
    };
    router(req, res, (err) => { throw err || new Error('fell through'); });
    await started;
    return { res, finished };
}

const pings = (res) => res.chunks.filter((c) => c.includes(': ping') && c.includes('event: ping')).length;

test('a silent template turn carries the keep-alive every 10 s, and it stops when the turn ends', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { res, finished } = await startTurn();
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Content-Type'], 'text/event-stream');
    assert.strictEqual(res.headers['X-Accel-Buffering'], 'no');

    assert.strictEqual(pings(res), 0, 'no ping before the first interval');
    t.mock.timers.tick(10000);
    assert.strictEqual(pings(res), 1, 'the proxy saw no byte for 10 s');
    t.mock.timers.tick(20000);
    assert.strictEqual(pings(res), 3);

    fx.release();
    await finished;
    const joined = res.chunks.join('');
    assert.ok(joined.includes('event: content\ndata: {"text":"Filled."}'));
    assert.ok(joined.includes('event: done'));
    const after = res.chunks.length;
    t.mock.timers.tick(60000);
    assert.strictEqual(res.chunks.length, after, 'no keep-alive after the turn ended');
});

test('the client closing the stream aborts the model request and ends quietly', async () => {
    const { res, finished } = await startTurn();
    assert.strictEqual(fx.signal.aborted, false);
    res.destroyed = true;
    res.emit('close');
    await finished;
    assert.strictEqual(fx.signal.aborted, true, 'the model request ran on after the client left');
    assert.ok(!res.chunks.join('').includes('event: error'), 'a cancel is not reported as an error');
    assert.ok(res.writableEnded);
});
