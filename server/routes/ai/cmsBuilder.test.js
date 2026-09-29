/**
 * Route tests for the CMS AI builder (routes/ai/cmsBuilder.js).
 *
 * The adapter/LLM plumbing (providers, aiAgent, modelResolver, userTiers,
 * promptClassifier, limits, auth) is mocked via the Module._resolveFilename
 * harness (same pattern as routes/ai/appStudioBuilder.test.js); the CMS
 * layer (stores/cmsStore + cmsBuilder/*) runs REAL on an in-memory config
 * table (./configStore + ../db mocked). Requests go over real HTTP against
 * express app.listen(0) and the SSE body is parsed from the response text.
 *
 * Run: node --test routes/ai/cmsBuilder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ── Shared mutable state the mocks read ─────────────────────────────

const state = {
    limitError: null,          // string → checkSubscriptionLimits blocks with 402
    script: [],                // queue of (messages, options, onEvent) turn functions
    adapterCalls: [],          // captured messages per adapter.stream call
    classifyCalls: 0,          // how many times the tier classifier ran
    permittedTiers: ['auto', 'fast', 'standard'],
    tiers: { fast: { modelId: 'test-model-large' }, standard: { modelId: 'test-model-large' } },
};

// ── In-memory config table + db LIKE queries (real cmsStore on top) ──

const configState = { map: new Map() };

const mockConfigStore = {
    async getConfig(key) { return clone(configState.map.get(key)); },
    async getConfigFresh(key) { return clone(configState.map.get(key)); },
    async setConfig(key, value) { configState.map.set(key, clone(value)); },
    async deleteConfig(key) { configState.map.delete(key); },
    async mutateConfig(key, fn) {
        const cur = configState.map.has(key) ? clone(configState.map.get(key)) : undefined;
        const next = fn(cur);
        configState.map.set(key, clone(next));
        return next;
    },
};

function likeToRegex(pattern) {
    const esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${esc.replace(/%/g, '.*').replace(/_/g, '.')}$`);
}

const mockDb = {
    async getAll(sql, params) {
        const keys = [...configState.map.keys()];
        if (/key = \$1 OR key LIKE \$2/.test(sql)) {
            const re = likeToRegex(params[1]);
            return keys.filter((k) => k === params[0] || re.test(k)).map((k) => ({ key: k }));
        }
        const re = likeToRegex(params[0]);
        return keys.filter((k) => re.test(k)).map((k) => ({ key: k }));
    },
};

// ── Mock usageStore — captures the per-turn logUsage rows ───────────

const usageEvents = [];
const mockUsageStore = {
    async logUsage(entry) { usageEvents.push(clone(entry)); return { id: usageEvents.length }; },
};

// ── Mock LLM plumbing ───────────────────────────────────────────────

const mockAdapter = {
    async stream(apiKey, url, modelId, messages, options, onEvent) {
        state.adapterCalls.push({ modelId, messages: clone(messages), options: { toolChoice: options.toolChoice, reasoningEffort: options.reasoningEffort } });
        const turn = state.script.shift();
        if (!turn) { onEvent('text', { text: 'Nothing scripted.' }); return; }
        await turn(messages, options, onEvent);
    },
};

const MOCKS = {
    // cmsStore's Postgres edges — the store itself runs REAL. Its aggregates
    // live in stores/cms/, one level deeper, hence both spellings of each.
    './configStore': mockConfigStore,
    '../db': mockDb,
    '../configStore': mockConfigStore,
    '../../db': mockDb,
    // stores
    '../../stores/usageStore': mockUsageStore,
    // route plumbing
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => state.limitError },
    '../../auth': { resolveUserOrgIds: async () => new Set(['orgA']) },
    '../auth/permissions': { hasPermission: async () => false },
    '../../core/llm/modelResolver': {
        getUserTierMap: async () => clone(state.tiers),
    },
    '../../core/entitlements/userTiers': {
        getPermittedTierKeys: async () => new Set(state.permittedTiers),
    },
    '../../core/llm/promptClassifier': {
        classifyWithLLM: async () => { state.classifyCalls += 1; return { tier: 'fast', method: 'mock', reason: 'test' }; },
    },
    '../../core/aiAgent': {
        getProviderForModel: async () => ({ providerType: 'mock', url: '', apiKey: 'k' }),
        getAIConfig: async () => ({ model: 'test-model-large' }),
    },
    '../../core/providers': { getAdapter: () => mockAdapter },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./cmsBuilder');
const cmsStore = require('../../stores/cmsStore');
const {
    VALIDATION_NOTE_PREFIX,
    DRAFT_STATE_PREFIX,
    EDITOR_CONTEXT_PREFIX,
    BLOCK_FEEDBACK_PREFIX,
    sanitizeEditorContext,
    sanitizeHistory,
} = require('./cmsBuilder')._test;

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) {
            req.session = {
                isAuthenticated: true,
                isAdmin: req.headers['x-test-admin'] === '1',
                user: { id: uid, organizationId: 'orgA' },
            };
        }
        next();
    });
    app.use('/api/cms/builder', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/cms/builder`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function api(method, path, { user, admin = true, body } = {}) {
    const headers = {};
    if (user) {
        headers['x-test-user'] = user;
        if (admin) headers['x-test-admin'] = '1';
    }
    let payload;
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* SSE body */ }
    return { status: res.status, contentType: res.headers.get('content-type') || '', body: json, text };
}

