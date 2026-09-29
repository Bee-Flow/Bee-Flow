/**
 * POST /builder/stream (routes/ai/appStudioBuilder/chatStream.js) — what the
 * route does with a body its contract refuses.
 *
 * The contract itself is `TurnBody` in ./turnSetup.js, pinned value by value
 * in turnSetup.validation.test.js. What this file pins is the ROUTE's half:
 * a refusal is answered verbatim as JSON with a status, before the stream
 * opens and before anything else runs — no subscription check, no draft
 * load, no model resolution. A client can only branch on a status it gets;
 * an `error` event inside a 200 is a stream it has to read to the end.
 *
 * Run: cd server && node --test routes/ai/appStudioBuilder/chatStream.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Everything past the contract lands in `touched`. A refused turn leaves it empty.
const touched = [];
const pass = (req, res, next) => next();
const LIMIT_TEXT = 'You have used this month\'s chat allowance.';

const MOCKS = {
    // chatStream.js
    '../../../stores/studioAppStore': {},
    '../../../core/providers': { getAdapter: () => { touched.push('adapter'); return {}; } },
    '../../../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    '../../../core/http/sseHelpers': { startSseHeartbeat: () => () => {} },
    '../../../auth/permissions': { requireAuth: pass },
    '../../../auth': { resolveUserOrgIds: async () => { touched.push('orgs'); return new Set(['orgA']); } },
    // A valid turn is stopped here, still pre-SSE, by a spent allowance.
    '../../../core/entitlements/limits': { checkSubscriptionLimits: async () => { touched.push('limits'); return LIMIT_TEXT; } },
    './modelSelection': { resolveBuilderModel: async () => { touched.push('model'); return { error: 'unreachable' }; } },
    './promptAssembly': { assembleTurnPrompt: async () => { throw new Error('unreachable'); } },
    './usageAccounting': { makeTurnUsageLogger: () => () => {} },
    './buildLoop': { runBuildLoop: async () => {} },
    './turnClosing': {},
    // turnSetup.js — only readTurnRequest runs; the stores behind the rest are inert.
    '../../../stores/studioAppDataStore': {},
    '../../../appStudio/canonicalize': { canonicalizeAppDefinition: (d) => ({ def: d }) },
    '../../../appStudio/componentSpecs': { emptyDefinition: () => ({}) },
    '../../../appStudio/builderTools/appNaming': { briefForNaming: () => '' },
    '../../../appStudio/linkedTables': { describeLinkedTables: async () => new Map(), overlayLinkedRowCounts: (c) => c },
    '../../../core/llm/planChecklist': { normalizePlanTodos: (t) => t },
    '../../../core/llm/screenConstraints': { deriveScreenConstraints: () => null },
    './dataModelEvent': { normalizeRowCounts: () => ({}) },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:app-builder-stream-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /appStudioBuilder[\\/](chatStream|turnSetup)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./chatStream');
test.after(() => { Module._resolveFilename = originalResolve; });

function post(body) {
    const url = '/stream';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; }, on() { return this; },
        };
        const res = {
            statusCode: 200, headersSent: false, streamed: false,
            status(c) { this.statusCode = c; return this; },
            writeHead(c) { this.statusCode = c; this.headersSent = true; this.streamed = true; return this; },
            write() { return true; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error('fell through: POST /stream')));
    });
}

test.beforeEach(() => { touched.length = 0; });

test('a key the contract does not know is a JSON 400 before anything runs', async () => {
    const res = await post({ message: 'Build a CRM', tier: 'thinking' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.streamed, false, 'no stream was opened');
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'body'), 'the refusal is pathed');
    assert.deepStrictEqual(touched, [], 'no subscription check, no draft, no model');
});

test('a misspelled planMode is refused by name, not built under "auto"', async () => {
    const res = await post({ message: 'Build a CRM', planMode: 'Never' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "planMode is 'auto', 'always' or 'never'.");
    assert.deepStrictEqual(res.body.details.map((d) => d.path), ['body.planMode']);
    assert.deepStrictEqual(touched, []);
});

test('the page\'s ordinary turn passes the contract and reaches the allowance check', async () => {
    const res = await post({
        message: 'Build a CRM', appId: 'app_1', builderSessionId: 'as_1', modelTier: 'fast',
        context: { screenId: 'scr_1', selectedNodeIds: ['cmp_1'] }, planMode: 'never', timezone: 'Europe/Amsterdam',
    });
    assert.strictEqual(res.statusCode, 402, 'stopped by the allowance, not by the contract');
    assert.deepStrictEqual(res.body, { error: LIMIT_TEXT, code: 'subscription_limit' });
    assert.strictEqual(res.streamed, false);
    assert.deepStrictEqual(touched, ['orgs', 'limits']);
});
