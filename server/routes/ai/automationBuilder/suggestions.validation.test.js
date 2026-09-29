/**
 * What the "Find repeating work" routes accept, and what they say when they
 * refuse (routes/ai/automationBuilder/suggestions.js).
 *
 * `integrationIds` that was not a list became "no selection", and no
 * selection scans EVERY connected app — one app picked, all of them read into
 * a model. What this pins:
 *
 *   - anything but a list of app ids is a 400, before the stream opens;
 *   - `[]` still means "all apps" (the meeting-notes panel sends it on purpose);
 *   - a focus is no longer cut at 280 characters;
 *   - the feedback body is checked, and the scan's own suggestion object —
 *     with keys this route never reads — is still accepted.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/suggestions.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const events = [];     // SSE events the scan sent
const saved = [];      // feedback rows written
let prompts = [];      // system prompts the scan built
let betaOn = true;
const pass = (req, res, next) => next();

const MOCKS = {
    '../../../stores/automationStore': { getAutomationsForUser: async () => [] },
    '../../../core/llm/modelResolver': {
        isEUModeActive: async () => ({ isEU: false }),
        resolveModelForTierName: async () => 'fast-model',
    },
    '../../../core/llm/llmClient': {
        chatForcedTool: async () => ({ structured: null, content: '' }),
    },
    '../../../auth/permissions': { requireAuth: pass },
    './rateLimits': { suggestRateLimit: pass, feedbackRateLimit: pass },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => betaOn },
    '../../../core/http/sseHelpers': {
        setupSSE: () => ({ sendEvent: (e, d) => events.push([e, d]), abortController: new AbortController(), markEnded() {} }),
        startSseHeartbeat: () => () => {},
    },
    '../../../automation/suggestions': {
        buildScanSystemPrompt: (opts) => { prompts.push(opts); return 'sys'; },
        buildScanDigest: () => '',
        parseSuggestionsJson: () => [],
        extractSuggestionsFromToolCall: () => [],
        normaliseSuggestions: () => [],
        buildActivityIndex: () => null,
        computeScanCacheKey: () => 'k',
        resolveActivityFilter: () => ({}),
        fingerprintTitle: (title) => `fp:${title}`,
        SUGGESTIONS_TOOL: {},
    },
    '../../../stores/suggestionScanCache': {
        deriveScopeKey: () => 'scope',
        getCachedScan: async () => null,
        upsertScan: async () => {},
        removeSuggestionsFromScope: async () => {},
    },
    '../../../stores/suggestionFeedbackStore': {
        VALID_ACTIONS: ['dismissed', 'built', 'asked'],
        getRecentSuppressedTitles: async () => [],
        saveSuggestionFeedback: async (row) => { saved.push(row); },
    },
    '../../../stores/integrationActivityStore': { getIntegrationByTool: async () => [] },
    // Only write tools are available, so a scan is one ideation call.
    '../../../core/integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [{ function: { name: 'gmail_send' } }, { function: { name: 'drive_upload' } }] }),
    },
    '../../../automation/sideEffectMap': { isSideEffect: () => true },
    '../../../core/integrations/integrationToolMap': { resolveIntegration: (name) => ({ integration: name.split('_')[0] }) },
    '../../../core/tools/toolDispatcher': { executeTool: async () => ({}) },
    '../../../core/automationRunner/safety': {
        resolveAutomationPolicy: async () => ({}),
        buildAuditBase: () => ({}),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:suggestions-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automationBuilder[\\/]suggestions\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./suggestions');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function post(url, body) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1', organizationId: 'orgA' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: POST ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { events.length = 0; saved.length = 0; prompts = []; betaOn = true; });

test('one app sent as text is refused, instead of scanning EVERY connected app', async () => {
    for (const integrationIds of ['gmail', [' '], [42]]) {
        const res = await post('/suggest', { integrationIds });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(integrationIds));
        assert.ok(res.body.details.some((d) => d.path.startsWith('body.integrationIds')));
    }
    assert.deepStrictEqual(events, [], 'the stream never opened');
    assert.deepStrictEqual(prompts, []);
});

test('a misspelled key is refused rather than read as "no selection"', async () => {
    const res = await post('/suggest', { integrationIDs: ['gmail'] });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(prompts, []);
});

test('a picked app narrows the scan; [] still means all of them', async () => {
    await post('/suggest', { integrationIds: ['Gmail'] });
    assert.deepStrictEqual(prompts[0].selectedIntegrations, ['gmail']);
    await post('/suggest', { integrationIds: [] });
    assert.deepStrictEqual(prompts[1].selectedIntegrations.sort(), ['drive', 'gmail']);
});

test('a focus past 280 characters reaches the model whole', async () => {
    const focus = `${'Rules that run on a finished meeting note. '.repeat(6)}Wanted: file the notes in the Sales KB`;
    assert.ok(focus.length > 280);
    const res = await post('/suggest', { integrationIds: [], focus, force: 'true' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(prompts[0].focus.endsWith('Wanted: file the notes in the Sales KB'));
});

test('a focus past the cap is a 400 that says the cap', async () => {
    const res = await post('/suggest', { focus: 'x'.repeat(2001) });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /at most 2000 characters/);
});

test('the beta gate answers before the schema: a 403 stays a 403', async () => {
    betaOn = false;
    const res = await post('/suggest', { integrationIds: 'gmail' });
    assert.strictEqual(res.statusCode, 403);
});

test('feedback on the scan\'s own suggestion object is accepted, and stores five named fields', async () => {
    const suggestion = {
        id: 'sug_1', title: 'Weekly digest', buildPrompt: 'Build a digest', complexity: 'quick',
        requiredIntegrations: ['gmail'], groundedIn: 'activity',
        description: 'x', triggerKind: 'schedule', evidence: { hits: 3 }, value: { score: 2 },
    };
    const res = await post('/feedback', { action: 'built', suggestion });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(Object.keys(saved[0].suggestion).sort(), ['buildPrompt', 'complexity', 'groundedIn', 'requiredIntegrations', 'title']);
});

test('feedback with no suggestion, an unknown action or a reason that is not text is refused', async () => {
    const cases = [
        [{ action: 'built' }, /suggestion.title is required/],
        [{ action: 'liked', suggestion: { title: 'T' } }, /dismissed, built or asked/],
        [{ action: 'dismissed', suggestion: { title: 'T' }, reason: 42 }, /reason must be text/],
        [{ action: 'dismissed', suggestion: { title: 'T' }, reasn: 'typo' }, /Unrecognized key/],
    ];
    for (const [body, message] of cases) {
        const res = await post('/feedback', body);
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
        assert.match(res.body.error, message);
    }
    assert.deepStrictEqual(saved, []);
});