/** Parse an SSE body into [{ event, data }] (heartbeat pings filtered out). */
function parseSSE(text) {
    const events = [];
    for (const block of text.split('\n\n')) {
        const evMatch = block.match(/^event: (.+)$/m);
        const dataMatch = block.match(/^data: (.+)$/m);
        if (!evMatch || !dataMatch) continue;
        if (evMatch[1] === 'ping') continue;
        let data = null;
        try { data = JSON.parse(dataMatch[1]); } catch (_) { data = dataMatch[1]; }
        events.push({ event: evMatch[1], data });
    }
    return events;
}

function eventsOf(events, name) { return events.filter((e) => e.event === name); }

/** Tool result JSON for a tool name from the adapter's message list (last wins). */
function toolResultFor(messages, toolName) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
            if (tc.function?.name !== toolName) continue;
            const result = messages.slice(i + 1).find((x) => x.role === 'tool' && x.tool_call_id === tc.id);
            if (result) { try { return JSON.parse(result.content); } catch (_) { return null; } }
        }
    }
    return null;
}

async function makeSite(name = 'Route site') {
    const created = await cmsStore.createProject({ name });
    const site = await cmsStore.getProject(created.id);
    return { siteId: created.id, homePageId: site.pages[0].id };
}

// ── Tests ───────────────────────────────────────────────────────────

test('auth: 401 without a session, 403 for authenticated non-admins', async () => {
    const stream = await api('POST', '/stream', { body: { message: 'hi', siteId: 'pj_abcd1234' } });
    assert.strictEqual(stream.status, 401);
    const session = await api('GET', '/session/pj_abcd1234', {});
    assert.strictEqual(session.status, 401);

    const nonAdminStream = await api('POST', '/stream', { user: 'pleb-1', admin: false, body: { message: 'hi', siteId: 'pj_abcd1234' } });
    assert.strictEqual(nonAdminStream.status, 403);
    const nonAdminSession = await api('GET', '/session/pj_abcd1234', { user: 'pleb-1', admin: false });
    assert.strictEqual(nonAdminSession.status, 403);
});

test('GET /session/:siteId — 400 bad format, 404 unknown site, 404 no snapshot, 200 round-trip', async () => {
    const bad = await api('GET', '/session/not-a-site', { user: 'admin-s1' });
    assert.strictEqual(bad.status, 400);

    const unknown = await api('GET', '/session/pj_deadbeef', { user: 'admin-s1' });
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.body.error, 'Site not found');

    const { siteId } = await makeSite('Session site');
    const missing = await api('GET', `/session/${siteId}`, { user: 'admin-s1' });
    assert.strictEqual(missing.status, 404);
    assert.match(missing.body.error, /No builder session/);

    await cmsStore.setBuilderSession(siteId, {
        sessionId: 'cms_rt1', siteId,
        messages: [{ role: 'user', content: 'earlier turn' }],
        updatedAt: 'now', lastTier: 'fast',
    });
    const found = await api('GET', `/session/${siteId}`, { user: 'admin-s1' });
    assert.strictEqual(found.status, 200);
    assert.strictEqual(found.body.snapshot.sessionId, 'cms_rt1');
    assert.strictEqual(found.body.snapshot.messages[0].content, 'earlier turn');

    // Site-scoped, NOT owner-scoped: a different admin sees the same session.
    const other = await api('GET', `/session/${siteId}`, { user: 'admin-s2' });
    assert.strictEqual(other.status, 200);
    assert.strictEqual(other.body.snapshot.sessionId, 'cms_rt1');
});

