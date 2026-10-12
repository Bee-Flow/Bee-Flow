/**
 * What the "Find repeating work" routes accept, and what they say when they
 * refuse (routes/ai/automationBuilder/suggestions.js).
 *
 * `integrationIds` that was not a list became "no selection", and no
 * selection scans EVERY connected app — one app picked, all of them read into
 * a model. What this pins:
 *
 *   - anything but a list of app ids is a 400, before the stream opens;
 *   - `[]` still means "all apps" in ideas mode (the meeting-notes panel sends
 *     it on purpose);
 *   - a focus is no longer cut at 280 characters;
 *   - `mode` and `sources` are checked as well;
 *   - the feedback body is checked, the scan's own suggestion object — with
 *     keys this route never reads — is still accepted, and what is stored is
 *     an allow-list that never includes the build prompt.
 *
 * Collaborators are injected through createSuggestionsRouter; the ideas scan
 * itself is the real one with its model stubbed.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/suggestions.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { createSuggestionsRouter } = require('./suggestions');
const { runIdeasScan } = require('../../../automation/patterns/ideation');
const { mountSuggestions, framesOf, pass } = require('../../../testUtils/suggestionsRouteHarness');
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

const saved = [];      // feedback rows written
const calls = [];      // model calls: [modelId, messages]
let betaOn = true;

const resolveIntegration = (name) => ({ integration: name.split('_')[0] });
const llmClient = {
    chatForcedTool: async (modelId, messages) => { calls.push([modelId, messages]); return { structured: { suggestions: [] }, content: '' }; },
};

const router = createSuggestionsRouter({
    requireAuth: pass, suggestRateLimit: pass, feedbackRateLimit: pass,
    userHasBetaFeature: async () => betaOn,
    // Only write tools are available, so an ideas scan is one ideation call.
    getIntegrationTools: async () => ({ tools: [{ function: { name: 'gmail_send' } }, { function: { name: 'drive_upload' } }] }),
    resolveIntegration,
    isEUModeActive: async () => ({ isEU: false }),
    resolveModelForTierName: async () => 'fast-model',
    llmClient,
    safety: {
        resolveAutomationPolicy: async () => ({ shield: null }),
        buildAuditBase: (_ctx, _step, opts) => ({ source: opts.source }),
        guardAiInput: async () => ({ blocked: false }),
    },
    scanCache: {
        deriveScopeKey: ({ userId }) => `user:${userId}`,
        getCachedScan: async () => null,
        upsertScan: async () => {},
        removeSuggestionsFromScope: async () => 0,
    },
    feedbackStore: { saveSuggestionFeedback: async (row) => { saved.push(row); } },
    makeScanReader: () => ({ read: async () => ({ ok: true, value: {} }), gate: { forModel: async (c) => c } }),
    runIdeasScan: (input) => runIdeasScan(input, {
        llmClient,
        isSideEffect: () => true,
        resolveIntegration,
        getIntegrationByTool: async () => [],
        getAutomations: async () => [],
        getRecentSuppressedTitles: async () => [],
        guardAiInput: async () => ({ blocked: false }),
    }),
    suppressIdeas: async (s) => s,
    logUsage: async () => {},
});

const srv = mountSuggestions(test, router, { errorHandler: terminalErrorHandler });
const systemPrompt = (i) => calls[i][1][0].content;

test.beforeEach(() => { saved.length = 0; calls.length = 0; betaOn = true; });

test('one app sent as text is refused, instead of scanning EVERY connected app', async () => {
    for (const integrationIds of ['gmail', [' '], [42]]) {
        const res = await srv.post('/suggest', { mode: 'ideas', integrationIds });
        assert.strictEqual(res.status, 400, JSON.stringify(integrationIds));
        assert.ok(res.body.details.some((d) => d.path.startsWith('body.integrationIds')));
        assert.deepStrictEqual(res.frames, [], 'the stream never opened');
    }
    assert.deepStrictEqual(calls, []);
});

test('a misspelled key is refused rather than read as "no selection"', async () => {
    const res = await srv.post('/suggest', { integrationIDs: ['gmail'] });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(calls, []);
});

test('an unknown mode, or sources that are not a list, is a 400 that says so', async () => {
    let res = await srv.post('/suggest', { mode: 'magic' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /mode is patterns or ideas/);
    res = await srv.post('/suggest', { sources: 'mail' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /sources is a list of source ids/);
});

test('ideas mode: a picked app narrows the scan; [] still means all of them', async () => {
    await srv.post('/suggest', { mode: 'ideas', integrationIds: ['Gmail'] });
    assert.match(systemPrompt(0), /tools for these integrations: gmail\./);
    await srv.post('/suggest', { mode: 'ideas', integrationIds: [], force: true });
    assert.match(systemPrompt(1), /tools for these integrations: (gmail, drive|drive, gmail)\./);
});

test('ideas mode: a focus past 280 characters reaches the model whole', async () => {
    const focus = `${'Rules that run on a finished meeting note. '.repeat(6)}Wanted: file the notes in the Sales KB`;
    assert.ok(focus.length > 280);
    const res = await srv.post('/suggest', { mode: 'ideas', integrationIds: [], focus, force: 'true' });
    assert.strictEqual(res.status, 200);
    assert.ok(systemPrompt(0).includes('Wanted: file the notes in the Sales KB'));
    assert.strictEqual(framesOf(res.frames, 'done')[0].mode, 'ideas');
});

test('a focus past the cap is a 400 that says the cap', async () => {
    const res = await srv.post('/suggest', { focus: 'x'.repeat(2001) });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /at most 2000 characters/);
});

test('the beta gate answers before the schema: a 403 stays a 403', async () => {
    betaOn = false;
    const res = await srv.post('/suggest', { integrationIds: 'gmail' });
    assert.strictEqual(res.status, 403);
});

test('feedback on the scan\'s own suggestion object is accepted, and stores an allow-list without the build prompt', async () => {
    const suggestion = {
        id: 'pat_1', title: 'Weekly digest', buildPrompt: 'Mail someone@example.test every Monday', complexity: 'quick',
        requiredIntegrations: ['gmail'], groundedIn: 'activity',
        description: 'x', triggerKind: 'schedule', evidence: { hits: 3 }, value: { score: 2 },
        pattern: { kind: 'mail_template', signature: 'abcdef0123456789', apps: ['gmail'], template: 'Digest <date>', draft: { x: 1 } },
    };
    const res = await srv.post('/feedback', { action: 'dismissed', signature: 'abcdef0123456789', reasonCode: 'do_myself', suggestion });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(saved[0].suggestion).sort(), ['apps', 'kind', 'signature', 'template', 'title']);
    assert.ok(!JSON.stringify(saved[0].suggestion).includes('example.test'));
    assert.strictEqual(saved[0].signature, 'abcdef0123456789');
    assert.strictEqual(saved[0].reasonCode, 'do_myself');
    assert.strictEqual(saved[0].userId, 'u1');
});

test('feedback with no suggestion, an unknown action, a bad reason code or signature, or a reason that is not text is refused', async () => {
    const cases = [
        [{ action: 'built' }, /suggestion.title is required/],
        [{ action: 'liked', suggestion: { title: 'T' } }, /dismissed, built, asked, snoozed or opened/],
        [{ action: 'dismissed', suggestion: { title: 'T' }, reasonCode: 'boring' }, /reasonCode is wrong_grouping/],
        [{ action: 'snoozed', suggestion: { title: 'T' }, signature: 'x y' }, /pattern signature the scan returned/],
        [{ action: 'dismissed', suggestion: { title: 'T' }, reason: 42 }, /reason must be text/],
        [{ action: 'dismissed', suggestion: { title: 'T' }, reasn: 'typo' }, /Unrecognized key/],
    ];
    for (const [body, message] of cases) {
        const res = await srv.post('/feedback', body);
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.match(res.body.error, message);
    }
    assert.deepStrictEqual(saved, []);
});

test('a reason code goes with a dismiss only: anything else is a 400 with its own code', async () => {
    const res = await srv.post('/feedback', { action: 'snoozed', reasonCode: 'privacy', signature: 'abcdef0123456789', suggestion: { title: 'T' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'reason_code_needs_dismiss');
    assert.deepStrictEqual(saved, []);
});
