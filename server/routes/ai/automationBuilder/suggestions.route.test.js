/**
 * "Find repeating work" end to end through the route: a patterns scan over a
 * synthetic Gmail inbox and chat ledger, with the real sources, miner, naming
 * and stores (pglite), and only the model, the tool dispatcher and the egress
 * ledger stubbed. Collaborators are injected through createSuggestionsRouter;
 * nothing is mocked through the module system.
 *
 * What it pins:
 *   - the SSE frames and their order, and the suggestion's shape (the old
 *     fields filled, plus `pattern`);
 *   - privacy: the model's input has no address, link, name or domain from
 *     the mail it was built from, and only the evidence-card keys; the model's
 *     invented numbers and addresses do not reach the suggestion;
 *   - scope: the cache and /suggest/last are per user, in one organisation;
 *   - suppression after the cache read: a snoozed pattern stays away;
 *   - ideas mode still answers in its own shape; /suggest/sources;
 *   - the scan's reads and model usage are filed under `pattern_scan`, and the
 *     policy keeps the shield on (honourAutomationOptOut false).
 *
 * Synthetic data throughout.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/suggestions.route.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { mountSuggestions, framesOf, pass } = require('../../../testUtils/suggestionsRouteHarness');
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');
const { NOW, at, daysOn } = require('../../../automation/patterns/__fixtures__/builders');
const { createSuggestionsRouter } = require('./suggestions');
const { runPatternScan, suppressSuggestions } = require('../../../automation/patterns/pipeline');
const { runIdeasScan, suppressIdeas } = require('../../../automation/patterns/ideation');
const { makeScanReader } = require('../../../automation/patterns/scanReader');
const { CARD_KEYS } = require('../../../automation/patterns/evidenceCard');
const scanCacheModule = require('../../../stores/suggestionScanCache');
const feedbackModule = require('../../../stores/suggestionFeedbackStore');

const MONDAY = 1;
const NAME_RE = /Pieter|Bakker|Sanne|Jansen/;
const { pg, db } = pgliteDb();
const scanCache = { ...scanCacheModule.makeSuggestionScanCache(db), deriveScopeKey: scanCacheModule.deriveScopeKey };
const feedbackStore = feedbackModule.makeSuggestionFeedbackStore(db);

// ── The user's synthetic work: a supplier invoice every Monday, filed in a sheet ──

const mondays = daysOn([MONDAY]).filter((d) => d > 0);
const inbox = [
    ...mondays.map((d, i) => ({
        subject: `Factuur INV-2026-${4001 + i} van Pieter Bakker (acme-supplies.nl)`,
        date: new Date(at(d, 8, 5)).toISOString(),
        from: 'Pieter Bakker <pieter.bakker@acme-supplies.nl>',
    })),
    // One-off mail: never a pattern.
    ...[3, 10, 17, 24].map((d, i) => ({
        subject: `Lunch with Sanne Jansen about ${['tiles', 'boats', 'kites', 'maps'][i]}`,
        date: new Date(at(d, 12)).toISOString(),
        from: 'Sanne Jansen <sanne@jansen-family.example>',
    })),
];
const ledger = mondays.flatMap((d) => [
    { tool_name: 'gmail_read_attachment', integration_type: 'gmail', timestamp: new Date(at(d, 9, 0)), conversation_id: `c-${d}` },
    { tool_name: 'sheets_append_rows', integration_type: 'google_sheets', timestamp: new Date(at(d, 9, 4)), conversation_id: `c-${d}` },
]);

// ── Stubs: the model, the dispatcher, the ledger writes ──

const fx = { naming: [], ideas: [], egress: [], usage: [], policy: [], reads: [], namingAnswer: null };

const llmClient = {
    async chatForcedTool(modelId, messages, tool, opts) {
        fx.naming.push({ modelId, messages: structuredClone(messages), tool, opts });
        return { structured: fx.namingAnswer, content: '', usage: { prompt_tokens: 120, completion_tokens: 40 } };
    },
    async runToolLoop(modelId, messages, tools, opts) {
        fx.ideas.push({ modelId, messages, tools, opts });
        return {
            toolCallRounds: 0, content: '', usage: { prompt_tokens: 300, completion_tokens: 90 },
            structured: { suggestions: [{ title: 'Summarise supplier mail weekly', buildPrompt: 'Every Monday, summarise new supplier mail.', requiredIntegrations: ['gmail'], groundedIn: 'activity' }] },
        };
    },
};

const executeTool = async (name, args) => {
    fx.reads.push({ name, args });
    if (name !== 'gmail_search') throw new Error(`unexpected read ${name}`);
    return { results: args.query.startsWith('in:sent') ? [] : inbox };
};

const pipelineDeps = {
    detectPii: null, // no guard installed: the fallback mask must still hide names
    getAutomatedToolNames: async () => [],
    getAutomations: async () => [],
    getSuppressedSignatures: (p) => feedbackStore.getSuppressedSignatures(p),
    appOfTool: (t) => t.split('_')[0],
};

const router = createSuggestionsRouter({
    requireAuth: pass, suggestRateLimit: pass, feedbackRateLimit: pass,
    userHasBetaFeature: async () => true,
    getIntegrationTools: async () => ({ tools: ['gmail_search', 'gmail_read_attachment', 'sheets_append_rows'].map((name) => ({ type: 'function', function: { name } })) }),
    resolveIntegration: (name) => ({ integration: name.startsWith('sheets_') ? 'google_sheets' : name.split('_')[0] }),
    isEUModeActive: async () => ({ isEU: true }),
    resolveModelForTierName: async () => 'fast-model',
    llmClient,
    safety: {
        resolveAutomationPolicy: async (_ctx, opts) => { fx.policy.push(opts); return { shield: null, piiEnabled: false, regexRules: [] }; },
        buildAuditBase: (ctx, _step, opts) => ({ source: opts.source, user_id: ctx.userId, agent_name: ctx.automationTitle }),
        guardAiInput: async () => ({ blocked: false, categories: [] }),
    },
    scanCache,
    feedbackStore,
    logUsage: async (row) => { fx.usage.push(row); },
    makeScanReader: (ctx) => makeScanReader(ctx, {
        executeTool,
        captureCall: async (fn) => { try { return { ok: true, value: await fn(), probe: null }; } catch (e) { return { ok: false, error: e }; } },
        logEgress: async (row) => { fx.egress.push(row); },
        toolLoopGate: () => ({ refuse: async () => null, forModel: async (c) => c }),
        logGuardrailEvent: async () => {},
    }),
    runPatternScan: (input) => runPatternScan({
        ...input, now: NOW,
        sourceDeps: { getManualToolEvents: async ({ userId }) => (userId === 'u1' ? ledger : []) },
        collectors: { documents: async () => [] },
    }, pipelineDeps),
    suppressSuggestions: (list, p) => suppressSuggestions(list, { ...p, now: NOW }, pipelineDeps),
    runIdeasScan: (input) => runIdeasScan(input, {
        llmClient,
        getIntegrationByTool: async () => [],
        getAutomations: async () => [],
        getRecentSuppressedTitles: (p) => feedbackStore.getRecentSuppressedTitles(p),
        guardToolOutput: async (out) => ({ result: out, categories: [] }),
        guardAiInput: async () => ({ blocked: false }),
    }),
    suppressIdeas: (list, p) => suppressIdeas(list, p, { getAutomations: async () => [], getRecentSuppressedTitles: (q) => feedbackStore.getRecentSuppressedTitles(q) }),
    now: () => NOW,
});

const srv = mountSuggestions(test, router, { errorHandler: terminalErrorHandler });
test.before(async () => {
    await pg.exec(scanCacheModule.DDL);
    await pg.exec(feedbackModule.DDL);
});
test.after(() => pg.close());

const events = (frames) => frames.map((f) => f.event).filter((e) => e !== 'ping');
let first = null; // the first scan's frames

test('a patterns scan streams its steps in order and ends with named, measured patterns', async () => {
    fx.namingAnswer = {
        patterns: [{
            ref: 'A',
            title: 'File supplier invoices in a sheet',
            why: 'Each supplier invoice gets copied into the sheet by hand. It saves you 45 minutes.',
            buildPrompt: 'When an invoice email arrives in Gmail, read the attachment.\nAppend a row to Google Sheets.\nAsk pieter.bakker@acme-supplies.nl when in doubt.',
        }],
    };
    const res = await srv.post('/suggest', { sources: ['mail', 'beeflow'] });
    assert.strictEqual(res.status, 200);
    first = res.frames;
    // Runs of one event collapsed: model, collecting, every source, templating
    // + mining, stats, naming, the patterns, done.
    const seq = events(res.frames);
    assert.deepStrictEqual(seq.filter((e, i) => e !== seq[i - 1]),
        ['model', 'phase', 'source_step', 'phase', 'stats', 'phase', 'suggestion', 'done']);
    assert.deepStrictEqual(framesOf(res.frames, 'phase').map((p) => p.phase), ['collecting', 'templating', 'mining', 'naming']);
    assert.deepStrictEqual(framesOf(res.frames, 'model')[0], { eu: true });

    const steps = framesOf(res.frames, 'source_step');
    assert.deepStrictEqual(
        steps.filter((s) => s.status !== 'start').map((s) => `${s.source}/${s.app}:${s.status}`).sort(),
        ['beeflow/chat:done', 'beeflow/documents:done', 'mail/gmail:done'],
    );
    assert.ok(framesOf(res.frames, 'stats')[0].events > 20);

    const done = framesOf(res.frames, 'done')[0];
    assert.strictEqual(done.cached, false);
    assert.strictEqual(done.mode, 'patterns');
    assert.deepStrictEqual(done.sources, ['mail', 'beeflow']);
    assert.strictEqual(done.suggestions.length, 1);
    assert.deepStrictEqual(done.summary.sources.sort(), ['chat', 'documents', 'gmail']);

    const s = done.suggestions[0];
    assert.deepStrictEqual(framesOf(res.frames, 'suggestion')[0].suggestion, s);
    assert.strictEqual(s.title, 'File supplier invoices in a sheet');
    assert.strictEqual(s.description, 'Each supplier invoice gets copied into the sheet by hand.', 'the invented "45 minutes" is gone');
    assert.ok(!s.buildPrompt.includes('@') && s.buildPrompt.includes('Append a row'), 'the sentence with an address is dropped');
    assert.strictEqual(s.groundedIn, 'activity');
    assert.strictEqual(s.triggerKind, 'app_event');
    assert.ok(s.requiredIntegrations.includes('gmail') && s.requiredIntegrations.includes('google-sheets'));
    assert.deepStrictEqual(s.unavailableIntegrations, []);
    assert.ok(['quick', 'assisted', 'orchestrated', 'advanced'].includes(s.complexity));
    assert.ok(s.value.score >= 1 && s.value.score <= 100);
    assert.strictEqual(s.value.frequencyLabel, 'weekly');

    const p = s.pattern;
    assert.strictEqual(p.kind, 'mail_template');
    assert.match(p.signature, /^[0-9a-f]{32}$/);
    assert.strictEqual(s.id, `pat_${p.signature.slice(0, 12)}`);
    assert.strictEqual(p.cadence.kind, 'weekly');
    assert.strictEqual(p.cadence.weekday, MONDAY);
    assert.strictEqual(p.occurrences, mondays.length);
    assert.strictEqual(p.windowDays, 90);
    assert.strictEqual(p.weekdayHistogram.length, 7);
    assert.ok(p.minutesPerMonth[0] <= p.minutesPerMonth[1]);
    assert.strictEqual(p.draft.trigger.kind, 'app');
    assert.match(p.template, /^factuur <id> van <name> <domain:A>$/i, 'the name masked, the domain lettered');
    assert.ok(!NAME_RE.test(JSON.stringify(s)) && !/acme|@/.test(JSON.stringify(s)), 'no name, domain or address on the suggestion');
});

test('the model sees evidence cards only: no address, link, name or domain from the mail', () => {
    assert.strictEqual(fx.naming.length, 1);
    const { messages, opts, tool } = fx.naming[0];
    const sent = JSON.stringify(messages);
    assert.ok(!sent.includes('@'), 'no address');
    assert.ok(!/https?:|www\./.test(sent), 'no link');
    assert.ok(!NAME_RE.test(sent), 'no person names');
    assert.ok(!/acme|jansen-family|INV-2026/.test(sent), 'no domain or document number');
    const cards = JSON.parse(messages[1].content).patterns;
    for (const card of cards) {
        for (const key of Object.keys(card)) assert.ok(key === 'ref' || CARD_KEYS.includes(key), `unexpected key ${key}`);
    }
    assert.strictEqual(tool.function.name, 'name_patterns');
    assert.strictEqual(opts.maxTokens, 4096);
    assert.strictEqual(opts.temperature, 0.2);
    assert.strictEqual(opts.reasoningEffort, 'none');
    assert.ok(opts.signal instanceof AbortSignal, 'the client\'s disconnect reaches the model call');
});

test('the scan keeps the shield on, and files its reads and its model usage under pattern_scan', () => {
    assert.deepStrictEqual(fx.policy, [{ honourAutomationOptOut: false }]);
    assert.ok(fx.reads.length === 2 && fx.reads.every((r) => r.name === 'gmail_search'), 'the server chose the reads');
    assert.ok(fx.egress.length === 2 && fx.egress.every((r) => r.auditBase.source === 'pattern_scan'));
    assert.strictEqual(fx.usage.length, 1);
    assert.strictEqual(fx.usage[0].source, 'pattern_scan');
    assert.strictEqual(fx.usage[0].user_id, 'u1');
    assert.strictEqual(fx.usage[0].model, 'fast-model');
});

test('the same inputs again are a cache hit for that user, and never for a colleague', async () => {
    const again = await srv.post('/suggest', { sources: ['beeflow', 'mail'] });
    const done = framesOf(again.frames, 'done')[0];
    assert.strictEqual(done.cached, true);
    assert.deepStrictEqual(done.suggestions, framesOf(first, 'done')[0].suggestions);
    assert.strictEqual(fx.naming.length, 1, 'no second model call');

    const colleague = await srv.post('/suggest', { sources: ['mail', 'beeflow'] }, { user: 'u2' });
    const theirs = framesOf(colleague.frames, 'done')[0];
    assert.strictEqual(theirs.cached, false);
    // The same inbox, but this colleague never acted on it: mail that only
    // arrives is not work.
    assert.deepStrictEqual(theirs.suggestions, []);
    assert.strictEqual(theirs.reason, 'no_patterns');
});

test('/suggest/last is the viewer\'s own scan: a colleague in the same organisation gets nothing', async () => {
    const mine = await srv.get('/suggest/last');
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.mode, 'patterns');
    assert.strictEqual(mine.body.suggestions.length, 1);
    assert.deepStrictEqual(mine.body.sources, ['mail', 'beeflow'], 'what the scan was asked to read');

    const u3 = await srv.get('/suggest/last', { user: 'u3' });
    assert.strictEqual(u3.status, 204);
});

test('a snoozed pattern leaves the cached scan and stays out of the next cache hit', async () => {
    const s = framesOf(first, 'done')[0].suggestions[0];
    const fb = await srv.post('/feedback', { action: 'snoozed', signature: s.pattern.signature, suggestion: { id: s.id, title: s.title, pattern: s.pattern } });
    assert.strictEqual(fb.status, 200);

    const last = await srv.get('/suggest/last');
    assert.deepStrictEqual(last.body.suggestions, []);
    const hit = await srv.post('/suggest', { sources: ['mail', 'beeflow'] });
    const done = framesOf(hit.frames, 'done')[0];
    assert.strictEqual(done.cached, true);
    assert.deepStrictEqual(done.suggestions, []);

    // A forced re-scan finds the work again and the suppression still holds.
    const forced = await srv.post('/suggest', { sources: ['mail', 'beeflow'], force: true });
    const fresh = framesOf(forced.frames, 'done')[0];
    assert.strictEqual(fresh.cached, false);
    assert.deepStrictEqual(fresh.suggestions, []);
    assert.strictEqual(fresh.reason, 'no_patterns');
});

test('ideas mode still answers in its own shape, and keeps its own last scan', async () => {
    const res = await srv.post('/suggest', { mode: 'ideas', integrationIds: [], focus: 'supplier mail' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(framesOf(res.frames, 'phase').map((p) => p.phase), ['scanning', 'synthesising']);
    const done = framesOf(res.frames, 'done')[0];
    assert.strictEqual(done.mode, 'ideas');
    assert.strictEqual(done.suggestions[0].title, 'Summarise supplier mail weekly');
    assert.ok(done.suggestions[0].evidence && done.suggestions[0].value, 'server-derived evidence and value');
    assert.strictEqual(fx.ideas.length, 1);
    assert.ok(fx.ideas[0].opts.signal instanceof AbortSignal);
    assert.strictEqual(fx.usage.at(-1).source, 'pattern_scan');

    const ideasLast = await srv.get('/suggest/last?mode=ideas');
    assert.strictEqual(ideasLast.body.mode, 'ideas');
    assert.strictEqual(ideasLast.body.suggestions.length, 1);
    const patternsLast = await srv.get('/suggest/last');
    assert.strictEqual(patternsLast.body.mode, 'patterns', 'an ideas scan does not replace the patterns result');
});

test('GET /suggest/sources lists the groups, with what the user has connected', async () => {
    const res = await srv.get('/suggest/sources');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.windowDays, 90);
    const byId = Object.fromEntries(res.body.groups.map((g) => [g.id, g]));
    assert.deepStrictEqual(Object.keys(byId).sort(), ['beeflow', 'calendar', 'files', 'mail']);
    assert.strictEqual(byId.mail.kind, 'live');
    assert.strictEqual(byId.mail.connected, true);
    assert.deepStrictEqual(byId.mail.apps.filter((a) => a.connected).map((a) => a.id), ['gmail']);
    assert.strictEqual(byId.files.connected, false);
    assert.strictEqual(byId.beeflow.connected, true);
});

// ── The viewer's time zone: forwarded to the miner, part of the cache key ──

const tzSeen = { inputs: [], keys: [] };
const tzSrv = mountSuggestions(test, createSuggestionsRouter({
    requireAuth: pass, suggestRateLimit: pass, feedbackRateLimit: pass,
    userHasBetaFeature: async () => true,
    getIntegrationTools: async () => ({ tools: [] }),
    resolveIntegration: () => null,
    isEUModeActive: async () => ({ isEU: false }),
    resolveModelForTierName: async () => 'fast-model',
    llmClient,
    safety: { resolveAutomationPolicy: async () => ({ shield: null }), buildAuditBase: () => ({}), guardAiInput: async () => ({ blocked: false }) },
    scanCache: {
        deriveScopeKey: scanCacheModule.deriveScopeKey,
        getCachedScan: async ({ cacheKey }) => { tzSeen.keys.push(cacheKey); return null; },
        upsertScan: async () => null,
    },
    feedbackStore,
    logUsage: async () => {},
    makeScanReader: () => ({ read: async () => ({ ok: false }) }),
    runPatternScan: async function* (input) {
        tzSeen.inputs.push(input);
        yield { event: 'result', data: { suggestions: [], summary: null, reason: 'no_patterns', usage: null } };
    },
    now: () => NOW,
}), { errorHandler: terminalErrorHandler });

test('the viewer\'s time zone reaches the miner and the cache key; an unknown zone means UTC, never a 400', async () => {
    for (const timezone of ['Europe/Amsterdam', 'Mars/Olympus_Mons', undefined]) {
        const res = await tzSrv.post('/suggest', { sources: ['mail'], ...(timezone ? { timezone } : {}) });
        assert.strictEqual(res.status, 200, String(timezone));
        assert.strictEqual(framesOf(res.frames, 'done')[0].reason, 'no_patterns');
    }
    assert.deepStrictEqual(tzSeen.inputs.map((i) => i.timeZone), ['Europe/Amsterdam', null, null]);
    assert.notStrictEqual(tzSeen.keys[0], tzSeen.keys[2], 'a scan in another zone is another result');
    assert.strictEqual(tzSeen.keys[1], tzSeen.keys[2], 'an unknown zone is the same as none');

    const bad = await tzSrv.post('/suggest', { timezone: 42 });
    assert.strictEqual(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /IANA zone/);
});