test('POST /stream input gates: 400 no message, 400 bad siteId, 404 unknown site, 402 limit', async () => {
    const { siteId } = await makeSite('Gate site');

    const noMsg = await api('POST', '/stream', { user: 'admin-g1', body: { siteId } });
    assert.strictEqual(noMsg.status, 400);
    const noSite = await api('POST', '/stream', { user: 'admin-g1', body: { message: 'x' } });
    assert.strictEqual(noSite.status, 400);
    const badSite = await api('POST', '/stream', { user: 'admin-g1', body: { message: 'x', siteId: 'nope' } });
    assert.strictEqual(badSite.status, 400);
    const ghost = await api('POST', '/stream', { user: 'admin-g1', body: { message: 'x', siteId: 'pj_deadbeef' } });
    assert.strictEqual(ghost.status, 404);

    state.limitError = 'Chat limit reached for your plan';
    const limited = await api('POST', '/stream', { user: 'admin-g2', body: { message: 'x', siteId } });
    state.limitError = null;
    assert.strictEqual(limited.status, 402);
    assert.ok(limited.contentType.includes('application/json'), `not SSE: ${limited.contentType}`);
    assert.strictEqual(limited.body.code, 'subscription_limit');
});

test('429 after the 12/min per-user budget is spent', async () => {
    const user = 'admin-ratelimit';
    for (let i = 0; i < 12; i++) {
        const r = await api('POST', '/stream', { user, body: {} });
        assert.strictEqual(r.status, 400, `warm-up request ${i} consumed the budget cheaply`);
    }
    const blocked = await api('POST', '/stream', { user, body: {} });
    assert.strictEqual(blocked.status, 429);
    assert.match(blocked.body.error, /Too many requests/);
});

test('happy path: create page → add blocks → prose; frozen event order + done ids + snapshot', async () => {
    state.adapterCalls = [];
    state.classifyCalls = 0;
    usageEvents.length = 0;
    const { siteId } = await makeSite('Happy site');

    state.script = [
        // Turn 1 — the model creates a page.
        async (messages, options, onEvent) => {
            onEvent('thinking_start', { partId: 't0' });
            onEvent('thinking', { partId: 't0', text: 'plan the page' });
            onEvent('thinking_stop', { partId: 't0' });
            onEvent('tool_use', { id: 'c1', name: 'cms_create_page', input: { title: 'About us' } });
            onEvent('done', { prompt_tokens: 100, completion_tokens: 20 });
        },
        // Turn 2 — reads the REAL pageId from the tool result, adds blocks.
        async (messages, options, onEvent) => {
            const created = toolResultFor(messages, 'cms_create_page');
            assert.ok(created && /^pg_/.test(created.pageId), `turn 2 sees the created page: ${JSON.stringify(created)}`);
            onEvent('tool_use', {
                id: 'c2', name: 'cms_add_blocks',
                input: {
                    pageId: created.pageId,
                    blocks: [
                        { type: 'hero', content: { titleParts: [{ text: 'About Acme', gradient: false }], lead: 'Who we are.' } },
                        { type: 'features' },
                    ],
                },
            });
            onEvent('done', { prompt_tokens: 150, completion_tokens: 30 });
        },
        // Turn 3 — prose; ends the turn.
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Built the About page.' });
            onEvent('done', { prompt_tokens: 160, completion_tokens: 10 });
        },
    ];

    const res = await api('POST', '/stream', { user: 'admin-h1', body: { message: 'Build an about page', siteId, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.contentType.includes('text/event-stream'));
    const events = parseSSE(res.text);

    // builder_session first, then model_selected. Explicit tier → no classifier.
    assert.strictEqual(events[0].event, 'builder_session');
    assert.strictEqual(events[0].data.siteId, siteId);
    assert.ok(events[0].data.sessionId, 'session id present');
    assert.strictEqual(events[1].event, 'model_selected');
    assert.deepStrictEqual(events[1].data, { modelId: 'test-model-large', tier: 'fast' });
    assert.strictEqual(state.classifyCalls, 0, 'explicit valid tier skips the classifier');

    // Thinking + prose forwarded per the contract shapes.
    assert.ok(eventsOf(events, 'thinking_start').length >= 1);
    assert.deepStrictEqual(eventsOf(events, 'thinking')[0].data, { delta: 'plan the page' });
    assert.ok(eventsOf(events, 'message').some((e) => e.data.content === 'Built the About page.'));

    // Frozen order: tool_call cms_create_page → draft page + draft site →
    // tool_call cms_add_blocks → draft page.
    const seq = events
        .filter((e) => e.event === 'tool_call' || e.event === 'draft')
        .map((e) => (e.event === 'tool_call' ? `tool:${e.data.name}` : `draft:${e.data.kind}`));
    assert.deepStrictEqual(seq, [
        'tool:cms_create_page', 'draft:page', 'draft:site',
        'tool:cms_add_blocks', 'draft:page',
    ], seq.join(' | '));

    const toolCalls = eventsOf(events, 'tool_call');
    assert.deepStrictEqual(toolCalls.map((e) => e.data.label), ['Created page', 'Added blocks']);
    for (const tc of toolCalls) {
        assert.strictEqual(tc.data.ok, true, JSON.stringify(tc.data));
        assert.ok(typeof tc.data.summary === 'string' && tc.data.summary.length);
    }

    // Draft payload shapes.
    const drafts = eventsOf(events, 'draft');
    const pageDrafts = drafts.filter((d) => d.data.kind === 'page');
    assert.strictEqual(pageDrafts[0].data.siteId, siteId);
    assert.match(pageDrafts[0].data.pageId, /^pg_/);
    assert.strictEqual(pageDrafts[1].data.page.blocks.length, 2, 'second page draft carries both blocks');
    const siteDraft = drafts.find((d) => d.data.kind === 'site');
    assert.ok(siteDraft.data.site.pages.some((p) => p.slug === 'about-us'), 'site draft reflects the new index');

    // usage accumulates across rounds; validation clean.
    const usage = eventsOf(events, 'usage');
    assert.ok(usage.length >= 3);
    assert.deepStrictEqual(Object.keys(usage[0].data).sort(), ['inputTokens', 'outputTokens']);
    assert.strictEqual(usage[usage.length - 1].data.inputTokens, 410);
    const validations = eventsOf(events, 'validation_errors');
    assert.ok(validations.length >= 1);
    assert.deepStrictEqual(validations[validations.length - 1].data.errors, []);

    // done carries created + touched page ids.
    const done = eventsOf(events, 'done')[0];
    assert.strictEqual(done.data.siteId, siteId);
    assert.strictEqual(done.data.createdPageIds.length, 1);
    assert.match(done.data.createdPageIds[0], /^pg_/);
    assert.ok(done.data.touchedPageIds.includes(done.data.createdPageIds[0]));

    // ONE usage row for the turn with the cms_builder identity fields.
    assert.strictEqual(usageEvents.length, 1, JSON.stringify(usageEvents));
    const row = usageEvents[0];
    assert.strictEqual(row.agent_type, 'cms_builder');
    assert.strictEqual(row.source, 'cms_builder');
    assert.strictEqual(row.agent_id, siteId);
    assert.strictEqual(row.conversation_id, events[0].data.sessionId);
    assert.strictEqual(row.prompt_tokens, 410);
    assert.strictEqual(row.completion_tokens, 60);
    assert.strictEqual(row.stop_reason, 'completed');

    // Prompt-cache discipline: system prompt first; SITE STATE travels late.
    const first = state.adapterCalls[0].messages;
    assert.strictEqual(first[0].role, 'system');
    assert.ok(first[0].content.includes('BeeFlow website builder'), 'identity present');
    assert.ok(first[0].content.includes('### hero'), 'catalogue rendered into the static prompt');
    const draftStateIdx = first.findIndex((m) => m.role === 'user' && m.content.startsWith(DRAFT_STATE_PREFIX));
    assert.ok(draftStateIdx > 0 && draftStateIdx === first.length - 2, 'site state is the second-to-last message');

    // Snapshot persisted + served by GET /session (shared between admins).
    const snap = await api('GET', `/session/${siteId}`, { user: 'admin-h2' });
    assert.strictEqual(snap.status, 200);
    assert.strictEqual(snap.body.snapshot.lastTier, 'fast');
    assert.deepStrictEqual(
        snap.body.snapshot.messages.map((m) => m.role),
        ['user', 'assistant'],
        'snapshot keeps the prose conversation only',
    );
});

test('unknown block type: dropped + _fixHint + BLOCK FEEDBACK machine message next round', async () => {
    state.adapterCalls = [];
    const { siteId, homePageId } = await makeSite('Dropped site');

    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', {
                id: 'd1', name: 'cms_add_blocks',
                input: { pageId: homePageId, blocks: [{ type: 'hero' }, { type: 'banner3000' }] },
            });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 5 });
        },
        async (messages, options, onEvent) => {
            // The dropped-type feedback must have entered the conversation as
            // a machine user message naming the bad type AND the valid roster.
            const feedback = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(BLOCK_FEEDBACK_PREFIX));
            assert.ok(feedback, 'BLOCK FEEDBACK machine message present');
            assert.ok(feedback.content.includes('banner3000'), feedback.content);
            assert.ok(feedback.content.includes('media-text') && feedback.content.includes('cta-banner'), 'valid types listed');
            // The tool result itself carried the teaching signal too.
            const result = toolResultFor(messages, 'cms_add_blocks');
            assert.strictEqual(result.dropped.length, 1);
            assert.ok(result._fixHint.includes('Valid block types'), result._fixHint);
            onEvent('text', { text: 'Re-adding that content with a valid type.' });
        },
    ];

    const res = await api('POST', '/stream', { user: 'admin-d1', body: { message: 'Add a hero and a banner', siteId, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    const call = eventsOf(events, 'tool_call')[0];
    assert.strictEqual(call.data.ok, true, 'partial add still succeeds');
    assert.match(call.data.summary, /1 dropped/);
    // The surviving hero landed.
    const draft = eventsOf(events, 'draft').find((d) => d.data.kind === 'page');
    assert.deepStrictEqual(draft.data.page.blocks.map((b) => b.type), ['hero']);
    assert.strictEqual(state.adapterCalls.length, 2);
});

test('header nav turn: tool_call "Updated header menu" → draft site with the new nav → done', async () => {
    state.adapterCalls = [];
    const { siteId, homePageId } = await makeSite('Header site');

    state.script = [
        // Turn 1 — the model replaces the header menu.
        async (messages, options, onEvent) => {
            onEvent('tool_use', {
                id: 'n1', name: 'cms_update_header_nav',
                input: {
                    nav: [
                        { label: 'Home', link: { kind: 'page', pageId: homePageId } },
                        { label: 'Docs', link: { kind: 'external', url: 'https://docs.example.com', newTab: true } },
                    ],
                },
            });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 5 });
        },
        // Turn 2 — sees the summary result, wraps up with prose.
        async (messages, options, onEvent) => {
            const result = toolResultFor(messages, 'cms_update_header_nav');
            assert.strictEqual(result.navCount, 2, `turn 2 sees the nav summary: ${JSON.stringify(result)}`);
            assert.deepStrictEqual(result.labels, ['Home', 'Docs']);
            onEvent('text', { text: 'Header menu updated.' });
            onEvent('done', { prompt_tokens: 12, completion_tokens: 4 });
        },
    ];

    const res = await api('POST', '/stream', { user: 'admin-n1', body: { message: 'Set the header menu to Home and Docs', siteId, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    // Frozen order: tool_call → draft site (NO page draft — nav touches no
    // PageDoc) → … → done closes the stream.
    const seq = events
        .filter((e) => e.event === 'tool_call' || e.event === 'draft')
        .map((e) => (e.event === 'tool_call' ? `tool:${e.data.name}` : `draft:${e.data.kind}`));
    assert.deepStrictEqual(seq, ['tool:cms_update_header_nav', 'draft:site'], seq.join(' | '));
    assert.strictEqual(events[events.length - 1].event, 'done', 'done is the final event');

    const call = eventsOf(events, 'tool_call')[0];
    assert.strictEqual(call.data.name, 'cms_update_header_nav');
    assert.strictEqual(call.data.label, 'Updated header menu');
    assert.strictEqual(call.data.ok, true, JSON.stringify(call.data));
    assert.ok(typeof call.data.summary === 'string' && call.data.summary.length > 0, JSON.stringify(call.data));

    // The site draft carries the persisted nav with minted nav_ ids.
    const siteDraft = eventsOf(events, 'draft').find((d) => d.data.kind === 'site');
    assert.strictEqual(siteDraft.data.siteId, siteId);
    assert.deepStrictEqual(siteDraft.data.site.header.nav.map((i) => i.label), ['Home', 'Docs']);
    for (const item of siteDraft.data.site.header.nav) assert.match(item.id, /^nav_/);

    const done = eventsOf(events, 'done')[0];
    assert.deepStrictEqual(done.data.createdPageIds, [], 'no pages created');
});

test('design turn: tool_call "Updated design" → draft site with the new design → done', async () => {
    state.adapterCalls = [];
    const { siteId } = await makeSite('Design site');

    state.script = [
        // Turn 1 — the model rethemes the site (preset + one override).
        async (messages, options, onEvent) => {
            onEvent('tool_use', {
                id: 'g1', name: 'cms_update_design',
                input: {
                    preset: 'midnight-flow',
                    colorsPatch: { primary: '#FF0055' },
                    componentsPatch: { buttonSize: 'lg' },
                    radius: 20,
                },
            });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 5 });
        },
        // Turn 2 — sees the design read back from the store, wraps up.
        async (messages, options, onEvent) => {
            const result = toolResultFor(messages, 'cms_update_design');
            assert.ok(result && result.design, `turn 2 sees the persisted design: ${JSON.stringify(result)}`);
            assert.strictEqual(result.design.preset, 'midnight-flow');
            assert.strictEqual(result.design.colors.primary, '#FF0055', 'the patch beat the preset');
            assert.strictEqual(result.design.components.buttonSize, 'lg');
            assert.strictEqual(result.design.components.navStyle, 'floating', 'preset materialized');
            assert.strictEqual(result.design.radius, 20);
            assert.ok(result.summary.includes('preset midnight-flow'), result.summary);
            onEvent('text', { text: 'Retheme done.' });
            onEvent('done', { prompt_tokens: 12, completion_tokens: 4 });
        },
    ];

    const res = await api('POST', '/stream', { user: 'admin-th1', body: { message: 'Make it look like a dark dev tool', siteId, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    // Frozen order: tool_call → draft site (NO page draft — design touches no
    // PageDoc) → … → done closes the stream.
    const seq = events
        .filter((e) => e.event === 'tool_call' || e.event === 'draft')
        .map((e) => (e.event === 'tool_call' ? `tool:${e.data.name}` : `draft:${e.data.kind}`));
    assert.deepStrictEqual(seq, ['tool:cms_update_design', 'draft:site'], seq.join(' | '));
    assert.strictEqual(events[events.length - 1].event, 'done', 'done is the final event');

    const call = eventsOf(events, 'tool_call')[0];
    assert.strictEqual(call.data.name, 'cms_update_design');
    assert.strictEqual(call.data.label, 'Updated design');
    assert.strictEqual(call.data.ok, true, JSON.stringify(call.data));
    assert.match(call.data.summary, /preset midnight-flow/, call.data.summary);

    // The site draft carries the persisted design (the client full-replaces
    // its SiteDoc from this, which is what repaints the preview).
    const siteDraft = eventsOf(events, 'draft').find((d) => d.data.kind === 'site');
    assert.strictEqual(siteDraft.data.siteId, siteId);
    assert.strictEqual(siteDraft.data.site.design.colors.primary, '#FF0055');
    assert.strictEqual(siteDraft.data.site.design.preset, 'midnight-flow');
    assert.strictEqual(siteDraft.data.site.design.layout.containerWidth, 'default');

    const done = eventsOf(events, 'done')[0];
    assert.deepStrictEqual(done.data.createdPageIds, [], 'no pages created');
    assert.deepStrictEqual(done.data.touchedPageIds, [], 'no pages touched');

    // The whole design travels to the model in the late SITE STATE message.
    const stateNote = state.adapterCalls[1].messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(DRAFT_STATE_PREFIX));
    assert.ok(stateNote, 'SITE STATE message present');
    assert.ok(stateNote.content.includes('cms_update_design DEEP-MERGE patches this'), 'design line labelled');
    assert.ok(stateNote.content.includes('"buttonShape"'), 'components group visible to the model');
});

test('design rejection: bad hex never reaches the store; no draft event, teaching hint fed back', async () => {
    state.adapterCalls = [];
    const { siteId } = await makeSite('Bad design site');

    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'g2', name: 'cms_update_design', input: { colorsPatch: { primary: 'warm amber' } } });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 5 });
        },
        async (messages, options, onEvent) => {
            const result = toolResultFor(messages, 'cms_update_design');
            assert.ok(result.error && /#rrggbb/i.test(result._fixHint), JSON.stringify(result));
            onEvent('text', { text: 'Using a hex value instead.' });
        },
    ];

    const res = await api('POST', '/stream', { user: 'admin-th2', body: { message: 'Make the primary warm amber', siteId, modelTier: 'fast' } });
    const events = parseSSE(res.text);
    const call = eventsOf(events, 'tool_call')[0];
    assert.strictEqual(call.data.ok, false, JSON.stringify(call.data));
    assert.strictEqual(eventsOf(events, 'draft').length, 0, 'a rejected design emits NO draft event');
    const stored = await cmsStore.getProject(siteId);
    assert.strictEqual(stored.design.colors.primary, '#F5A623', 'design untouched');
});

test('validation loop: dangling page link → validation_errors SSE + VALIDATION REPORT next round', async () => {
    state.adapterCalls = [];
    const { siteId, homePageId } = await makeSite('Dangling site');

    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', {
                id: 'v1', name: 'cms_add_blocks',
                input: {
                    pageId: homePageId,
                    blocks: [{ type: 'cta', content: { button: { label: 'Read more', link: { kind: 'page', pageId: 'pg_ghost' } } } }],
                },
            });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 5 });
        },
        async (messages, options, onEvent) => {
            const report = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(VALIDATION_NOTE_PREFIX));
            assert.ok(report, 'VALIDATION REPORT user message entered the history');
            assert.ok(report.content.includes('dangling_page_link'), report.content);
            onEvent('text', { text: 'I will fix that link.' });
        },
    ];

    const res = await api('POST', '/stream', { user: 'admin-v1', body: { message: 'Add a CTA to the ghost page', siteId, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    const validations = eventsOf(events, 'validation_errors');
    assert.ok(validations.length >= 1, 'validation_errors emitted');
    assert.ok(validations[0].data.errors.some((e) => e.code === 'dangling_page_link'), JSON.stringify(validations[0].data));
    assert.strictEqual(state.adapterCalls.length, 2);
});

test('tiers: auto → classifier; disallowed explicit → falls back to auto; local override skips both', async () => {
    const { siteId } = await makeSite('Tier site');

    // auto → classifier runs, model_selected reflects its pick.
    state.classifyCalls = 0;
    state.script = [async (m, o, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', {}); }];
    const auto = await api('POST', '/stream', { user: 'admin-t1', body: { message: 'x', siteId } });
    assert.strictEqual(auto.status, 200);
    assert.strictEqual(state.classifyCalls, 1, 'auto runs the classifier');
    assert.deepStrictEqual(eventsOf(parseSSE(auto.text), 'model_selected')[0].data, { modelId: 'test-model-large', tier: 'fast' });

    // Disallowed explicit tier ('pro' not permitted/configured) → auto.
    state.classifyCalls = 0;
    state.script = [async (m, o, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', {}); }];
    const disallowed = await api('POST', '/stream', { user: 'admin-t2', body: { message: 'x', siteId, modelTier: 'pro' } });
    assert.strictEqual(disallowed.status, 200);
    assert.strictEqual(state.classifyCalls, 1, 'disallowed tier fell back to auto → classifier ran');
    assert.strictEqual(eventsOf(parseSSE(disallowed.text), 'model_selected')[0].data.tier, 'fast');

});

test('provider failure → SSE error transient_upstream (+ usage row still logged)', async () => {
    usageEvents.length = 0;
    const { siteId } = await makeSite('Broken provider site');
    state.script = [
        // Non-transient throw → streamWithRetry gives up immediately.
        async () => { throw new Error('provider exploded'); },
    ];
    const res = await api('POST', '/stream', { user: 'admin-e1', body: { message: 'x', siteId, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    const err = eventsOf(events, 'error')[0];
    assert.ok(err, 'error event emitted');
    assert.strictEqual(err.data.code, 'transient_upstream');
    assert.ok(err.data.message);
    assert.strictEqual(usageEvents.length, 1);
    assert.strictEqual(usageEvents[0].stop_reason, 'transient_upstream');
    // The turn still ends with done (draft is safe — tools persist as they run).
    assert.ok(eventsOf(events, 'done').length === 1);
});

test('budget exhausted: 16 tool rounds → error budget_exhausted, everything persisted', async () => {
    usageEvents.length = 0;
    const { siteId } = await makeSite('Budget site');
    state.script = Array.from({ length: 16 }, (_, i) => async (messages, options, onEvent) => {
        onEvent('tool_use', { id: `b${i}`, name: 'cms_list_site', input: {} });
        onEvent('done', { prompt_tokens: 1, completion_tokens: 1 });
    });
    const res = await api('POST', '/stream', { user: 'admin-b1', body: { message: 'loop forever', siteId, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    assert.strictEqual(eventsOf(events, 'tool_call').length, 16, 'capped at 16 iterations');
    const err = eventsOf(events, 'error')[0];
    assert.ok(err && err.data.code === 'budget_exhausted', JSON.stringify(err));
    assert.ok(eventsOf(events, 'done').length === 1, 'done still closes the stream');
    assert.strictEqual(usageEvents[0].stop_reason, 'budget_exhausted');
});

test('editor context: whitelisted keys ride in the machine message; junk rejected', async () => {
    // Pure helper behavior.
    assert.strictEqual(sanitizeEditorContext(undefined), null);
    assert.strictEqual(sanitizeEditorContext({ evil: 'x' }), null);
    assert.strictEqual(sanitizeEditorContext({ activePageId: 'x'.repeat(65) }), null);
    const ctx = sanitizeEditorContext({ activePageId: 'pg_ctx1', activeBlockId: 'blk_ctx1', activeLocale: 'nl', injected: 'dropped' });
    assert.deepStrictEqual(ctx, { activePageId: 'pg_ctx1', activeBlockId: 'blk_ctx1', activeLocale: 'nl' });

    state.adapterCalls = [];
    const { siteId, homePageId } = await makeSite('Context site');
    state.script = [async (m, o, onEvent) => { onEvent('text', { text: 'Looking.' }); onEvent('done', {}); }];
    const res = await api('POST', '/stream', {
        user: 'admin-c1',
        body: {
            message: 'Make this bigger', siteId, modelTier: 'fast',
            context: { activePageId: homePageId, activeBlockId: 'blk_sel1', activeLocale: 'nl', evil: 'x' },
        },
    });
    assert.strictEqual(res.status, 200);
    const msgs = state.adapterCalls[0].messages;
    const note = msgs.find((m) => m.role === 'user' && m.content.startsWith(DRAFT_STATE_PREFIX));
    assert.ok(note.content.includes(EDITOR_CONTEXT_PREFIX), 'context rides inside the late machine message');
    assert.ok(note.content.includes(`open page: ${homePageId}`));
    assert.ok(note.content.includes('selected block: blk_sel1'));
    assert.ok(note.content.includes('viewing locale: nl'));
    assert.ok(!note.content.includes('evil'), 'unknown keys never reach the model');

    // The machine notes never land in the persisted history.
    const snap = await cmsStore.getBuilderSession(siteId);
    assert.ok(snap.messages.every((m) => !m.content.startsWith(DRAFT_STATE_PREFIX) && !m.content.startsWith(EDITOR_CONTEXT_PREFIX)));

    // sanitizeHistory strips every machine prefix.
    const cleaned = sanitizeHistory([
        { role: 'user', content: 'real question' },
        { role: 'user', content: `${EDITOR_CONTEXT_PREFIX}\nopen page: pg_x` },
        { role: 'user', content: `${VALIDATION_NOTE_PREFIX}\n[]` },
        { role: 'user', content: `${BLOCK_FEEDBACK_PREFIX}\nbad types` },
        { role: 'assistant', content: 'real answer' },
    ]);
    assert.deepStrictEqual(cleaned.map((m) => m.content), ['real question', 'real answer']);
});
