/**
 * Route tests for the App Studio AI builder (routes/ai/appStudioBuilder.js).
 *
 * The adapter/LLM plumbing (providers, aiAgent, modelResolver,
 * promptClassifier, limits, auth) and the stores are mocked via the
 * Module._resolveFilename harness (same pattern as routes/studioApps.test.js);
 * the appStudio layer (componentSpecs / canonicalize / validate /
 * definitionOps / builderTools / builderPrompt) runs for real. Requests go
 * over real HTTP against express app.listen(0) and the SSE body is parsed
 * from the response text.
 *
 * Run: node --test routes/ai/appStudioBuilder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// Pure at require time (it reads the permitted list only when asked), so the
// real one can back the stub below.
const realTierAccess = require('../../core/entitlements/tierAccess');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ── Shared mutable state the mocks read ─────────────────────────────

const DEFAULT_TIERS = { fast: { modelId: 'test-model-large' }, standard: { modelId: 'test-model-large' } };

const state = {
    apps: new Map(),
    nextApp: 0,
    limitError: null,          // string → checkSubscriptionLimits blocks with 402
    script: [],                // queue of (messages, options, onEvent) turn functions
    adapterCalls: [],          // captured messages per adapter.stream call
    tiers: DEFAULT_TIERS,      // what the mocked getUserTierMap returns
    usageThrows: null,         // string → usageStore.logUsage throws it (blows up the turn)
    supportsVision: true,      // what the mocked adapter reports for the resolved model
    config: {},                // configStore.getConfig(key) → state.config[key] (builder_model_profiles)
};

// ── Mock studioAppStore (contract mirror, incl. builder session) ────

const mockStudioAppStore = {
    async createStudioApp({ userId, organizationId, name, description, icon, definition } = {}) {
        const id = `app-${++state.nextApp}`;
        const app = {
            id, userId,
            organizationId: organizationId || null,
            name: name || 'Untitled app',
            description: description || '',
            icon: icon || null,
            definition: clone(definition),
            definitionVersion: 1,
            builderSession: null,
        };
        state.apps.set(id, app);
        return clone(app);
    },
    async getStudioApp(id) {
        const a = state.apps.get(id);
        return a ? clone(a) : null;
    },
    canWriteStudioApp(app, userId) {
        return !!app && app.userId === userId;
    },
    async saveDefinition(id, ownerId, definition, { expectedVersion = null } = {}) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return { ok: false, notFound: true };
        if (expectedVersion != null && a.definitionVersion !== expectedVersion) {
            return { ok: false, conflict: true, currentVersion: a.definitionVersion, definition: clone(a.definition) };
        }
        a.definition = clone(definition);
        a.definitionVersion += 1;
        return { ok: true, version: a.definitionVersion };
    },
    async updateStudioApp(id, updates = {}, ownerId) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return null;
        for (const k of ['name', 'description', 'icon']) {
            if (updates[k] !== undefined) a[k] = updates[k];
        }
        return clone(a);
    },
    async createVersionSnapshot(appId, ownerId, definition, summary) {
        const a = state.apps.get(appId);
        if (!a || (ownerId && a.userId !== ownerId)) throw new Error('app not found');
        a.versions = a.versions || [];
        const id = `ver-${a.versions.length + 1}`;
        a.versions.push({ id, summary, definition: clone(definition) });
        return id;
    },
    async getBuilderSession(appId, userId) {
        const a = state.apps.get(appId);
        if (!a) return null;
        if (userId && a.userId !== userId) return null;
        return a.builderSession ? clone(a.builderSession) : null;
    },
    async setBuilderSession(appId, userId, snapshot) {
        const a = state.apps.get(appId);
        if (!a) return { ok: false, notFound: true };
        if (userId && a.userId !== userId) return { ok: false, forbidden: true };
        const currentVersion = Number.isFinite(a.builderSession?.version) ? a.builderSession.version : 0;
        a.builderSession = { ...clone(snapshot), version: currentVersion + 1 };
        return { ok: true, snapshot: clone(a.builderSession) };
    },
};

// ── Mock studioAppDataStore + studioAppDbStore (the data engine's
//    Postgres/SQLite edges — the appStudio layer above them runs REAL,
//    including builderTools' data tools and actionExecutor.writeRecord) ──

const dataState = {
    models: new Map(),     // appId → data model
    versions: new Map(),   // appId → model_version (CAS)
    rowCounts: new Map(),  // appId → counts map ({ [tableIdOrKey]: n })
    datasets: new Map(),   // appId → [{ id, name, tableId, descriptor, cacheTtlSeconds }]
    nextDataset: 0,
    queryRows: [],         // what studioAppDbStore.query returns
    execCalls: [],
};

const mockStudioAppDataStore = {
    async getDataModel(appId) {
        const model = dataState.models.get(appId);
        if (!model) return null;
        return {
            model: clone(model),
            modelVersion: dataState.versions.get(appId) ?? 1,
            dataVersions: {},
            rowCounts: clone(dataState.rowCounts.get(appId) || {}),
        };
    },
    async saveDataModel(appId, ownerId, model, { expectedVersion = null } = {}) {
        const { validateDataModel } = require('../../appStudio/dataModel');
        const { errors } = validateDataModel(model);
        if (errors.length) return { ok: false, invalid: true, errors };
        const cur = dataState.versions.get(appId) ?? (dataState.models.has(appId) ? 1 : 0);
        if (expectedVersion != null && cur !== expectedVersion) {
            return { ok: false, conflict: true, currentVersion: cur, model: clone(dataState.models.get(appId) || { modelVersion: 1, tables: [] }) };
        }
        dataState.models.set(appId, clone(model));
        dataState.versions.set(appId, cur + 1);
        return { ok: true, version: cur + 1 };
    },
    async getRowCounts(appId) { return clone(dataState.rowCounts.get(appId) || {}); },
    async bumpRowCount(appId, tableKey, delta) {
        const counts = dataState.rowCounts.get(appId) || {};
        counts[tableKey] = Math.max(0, (parseInt(counts[tableKey], 10) || 0) + delta);
        dataState.rowCounts.set(appId, counts);
        return clone(counts);
    },
    async bumpDataVersion() { return 1; },
    async getMemberRole() { return null; },
    async listDatasets(appId) {
        return clone(dataState.datasets.get(appId) || []);
    },
    async createDataset(appId, ownerId, { name, tableId, descriptor, cacheTtlSeconds } = {}) {
        const row = {
            id: `ds_live${++dataState.nextDataset}`, appId,
            name: name || 'Untitled dataset', tableId: tableId || null,
            descriptor: clone(descriptor || {}), cacheTtlSeconds: cacheTtlSeconds ?? 60,
        };
        const list = dataState.datasets.get(appId) || [];
        list.push(row);
        dataState.datasets.set(appId, list);
        return clone(row);
    },
    async updateDataset(id, appId, ownerId, updates = {}) {
        const row = (dataState.datasets.get(appId) || []).find((d) => d.id === id);
        if (!row) return null;
        Object.assign(row, clone(updates));
        return clone(row);
    },
    async getDataset(id, appId) {
        const row = (dataState.datasets.get(appId) || []).find((d) => d.id === id);
        return row ? clone(row) : null;
    },
    async deleteDataset(id, appId) {
        const list = dataState.datasets.get(appId) || [];
        const idx = list.findIndex((d) => d.id === id);
        if (idx >= 0) list.splice(idx, 1);
        return idx >= 0;
    },
    async getCache() { return null; },
    async putCache() { return { ok: true }; },
};

const mockStudioAppDbStore = {
    async exec(ownerId, appId, sql, params) {
        dataState.execCalls.push({ ownerId, appId, sql, params });
        return { changes: 1 };
    },
    async query(ownerId, appId, sql, params) {
        dataState.execCalls.push({ ownerId, appId, sql, params, read: true });
        return { columns: [], rows: clone(dataState.queryRows), truncated: false };
    },
    async sizeBytes() { return 0; },
};

// ── Mock usageStore — captures the Wave 6c per-turn logUsage rows ──
const usageEvents = [];
const mockUsageStore = {
    // Deliberately NOT async: state.usageThrows makes it throw SYNCHRONOUSLY,
    // which is what reaches the stream's outer catch (the route's own
    // fire-and-forget .catch() swallows a rejected promise).
    logUsage(entry) {
        if (state.usageThrows) throw new Error(state.usageThrows);
        usageEvents.push(clone(entry));
        return Promise.resolve({ id: usageEvents.length });
    },
};

// ── Mock LLM plumbing ───────────────────────────────────────────────

const mockAdapter = {
    // Real adapters expose this (base.js → false; claude/openai/google/… per
    // model). The route derives modelSupportsVision from it, which gates both
    // app_screenshot's replay AND the user's own attached images.
    supportsVision() { return state.supportsVision; },
    async stream(apiKey, url, modelId, messages, options, onEvent) {
        state.adapterCalls.push({
            modelId,
            messages: clone(messages),
            options: { toolChoice: options.toolChoice, reasoningEffort: options.reasoningEffort, temperature: options.temperature, maxTokens: options.maxTokens },
            toolNames: (options.tools || []).map((t) => t.function.name),
        });
        const turn = state.script.shift();
        if (!turn) { onEvent('text', { text: 'Nothing scripted.' }); return; }
        await turn(messages, options, onEvent);
    },
};

const MOCKS = {
    // stores — request strings as issued from routes/ai/* AND appStudio/*
    '../../stores/studioAppStore': mockStudioAppStore,
    '../stores/studioAppStore': mockStudioAppStore,
    '../../stores/studioAppDataStore': mockStudioAppDataStore,
    '../stores/studioAppDataStore': mockStudioAppDataStore,
    '../../stores/studioAppDbStore': mockStudioAppDbStore,
    '../stores/studioAppDbStore': mockStudioAppDbStore,
    '../../stores/usageStore': mockUsageStore,
    '../stores/usageStore': mockUsageStore,
    '../../stores/automationStore': {
        getAutomationsForUser: async () => [
            { id: 'auto-1', userId: 'owner', title: 'Find customer', description: '', isActive: true, triggerType: 'agent_call', definition: { trigger: { kind: 'agent_call', parametersSchema: { type: 'object', properties: { query: { type: 'string' } } } } } },
        ],
        getAutomation: async () => null,
    },
    '../stores/automationStore': null, // filled below (same object)
    '../stores/userStore': { getUser: async (id) => ({ id, organizationId: 'orgA' }) },
    '../../stores/userStore': null, // filled below (same object)
    // route plumbing
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => state.limitError },
    '../../auth': { resolveUserOrgIds: async () => new Set(['orgA']) },
    '../../core/llm/modelResolver': {
        // Dynamic: tests swap state.tiers to exercise the auto-tier ranking.
        getUserTierMap: async () => clone(state.tiers),
        // No builder-local SLM override in tests — the route falls through to tiers.
    },
    '../../core/aiAgent': {
        getProviderForModel: async () => ({ providerType: 'mock', url: '', apiKey: 'k' }),
        getAIConfig: async () => ({ model: 'test-model-large' }),
    },
    // Which tiers the caller may use: every one. This file is about the build
    // loop; appStudioBuilder/modelSelection.test.js is where the list is measured.
    '../../core/entitlements/tierAccess': {
        ...realTierAccess,
        tierAccessFor: async () => realTierAccess.tierAccessOf(['auto', 'fast', 'standard', 'thinking', 'writer', 'pro']),
    },
    '../../core/providers': { getAdapter: () => mockAdapter },
    '../../stores/configStore': { getConfig: async (k) => (state.config && state.config[k] !== undefined ? state.config[k] : null) },
};
MOCKS['../stores/automationStore'] = MOCKS['../../stores/automationStore'];
MOCKS['../../stores/userStore'] = MOCKS['../stores/userStore'];
// The route's own code lives one directory deeper (routes/ai/appStudioBuilder/*:
// turnSetup, modelSelection, promptAssembly, buildLoop, turnClosing, …), so the
// specifiers written INSIDE it carry a third '../'. This harness matches the
// request string AS WRITTEN in the module under test, so every '../../x' key
// needs its '../../../x' twin — without it the stub silently stops matching, the
// REAL store loads and the test dies on a live Postgres connect
// (server/ARCHITECTURE.md, "Module ids that are not require calls").
for (const [request, exportsObj] of Object.entries({ ...MOCKS })) {
    if (request.startsWith('../../')) MOCKS[`../${request}`] = exportsObj;
}

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
const router = require('./appStudioBuilder');
const { validateAppDefinition } = require('../../appStudio/validate');
const {
    VALIDATION_NOTE_PREFIX,
    EDITOR_CONTEXT_PREFIX,
    APPROVED_PLAN_PREFIX,
    IMAGE_NOTE_PREFIX,
    IMAGE_MIME_ALLOWLIST,
    MAX_IMAGES_PER_TURN,
    MAX_IMAGE_BYTES,
    base64ByteLength,
    sanitizeEditorContext,
    sanitizeHistory,
    sanitizeInboundImages,
} = require('./appStudioBuilder')._test;

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    // Mirrors server/index.js (bodyParser.json({ limit: '20mb' })) — the
    // default 100kb would 413 an image turn before the route's own limits
    // ever got a say.
    app.use(express.json({ limit: '20mb' }));
    app.use((req, res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) req.session = { isAuthenticated: true, user: { id: uid, organizationId: 'orgA' } };
        next();
    });
    app.use('/api/studio-apps/builder', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/studio-apps/builder`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function api(method, path, { user, body } = {}) {
    const headers = {};
    if (user) headers['x-test-user'] = user;
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

/**
 * Find the tool result JSON for a given tool name in the adapter's message
 * list. Scans from the END so the LIVE turn's call wins over the few-shot
 * example's identically-named sentinel call (ex_* ids) earlier in the list.
 */
function toolResultFor(messages, toolName, nth = 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        const hits = m.tool_calls.filter((tc) => tc.function?.name === toolName);
        if (!hits.length) continue;
        const tc = hits[Math.min(nth, hits.length - 1)];
        const result = messages.slice(i + 1).find((x) => x.role === 'tool' && x.tool_call_id === tc.id);
        if (result) { try { return JSON.parse(result.content); } catch (_) { return null; } }
    }
    return null;
}

// ── Tests ───────────────────────────────────────────────────────────

test('auth required: 401 on stream and session without a session', async () => {
    const stream = await api('POST', '/stream', { body: { message: 'hi' } });
    assert.strictEqual(stream.status, 401);
    const session = await api('GET', '/session/whatever', {});
    assert.strictEqual(session.status, 401);
});

test('GET /session/:appId — 404 with no snapshot, 200 with one, owner-scoped', async () => {
    const app = await mockStudioAppStore.createStudioApp({ userId: 'owner', name: 'Session app' });
    const missing = await api('GET', `/session/${app.id}`, { user: 'owner' });
    assert.strictEqual(missing.status, 404);

    await mockStudioAppStore.setBuilderSession(app.id, 'owner', {
        sessionId: 'as_test1',
        messages: [{ role: 'user', content: 'earlier turn' }],
    });
    const found = await api('GET', `/session/${app.id}`, { user: 'owner' });
    assert.strictEqual(found.status, 200);
    assert.strictEqual(found.body.snapshot.sessionId, 'as_test1');
    assert.strictEqual(found.body.snapshot.messages[0].content, 'earlier turn');

    const foreign = await api('GET', `/session/${app.id}`, { user: 'intruder' });
    assert.strictEqual(foreign.status, 404, 'non-owner sees no session');
});

test('subscription limit blocks with 402 JSON BEFORE any SSE', async () => {
    state.limitError = 'Chat limit reached for your plan';
    const res = await api('POST', '/stream', { user: 'limited', body: { message: 'build something' } });
    state.limitError = null;
    assert.strictEqual(res.status, 402);
    assert.ok(res.contentType.includes('application/json'), `not SSE: ${res.contentType}`);
    assert.strictEqual(res.body.error, 'Chat limit reached for your plan');
});

test('POST /stream with an unknown/foreign appId 404s pre-SSE', async () => {
    const app = await mockStudioAppStore.createStudioApp({ userId: 'owner', name: 'Private' });
    const foreign = await api('POST', '/stream', { user: 'intruder', body: { message: 'x', appId: app.id } });
    assert.strictEqual(foreign.status, 404);
    const missing = await api('POST', '/stream', { user: 'owner', body: { message: 'x', appId: 'nope' } });
    assert.strictEqual(missing.status, 404);
});

test('scripted build: screen + components → drafts, tool_calls, done', async () => {
    state.adapterCalls = [];
    state.script = [
        // Turn 1 — the model adds a screen.
        async (messages, options, onEvent) => {
            onEvent('thinking_start', { partId: 't0' });
            onEvent('thinking', { partId: 't0', text: 'plan the app' });
            onEvent('thinking_stop', { partId: 't0' });
            onEvent('tool_use', { id: 'c1', name: 'app_add_screen', input: { name: 'Search', icon: 'Search' } });
            onEvent('done', { prompt_tokens: 100, completion_tokens: 20 });
        },
        // Turn 2 — reads the real sectionId from the tool result, batches components.
        async (messages, options, onEvent) => {
            const added = toolResultFor(messages, 'app_add_screen');
            assert.ok(added && added.sectionId, 'turn 2 sees the app_add_screen result');
            onEvent('tool_use', {
                id: 'c2', name: 'app_add_components',
                input: {
                    parentId: added.sectionId,
                    components: [
                        { type: 'heading', props: { text: 'Lookup', level: 1 } },
                        {
                            tempId: 'frm', type: 'form', props: { name: 'search' },
                            children: [{ type: 'input_text', props: { name: 'query', label: 'Query' } }],
                        },
                    ],
                },
            });
            onEvent('done', { prompt_tokens: 150, completion_tokens: 30 });
        },
        // Turn 3 — prose; ends the turn.
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Built the search screen.' });
            onEvent('done', { prompt_tokens: 160, completion_tokens: 10 });
        },
    ];

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Build a lookup app', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.contentType.includes('text/event-stream'));
    const events = parseSSE(res.text);

    // builder_session first, then model_selected.
    assert.strictEqual(events[0].event, 'builder_session');
    assert.ok(events[0].data.sessionId, 'session id present');
    const model = eventsOf(events, 'model_selected')[0];
    assert.deepStrictEqual(model.data, { modelId: 'test-model-large', tier: 'fast' });

    // Thinking + prose forwarded per the contract shapes.
    assert.ok(eventsOf(events, 'thinking_start').length >= 1);
    const think = eventsOf(events, 'thinking')[0].data;
    assert.strictEqual(think.delta, 'plan the app');
    assert.ok(typeof think.partId === 'string' && think.partId.length, 'thinking deltas carry a partId (additive)');
    assert.ok(eventsOf(events, 'message').some((e) => e.data.content === 'Built the search screen.'));

    // Tool calls with label/ok/summary — plus the typed `added` list and the
    // bounded model-facing payloads the activity rows and ghost clearing read.
    const toolCalls = eventsOf(events, 'tool_call');
    assert.deepStrictEqual(toolCalls.map((e) => e.data.name), ['app_add_screen', 'app_add_components']);
    for (const tc of toolCalls) {
        assert.strictEqual(tc.data.ok, true, JSON.stringify(tc.data));
        assert.ok(tc.data.label && typeof tc.data.summary === 'string');
        assert.ok(typeof tc.data.arguments === 'string' && typeof tc.data.result === 'string');
        assert.doesNotThrow(() => JSON.parse(tc.data.result));
    }
    assert.deepStrictEqual(toolCalls[0].data.added.map((a) => a.type), ['screen']);
    assert.strictEqual(toolCalls[0].data.added[0].label, 'Search');
    const addedComponents = toolCalls[1].data.added;
    assert.deepStrictEqual(addedComponents.map((a) => a.type), ['heading', 'form', 'input_text'], 'every landed component, typed, in order');
    assert.strictEqual(addedComponents[0].label, 'Lookup', 'labels read off the landed node');
    assert.ok(addedComponents.every((a) => /^cmp_/.test(a.id)));
    // tool_draft: the streamed arguments were scanned while being typed. The
    // mock adapter emits tool_use whole, so no deltas here — the contract test
    // for the scanner is toolDraft.test.js; this pins that a build without
    // deltas emits none rather than an empty one.
    assert.deepStrictEqual(eventsOf(events, 'tool_draft'), []);

    // Draft events carry a VALID definition and a growing version: one per
    // landed mutation, then the auto-finalize's own save. The model closed the
    // turn on prose after BUILDING, so the route finalized the validating draft
    // for it — "I have built the app!" with no app_finalize used to leave a
    // playbook phase running and the presenter pressing Mark as done live.
    const drafts = eventsOf(events, 'draft');
    assert.strictEqual(drafts.length, 3, 'two mutations + the auto-finalize');
    assert.ok(drafts[0].data.appId, 'first mutation created the app');
    assert.strictEqual(drafts[0].data.version, 1);
    assert.strictEqual(drafts[1].data.version, 2);
    assert.strictEqual(drafts[2].data.version, 3, 'the auto-finalize saved a version of its own');
    for (const d of drafts) {
        const check = validateAppDefinition(d.data.definition);
        assert.strictEqual(check.ok, true, JSON.stringify(check.errors));
    }
    const finalDef = drafts[1].data.definition;
    assert.ok(finalDef.screens.some((s) => s.name === 'Search'), 'screen landed');
    assert.ok(drafts[2].data.definition.screens.some((s) => s.name === 'Search'), 'the finalized definition keeps it');
    // The net says WHY it saved, truthfully: nothing ran out on this turn, so
    // the budget wording would be a lie under the model's own closing line.
    const messages = eventsOf(events, 'message').map((e) => e.data.content);
    assert.ok(messages.some((c) => /saved as it stands/.test(c)), `the auto-finalize is announced: ${JSON.stringify(messages)}`);
    assert.ok(!messages.some((c) => /ran out of build turns/.test(c)), 'the budget wording belongs to the budget exit');
    assert.deepStrictEqual(eventsOf(events, 'error'), [], 'a clean build streams no error');

    // usage events carry the contract field names.
    const usage = eventsOf(events, 'usage');
    assert.ok(usage.length >= 3);
    // The cumulative pair the first clients read stays; this round's adapter
    // payload rides alongside (llama.cpp timings live there on the box).
    for (const k of ['inputTokens', 'outputTokens', 'iter', 'effort', 'prompt_tokens', 'completion_tokens', 'totals']) {
        assert.ok(k in usage[0].data, `usage carries ${k}`);
    }
    assert.strictEqual(usage[0].data.iter, 0);
    assert.strictEqual(usage[0].data.prompt_tokens, 100, 'this round, verbatim');
    assert.strictEqual(usage[usage.length - 1].data.inputTokens, 410, 'usage accumulates across rounds');
    assert.strictEqual(usage[usage.length - 1].data.totals.prompt, 410);
    // round_start precedes every model call and says where the model runs.
    const rounds = eventsOf(events, 'round_start');
    assert.strictEqual(rounds.length, usage.length, 'one round_start per model call');
    assert.deepStrictEqual(Object.keys(rounds[0].data).sort(), ['effort', 'iter', 'local', 'modelId', 'promptChars', 'providerType']);
    assert.ok(rounds[0].data.promptChars > 1000);
    assert.strictEqual(rounds[0].data.local, false, 'the mock provider type is not a local runtime');

    // validation_errors emitted after mutations (clean here).
    const validations = eventsOf(events, 'validation_errors');
    assert.ok(validations.length >= 1);
    assert.deepStrictEqual(validations[validations.length - 1].data.errors, []);

    // done + persisted state.
    const done = eventsOf(events, 'done')[0];
    assert.strictEqual(done.data.appId, drafts[0].data.appId);
    assert.strictEqual(done.data.finalized, true, 'built, then closed on prose → finalized by the net');
    const row = state.apps.get(done.data.appId);
    assert.ok(row, 'app row exists in the store');
    assert.strictEqual(row.definitionVersion, 3);
    assert.ok(row.builderSession, 'session snapshot persisted at turn end');
    assert.deepStrictEqual(
        row.builderSession.messages.map((m) => m.role),
        ['user', 'assistant'],
        'snapshot keeps the prose conversation',
    );
    assert.ok(row.builderSession.summary.includes('screen'), 'summary line present');

    // First adapter call: system prompt is first; the draft state travels late,
    // INSIDE the single user message that closes the request.
    const first = state.adapterCalls[0].messages;
    assert.strictEqual(first[0].role, 'system');
    assert.ok(first[0].content.includes('never code'), 'identity present');
    // The owner's automations ride the OWNER CONTEXT note in the folded user
    // message (since 2026-09-17), never the system prompt — which is what
    // keeps that prompt one text for every user of a box.
    assert.ok(!first[0].content.includes('auto-1'), 'owner automations are NOT in the static prompt');
    const draftStateIdx = first.findIndex((m) => m.role === 'user' && m.content.startsWith('[DRAFT STATE'));
    assert.ok(draftStateIdx > 0 && draftStateIdx === first.length - 1, 'draft state leads the last (user) message');
    assert.ok(first[draftStateIdx].content.includes('[OWNER CONTEXT — machine-generated'), 'the owner note is in the folded user message');
    assert.ok(first[draftStateIdx].content.includes('auto-1'), 'with the owner\'s automation ids');
    assert.ok(first[draftStateIdx].content.endsWith('Build a lookup app'), 'the human\'s words close it');
});

test('scripted invalid mutation → validation_errors + [VALIDATION REPORT] user message enters history', async () => {
    state.adapterCalls = [];
    // A navigate to a missing screen is refused at TOOL time now, so the
    // validation loop is exercised the honest way: a valid navigate whose
    // target screen is then removed — legal step by step, invalid as a whole.
    // Two adds: the first takes the empty default Home's place (2026-09-14),
    // the second is a real second screen — the one the navigate targets and
    // the removal then orphans.
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'v0', name: 'app_add_screen', input: { name: 'One' } });
            onEvent('tool_use', { id: 'v0b', name: 'app_add_screen', input: { name: 'Two' } });
        },
        async (messages, options, onEvent) => {
            const added = toolResultFor(messages, 'app_add_screen', 1);
            onEvent('tool_use', { id: 'v1', name: 'app_set_action', input: { action: { kind: 'navigate', screenId: added.screenId } } });
        },
        async (messages, options, onEvent) => {
            const added = toolResultFor(messages, 'app_add_screen', 1);
            onEvent('tool_use', { id: 'v2', name: 'app_remove_screen', input: { screenId: added.screenId } });
        },
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'I will fix that reference.' });
        },
    ];

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Add a broken action', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    const validations = eventsOf(events, 'validation_errors');
    assert.ok(validations.length >= 1, 'validation_errors emitted');
    const errs = validations[validations.length - 1].data.errors;
    assert.ok(errs.length > 0, 'errors present');
    assert.ok(errs.some((e) => e.code === 'action.navigate_unresolved'), JSON.stringify(errs));

    // The last adapter call must see the machine-generated report as role:user.
    assert.strictEqual(state.adapterCalls.length, 4);
    const lastTurnMessages = state.adapterCalls[3].messages;
    const report = lastTurnMessages.find((m) => m.role === 'user' && m.content.startsWith(VALIDATION_NOTE_PREFIX));
    assert.ok(report, 'VALIDATION REPORT user message entered the history');
    assert.ok(report.content.includes('action.navigate_unresolved'), 'structured errors serialized into the report');

    const done = eventsOf(events, 'done')[0];
    assert.strictEqual(done.data.finalized, false);
});

test('a navigate to a screen that does not exist is refused when written — the validator\'s rule, one round earlier', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'v1', name: 'app_set_action', input: { action: { kind: 'navigate', screenId: 'scr_nonexist' } } });
        },
        async (messages, options, onEvent) => { onEvent('text', { text: 'Fixing.' }); },
    ];
    const res = await api('POST', '/stream', { user: 'u-refuse1', body: { message: 'Add a broken action', modelTier: 'fast' } });
    const events = parseSSE(res.text);
    const call = eventsOf(events, 'tool_call')[0].data;
    assert.strictEqual(call.ok, false);
    assert.match(call.error, /would fail validation — nothing was created/);
    assert.match(call.error, /scr_nonexist/);
    assert.deepStrictEqual(eventsOf(events, 'validation_errors'), [], 'nothing landed, so nothing to validate');
    const toolMsgs = state.adapterCalls[1].messages.filter((m) => m.role === 'tool');
    assert.ok(toolMsgs.some((m) => String(m.content).includes('scr_nonexist')), `the model reads the refusal in its tool result: ${JSON.stringify(toolMsgs)}`);
});

test('app_finalize flips done.finalized and blocked finalize surfaces validation', async () => {
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', {
                id: 'f1', name: 'app_add_components',
                input: { parentId: 'HOME_SECTION', components: [{ type: 'heading', props: { text: 'Hi' } }] },
            });
        },
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'f2', name: 'app_finalize', input: {} });
        },
    ];
    // Resolve the fresh draft's real home-section id from the draft state the
    // route injects (turn 1 rewrites the sentinel before calling the tool).
    const originalTurn = state.script[0];
    state.script[0] = async (messages, options, onEvent) => {
        const draftState = messages.find((m) => m.role === 'user' && m.content.startsWith('[DRAFT STATE'));
        const sec = draftState.content.match(/section (sec_[a-z0-9]+)/);
        await originalTurn(messages, options, (type, data) => {
            if (type === 'tool_use') data.input.parentId = sec[1];
            onEvent(type, data);
        });
    };

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'One heading then finish', modelTier: 'fast' } });
    const events = parseSSE(res.text);
    const done = eventsOf(events, 'done')[0];
    assert.strictEqual(done.data.finalized, true, JSON.stringify(events.map((e) => e.event)));
    const finalizeCall = eventsOf(events, 'tool_call').find((e) => e.data.name === 'app_finalize');
    assert.strictEqual(finalizeCall.data.ok, true);
    // Finalize emits a draft too (version bumped by its persist).
    const drafts = eventsOf(events, 'draft');
    assert.ok(drafts.length >= 2);
});

test('the naming net reads the BRIEF (the session\'s first human message), never a follow-up turn\'s text', async () => {
    // Turn 1 is the ask; the model only talks (nothing to finalize, nothing
    // named). Turn 2 says "Maak de kop groter", builds a table-less page
    // with one Home screen and finalizes: the net's sentence rule must read
    // turn 1's ask from the persisted history, not turn 2's text (which
    // would name the app "Kop groter").
    const app = await mockStudioAppStore.createStudioApp({ userId: 'u-brief', name: 'Untitled app' });
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Ik bouw een welkomstpagina.' });
            onEvent('done', { prompt_tokens: 20, completion_tokens: 5 });
        },
        async (messages, options, onEvent) => {
            const draftState = messages.find((m) => m.role === 'user' && m.content.startsWith('[DRAFT STATE'));
            const sec = draftState.content.match(/section (sec_[a-z0-9]+)/)[1];
            onEvent('tool_use', { id: 'n1', name: 'app_add_components', input: { parentId: sec, components: [{ type: 'heading', props: { text: 'Welkom' } }] } });
        },
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'n2', name: 'app_finalize', input: {} });
        },
    ];
    const first = await api('POST', '/stream', { user: 'u-brief', body: { appId: app.id, message: 'Bouw een welkomstpagina met onze openingstijden', modelTier: 'fast' } });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(state.apps.get(app.id).name, 'Untitled app', 'turn 1 built nothing, so nothing was named');
    const second = await api('POST', '/stream', { user: 'u-brief', body: { appId: app.id, message: 'Maak de kop groter', modelTier: 'fast' } });
    assert.strictEqual(second.status, 200);
    const done = eventsOf(parseSSE(second.text), 'done')[0];
    assert.strictEqual(done.data.finalized, true);
    assert.strictEqual(state.apps.get(app.id).definition.meta.name, 'Welkomstpagina');
    assert.strictEqual(state.apps.get(app.id).name, 'Welkomstpagina', 'the card follows (syncCardMeta)');
});

test('the brief is persisted on the snapshot and read from there when the store has trimmed it out of the messages', async () => {
    // Turn 1 stores `brief`; a long session then loses its first messages
    // to the HEAD trim — simulated by rewriting the snapshot's messages to
    // a follow-up only — and the finalize-time net still names the app
    // from the brief, not from "Maak de kop groter".
    const app = await mockStudioAppStore.createStudioApp({ userId: 'u-brief2', name: 'Untitled app' });
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Ik bouw een welkomstpagina.' });
            onEvent('done', { prompt_tokens: 20, completion_tokens: 5 });
        },
        async (messages, options, onEvent) => {
            const draftState = messages.find((m) => m.role === 'user' && m.content.startsWith('[DRAFT STATE'));
            const sec = draftState.content.match(/section (sec_[a-z0-9]+)/)[1];
            onEvent('tool_use', { id: 'n1', name: 'app_add_components', input: { parentId: sec, components: [{ type: 'heading', props: { text: 'Welkom' } }] } });
        },
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'n2', name: 'app_finalize', input: {} });
        },
    ];
    const first = await api('POST', '/stream', { user: 'u-brief2', body: { appId: app.id, message: 'Bouw een welkomstpagina met onze openingstijden', modelTier: 'fast' } });
    assert.strictEqual(first.status, 200);
    const stored = state.apps.get(app.id).builderSession;
    assert.strictEqual(stored.brief, 'Bouw een welkomstpagina met onze openingstijden', 'turn 1 persisted the brief as its own key');
    // The trim took the first messages; the brief key is untouched.
    stored.messages = [{ role: 'user', content: 'Maak de kop groter' }, { role: 'assistant', content: 'Gedaan.' }];
    const second = await api('POST', '/stream', { user: 'u-brief2', body: { appId: app.id, message: 'Nog groter', modelTier: 'fast' } });
    assert.strictEqual(second.status, 200);
    const done = eventsOf(parseSSE(second.text), 'done')[0];
    assert.strictEqual(done.data.finalized, true);
    assert.strictEqual(state.apps.get(app.id).definition.meta.name, 'Welkomstpagina');
    assert.strictEqual(state.apps.get(app.id).builderSession.brief, 'Bouw een welkomstpagina met onze openingstijden', 'turn 2 carried the brief forward');
});

// ── Model policy: auto tier ranking + profile-keyed tool menus ──────

test('auto tier resolves to the MOST CAPABLE configured model and streams the FULL tool menu (app_screenshot included)', async () => {
    state.adapterCalls = [];
    state.tiers = {
        fast: { modelId: 'claude-haiku-4-5' },
        standard: { modelId: 'claude-sonnet-4-6' },
        thinking: { modelId: 'claude-opus-4-8' },
        smart: { modelId: 'claude-sonnet-5' },
    };
    try {
        state.script = [
            async (messages, options, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', {}); },
        ];
        // No modelTier in the body → 'auto'.
        const res = await api('POST', '/stream', { user: 'u-auto1', body: { message: 'Build me a CRM' } });
        assert.strictEqual(res.status, 200);
        const model = eventsOf(parseSSE(res.text), 'model_selected')[0];
        assert.deepStrictEqual(model.data, { modelId: 'claude-sonnet-5', tier: 'smart' }, 'newest Claude generation ranked on top');

        // The capable model streams with the FULL tool menu.
        const toolNames = state.adapterCalls[0].toolNames;
        assert.ok(toolNames.includes('app_screenshot'), `full menu carries app_screenshot: ${toolNames.join(',')}`);
        assert.ok(toolNames.includes('app_propose_plan') && toolNames.includes('app_dry_run'), 'plan/dry-run tools present');
        const { TOOL_SCHEMAS } = require('../../appStudio/builderTools/schemas');
        assert.strictEqual(toolNames.length, TOOL_SCHEMAS.length, 'nothing filtered for a capable model');
    } finally {
        state.tiers = DEFAULT_TIERS;
    }
});

test('an EXPLICIT small tier is honoured (never overridden) and gets the core menu without app_screenshot', async () => {
    state.adapterCalls = [];
    state.tiers = { fast: { modelId: 'claude-haiku-4-5' }, smart: { modelId: 'claude-sonnet-5' } };
    try {
        state.script = [
            async (messages, options, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', {}); },
        ];
        const res = await api('POST', '/stream', { user: 'u-auto2', body: { message: 'Build me a CRM', modelTier: 'fast' } });
        assert.strictEqual(res.status, 200);
        const model = eventsOf(parseSSE(res.text), 'model_selected')[0];
        assert.deepStrictEqual(model.data, { modelId: 'claude-haiku-4-5', tier: 'fast' }, 'explicit tier choice is never overridden');

        const toolNames = state.adapterCalls[0].toolNames;
        assert.ok(!toolNames.includes('app_screenshot'), 'core menu has no app_screenshot');
        const { APP_CORE_TOOL_NAMES } = require('../../appStudio/builderModelProfiles');
        assert.deepStrictEqual([...toolNames].sort(), [...APP_CORE_TOOL_NAMES].sort(), 'exactly the core subset');
    } finally {
        state.tiers = DEFAULT_TIERS;
    }
});

test('auto on a small-only org keeps the configured small model (no invented model, floor is a no-op)', async () => {
    state.adapterCalls = [];
    state.tiers = { fast: { modelId: 'claude-haiku-4-5' } };
    try {
        state.script = [
            async (messages, options, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', {}); },
        ];
        const res = await api('POST', '/stream', { user: 'u-auto3', body: { message: 'Build me a CRM' } });
        assert.strictEqual(res.status, 200);
        const model = eventsOf(parseSSE(res.text), 'model_selected')[0];
        assert.deepStrictEqual(model.data, { modelId: 'claude-haiku-4-5', tier: 'fast' }, 'small-only org keeps its model');
    } finally {
        state.tiers = DEFAULT_TIERS;
    }
});

// ── Wave 2A: editor context + data-aware turn ───────────────────────

test('sanitizeEditorContext whitelists, bounds and rejects junk', () => {
    assert.strictEqual(sanitizeEditorContext(undefined), null);
    assert.strictEqual(sanitizeEditorContext('nope'), null);
    assert.strictEqual(sanitizeEditorContext({}), null);
    assert.strictEqual(sanitizeEditorContext({ evil: 'x' }), null);

    const full = sanitizeEditorContext({
        screenId: 'scr_abc123',
        nodeId: 'cmp_x1',
        boundTableId: 'tbl_t1',
        templateId: 'crm-pipeline',
        selectedNodeIds: ['cmp_a', 'cmp_b', 42, 'x'.repeat(65), ...Array.from({ length: 30 }, (_, i) => `cmp_extra${i}`)],
        injected: 'dropped',
    });
    assert.strictEqual(full.screenId, 'scr_abc123');
    assert.strictEqual(full.templateId, 'crm-pipeline');
    assert.strictEqual(full.injected, undefined, 'unknown keys dropped');
    assert.strictEqual(full.selectedNodeIds.length, 20, 'selection capped at 20');
    assert.ok(!full.selectedNodeIds.includes(42) && !full.selectedNodeIds.some((s) => s.length > 64), 'non-strings/oversized dropped');

    // oversized scalar ids dropped
    assert.strictEqual(sanitizeEditorContext({ screenId: 'x'.repeat(65) }), null);
});

test('sanitizeHistory strips EDITOR CONTEXT (and the other machine notes)', () => {
    const cleaned = sanitizeHistory([
        { role: 'user', content: 'real question' },
        { role: 'user', content: `${EDITOR_CONTEXT_PREFIX}\nopen screen: scr_x` },
        { role: 'user', content: `${VALIDATION_NOTE_PREFIX}\n[]` },
        { role: 'assistant', content: 'real answer' },
    ]);
    assert.deepStrictEqual(cleaned.map((m) => m.content), ['real question', 'real answer']);
});

test('body.context renders an [EDITOR CONTEXT] machine message after the draft state', async () => {
    state.adapterCalls = [];
    const app = await mockStudioAppStore.createStudioApp({ userId: 'owner', name: 'Context app' });
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Looking at it.' });
        },
    ];
    const res = await api('POST', '/stream', {
        user: 'owner',
        body: {
            message: 'Make this bigger',
            appId: app.id,
            modelTier: 'fast',
            context: { screenId: 'scr_ctx01', selectedNodeIds: ['cmp_sel01'], boundTableId: 'tbl_ctx01' },
        },
    });
    assert.strictEqual(res.status, 200);
    // Every machine note and the human's text travel as ONE user message —
    // strict chat templates (Gemma, Mistral) reject consecutive user turns, and
    // one message keeps the prefix cache's re-read to exactly this tail.
    const msgs = state.adapterCalls[0].messages;
    const last = msgs[msgs.length - 1];
    assert.strictEqual(last.role, 'user');
    const userTurns = msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[DRAFT STATE'));
    assert.strictEqual(userTurns.length, 1, 'exactly one message carries the draft state');
    assert.strictEqual(userTurns[0], last, 'and it is the last message');
    const draftAt = last.content.indexOf('[DRAFT STATE');
    const ctxAt = last.content.indexOf(EDITOR_CONTEXT_PREFIX);
    const textAt = last.content.indexOf('Make this bigger');
    assert.ok(draftAt === 0 && ctxAt > draftAt && textAt > ctxAt, 'draft state, then editor context, then the human\'s words');
    assert.ok(last.content.includes('scr_ctx01'));
    assert.ok(last.content.includes('cmp_sel01'));
    assert.ok(last.content.includes('tbl_ctx01'));
    // No two consecutive user messages anywhere in the request.
    for (let i = 1; i < msgs.length; i++) {
        assert.ok(!(msgs[i].role === 'user' && msgs[i - 1].role === 'user'), `consecutive user turns at ${i}`);
    }

    // The persisted snapshot keeps only prose — the machine note never lands
    // in cross-turn history.
    const row = state.apps.get(app.id);
    assert.ok(row.builderSession.messages.every((m) => !m.content.startsWith(EDITOR_CONTEXT_PREFIX)));
});

test('data-backed scripted turn: records binding + sequence action against a stubbed model finalizes clean', async () => {
    state.adapterCalls = [];
    const app = await mockStudioAppStore.createStudioApp({ userId: 'owner', name: 'Data app' });
    dataState.models.set(app.id, {
        modelVersion: 1,
        tables: [{
            id: 'tbl_task01', key: 'tasks', name: 'Tasks',
            fields: [
                { id: 'fld_tt01', key: 'title', type: 'text', required: true, unique: false },
                { id: 'fld_ts01', key: 'status', type: 'select', options: [{ value: 'todo' }, { value: 'done' }], required: false, unique: false },
            ],
            access: { default: 'app', roles: {}, rowFilters: {} },
        }],
        roles: [], roleMapping: { default: 'app', byGroup: {} },
    });
    dataState.rowCounts.set(app.id, { tbl_task01: 7 });
    dataState.datasets.set(app.id, [{ id: 'ds_stat001', name: 'By status' }]);

    state.script = [
        // Turn 1 — the model reads the data block from the draft state, then
        // binds a grid to the REAL table (formula-valued filter included) and
        // wires a create_record sequence.
        async (messages, options, onEvent) => {
            const draftState = messages.find((m) => m.role === 'user' && m.content.startsWith('[DRAFT STATE'));
            assert.ok(draftState.content.includes('data:'), 'draft state carries the data block');
            assert.ok(draftState.content.includes('table tbl_task01 "Tasks" key=tasks rows=7'), draftState.content);
            assert.ok(draftState.content.includes('datasets: ds_stat001'), 'dataset line present');
            const sec = draftState.content.match(/section (sec_[a-z0-9]+)/)[1];
            onEvent('tool_use', {
                id: 'd1', name: 'app_add_components',
                input: {
                    parentId: sec,
                    components: [{
                        type: 'data_grid',
                        props: {
                            source: {
                                kind: 'records', tableId: 'tbl_task01',
                                filter: [{ field: 'created_by', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }],
                                sort: [{ field: 'created_at', dir: 'desc' }],
                            },
                            columns: [{ key: 'title', label: 'Title' }],
                        },
                    }],
                },
            });
            onEvent('tool_use', {
                id: 'd2', name: 'app_set_action',
                input: {
                    action: {
                        kind: 'sequence',
                        steps: [
                            { kind: 'create_record', tableId: 'tbl_task01', values: { title: { kind: 'static', value: 'New task' } } },
                            { kind: 'toast', message: 'Created', tone: 'success' },
                        ],
                    },
                },
            });
            onEvent('done', { prompt_tokens: 100, completion_tokens: 40 });
        },
        // Turn 2 — finalize (must pass the data-aware validation).
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'd3', name: 'app_finalize', input: {} });
        },
    ];

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Wire the grid to tasks', appId: app.id, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    const toolCalls = eventsOf(events, 'tool_call');
    assert.ok(toolCalls.every((e) => e.data.ok), JSON.stringify(toolCalls.map((e) => e.data)));
    const validations = eventsOf(events, 'validation_errors');
    assert.deepStrictEqual(validations[validations.length - 1].data.errors, [], 'data-aware validation is clean');
    const done = eventsOf(events, 'done')[0];
    assert.strictEqual(done.data.finalized, true, JSON.stringify(events.map((e) => e.event)));
    // snapshot summary carries the data footprint
    const row = state.apps.get(app.id);
    assert.ok(row.builderSession.summary.includes('1 table'), row.builderSession.summary);
    assert.ok(row.builderSession.summary.includes('1 dataset'), row.builderSession.summary);
});

test('a binding to a table the app does not have is refused at tool time (binding guard), not one round later', async () => {
    state.adapterCalls = [];
    const app = await mockStudioAppStore.createStudioApp({ userId: 'owner', name: 'Ghost table app' });
    // No data model stubbed for this app → getDataModel null → model "no tables yet".
    state.script = [
        async (messages, options, onEvent) => {
            const draftState = messages.find((m) => m.role === 'user' && m.content.startsWith('[DRAFT STATE'));
            assert.ok(draftState.content.includes('(no tables yet)'), 'empty data block rendered');
            const sec = draftState.content.match(/section (sec_[a-z0-9]+)/)[1];
            onEvent('tool_use', {
                id: 'g1', name: 'app_add_components',
                input: { parentId: sec, components: [{ type: 'table', props: { source: { kind: 'records', tableId: 'tbl_ghost' } } }] },
            });
        },
        async (messages, options, onEvent) => {
            // The refusal — not a validation report one round later — is what
            // the model reads: the binding guard names the table it does not have.
            // Read it the way the model does: the LIVE call's result, parsed.
            // Two traps hid this assert until 2026-09-17: the few-shot examples
            // ahead of the live turn carry role:'tool' messages of their own
            // (ex_* ids), so the first tool message in the list is the LOOKUP
            // shot's app_set_meta echo — and the wire content is JSON, where
            // the quoted id is \"-escaped, so a substring match on the raw
            // string can never fire.
            const refusal = toolResultFor(messages, 'app_add_components');
            assert.ok(refusal && typeof refusal.error === 'string', JSON.stringify(refusal));
            assert.ok(refusal.error.includes('names table "tbl_ghost", which this app does not have'), refusal.error);
            assert.ok(refusal.error.includes('app_link_datatable'), 'the hint names the way in for an existing table');
            onEvent('text', { text: 'I need to link that table first.' });
        },
    ];
    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Bind to a table that does not exist', appId: app.id, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    // A throw inside a scripted round reaches the route as a chat failure and
    // streams as an `error` event — so pin that none did, or the asserts in
    // round 2 are decoration (they were, until 2026-09-17).
    assert.deepStrictEqual(eventsOf(events, 'error'), [], 'both scripted rounds ran clean');
    assert.strictEqual(state.adapterCalls.length, 2, 'the refusal, then the model\'s reply');
    const call = eventsOf(events, 'tool_call')[0].data;
    assert.strictEqual(call.ok, false);
    assert.match(call.error, /tbl_ghost/);
    assert.deepStrictEqual(eventsOf(events, 'validation_errors'), [], 'nothing landed');
    // Nothing was BUILT this turn, so the model's closing prose finalizes
    // nothing: the auto-finalize net acts on a build the model closed, never on
    // a reply that changed nothing.
    assert.strictEqual(eventsOf(events, 'done')[0].data.finalized, false);
    assert.strictEqual(usageEvents[usageEvents.length - 1].stop_reason, 'incomplete');
});

test('a provider failure after a mutation ends the turn unfinalized — the net never runs on a failure', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'nf1', name: 'app_add_screen', input: { name: 'Home', icon: 'Home' } });
            onEvent('done', { prompt_tokens: 100, completion_tokens: 20 });
        },
        async () => { throw new Error('provider exploded'); },
    ];
    const res = await api('POST', '/stream', { user: 'u-net1', body: { message: 'Build a home screen', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    assert.strictEqual(eventsOf(events, 'tool_call')[0].data.ok, true, 'the screen landed before the failure');
    assert.deepStrictEqual(eventsOf(events, 'error').map((e) => e.data.code), ['transient_upstream']);
    // "Please send your message again" and "the app validates — saved" cannot
    // both be true; the draft IS saved (after every mutation), it is just not
    // finalized. Same rule as the automation builder's `!stopReason`.
    assert.strictEqual(eventsOf(events, 'draft').length, 1, 'only the mutation changed the draft');
    assert.strictEqual(eventsOf(events, 'done')[0].data.finalized, false);
    assert.ok(!eventsOf(events, 'message').some((e) => /saved/.test(e.data.content)), 'no "saved" line under the failure');
    assert.strictEqual(usageEvents[usageEvents.length - 1].stop_reason, 'incomplete');
});

// ── Wave 3A: FULL-STACK scripted build (the headline flow) ──────────

test('full-stack scripted build: one prompt → table + seed + dataset + bound grid + sequence → finalize clean, data_model SSE flowing', async () => {
    state.adapterCalls = [];
    dataState.queryRows = [{ status: 'todo', n: 2 }, { status: 'done', n: 1 }];

    state.script = [
        // Turn 1 — create the table (fresh draft: this also creates the app row).
        async (messages, options, onEvent) => {
            const draftState = messages.find((m) => m.role === 'user' && m.content.startsWith('[DRAFT STATE'));
            assert.ok(draftState.content.includes('(no tables yet)'), 'fresh draft has an empty data block');
            onEvent('tool_use', {
                id: 'fs1', name: 'app_upsert_table',
                input: {
                    key: 'tasks', name: 'Tasks',
                    fields: [
                        { key: 'title', type: 'text', required: true },
                        { key: 'status', type: 'select', options: ['todo', 'done'] },
                    ],
                },
            });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 5 });
        },
        // Turn 2 — seed rows against the REAL tbl_… id from the tool result.
        async (messages, options, onEvent) => {
            const table = toolResultFor(messages, 'app_upsert_table');
            assert.ok(table && /^tbl_/.test(table.tableId), `turn 2 sees the table id: ${JSON.stringify(table)}`);
            assert.strictEqual(table.modelVersion, 1);
            onEvent('tool_use', {
                id: 'fs2', name: 'app_seed_records',
                input: {
                    tableId: table.tableId,
                    records: [
                        { title: 'Fix login bug', status: 'todo' },
                        { title: 'Ship v2', status: 'done' },
                        { title: 'Write docs', status: 'todo' },
                    ],
                },
            });
            onEvent('done', { prompt_tokens: 12, completion_tokens: 6 });
        },
        // Turn 3 — dataset + a records-bound grid + a create_record sequence.
        async (messages, options, onEvent) => {
            const table = toolResultFor(messages, 'app_upsert_table');
            const seeded = toolResultFor(messages, 'app_seed_records');
            assert.strictEqual(seeded.inserted, 3, JSON.stringify(seeded));
            assert.ok(seeded.ids.every((id) => id.startsWith('rec_')), 'real rec_ ids for relation seeding');
            const draftState = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[DRAFT STATE'));
            const sec = draftState.content.match(/section (sec_[a-z0-9]+)/)[1];
            onEvent('tool_use', {
                id: 'fs3', name: 'app_upsert_dataset',
                input: {
                    name: 'By status', tableId: table.tableId,
                    descriptor: { groupBy: [{ field: 'status' }], aggregates: [{ fn: 'count', as: 'n' }] },
                },
            });
            onEvent('tool_use', {
                id: 'fs4', name: 'app_add_components',
                input: {
                    parentId: sec,
                    components: [{
                        type: 'data_grid',
                        props: {
                            source: { kind: 'records', tableId: table.tableId, sort: [{ field: 'created_at', dir: 'desc' }] },
                            columns: [{ key: 'title', label: 'Title' }, { key: 'status', label: 'Status' }],
                        },
                    }],
                },
            });
            onEvent('tool_use', {
                id: 'fs5', name: 'app_set_action',
                input: {
                    action: {
                        kind: 'sequence',
                        steps: [
                            { kind: 'create_record', tableId: table.tableId, values: { title: { kind: 'static', value: 'New task' }, status: { kind: 'static', value: 'todo' } } },
                            { kind: 'refresh' },
                        ],
                    },
                },
            });
            onEvent('done', { prompt_tokens: 14, completion_tokens: 8 });
        },
        // Turn 4 — finalize (must pass the data-aware validation with the LIVE model).
        async (messages, options, onEvent) => {
            const ds = toolResultFor(messages, 'app_upsert_dataset');
            assert.ok(ds && ds.datasetId, 'dataset result visible');
            assert.strictEqual(ds.rowCount, 2, 'implicit dry-run preview came back');
            onEvent('tool_use', { id: 'fs6', name: 'app_finalize', input: {} });
        },
    ];

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Build a task tracker with sample data', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    // Every tool call succeeded.
    const toolCalls = eventsOf(events, 'tool_call');
    assert.deepStrictEqual(
        toolCalls.map((e) => [e.data.name, e.data.ok]),
        [
            ['app_upsert_table', true], ['app_seed_records', true],
            ['app_upsert_dataset', true], ['app_add_components', true],
            ['app_set_action', true], ['app_finalize', true],
        ],
        JSON.stringify(toolCalls.map((e) => e.data)),
    );

    // data_model SSE after each data mutation, carrying the live shape.
    const dataEvents = eventsOf(events, 'data_model');
    assert.strictEqual(dataEvents.length, 3, 'one per data-mutating tool (table, seed, dataset)');
    const afterTable = dataEvents[0].data;
    assert.strictEqual(afterTable.modelVersion, 1);
    assert.strictEqual(afterTable.tables.length, 1);
    assert.strictEqual(afterTable.tables[0].key, 'tasks');
    assert.strictEqual(afterTable.tables[0].fieldCount, 2);
    assert.strictEqual(afterTable.tables[0].rowCount, 0);
    const afterSeed = dataEvents[1].data;
    assert.strictEqual(afterSeed.tables[0].rowCount, 3, 'seeded rows visible in the event');
    const afterDataset = dataEvents[2].data;
    assert.strictEqual(afterDataset.datasets.length, 1);
    assert.strictEqual(afterDataset.datasets[0].name, 'By status');

    // The rows really went through the write choke point (INSERTs as owner).
    const inserts = dataState.execCalls.filter((c) => /INSERT INTO "tasks"/.test(c.sql));
    assert.strictEqual(inserts.length, 3, 'exactly the 3 seed rows — no second write path');
    assert.ok(inserts.every((c) => c.ownerId === 'owner'), 'writes run acts-as-owner');

    // Data-aware validation is clean with the LIVE model and finalize succeeded.
    const validations = eventsOf(events, 'validation_errors');
    assert.deepStrictEqual(validations[validations.length - 1].data.errors, [], JSON.stringify(validations));
    const done = eventsOf(events, 'done')[0];
    assert.strictEqual(done.data.finalized, true, JSON.stringify(events.map((e) => e.event)));

    // Persisted end state: model v1, dataset row, session summary with data footprint.
    const appId = done.data.appId;
    assert.ok(dataState.models.get(appId).tables[0].key === 'tasks');
    assert.strictEqual((dataState.datasets.get(appId) || []).length, 1);
    const row = state.apps.get(appId);
    assert.ok(row.builderSession.summary.includes('1 table'), row.builderSession.summary);
    assert.ok(row.builderSession.summary.includes('1 dataset'), row.builderSession.summary);
});

// ── Wave 4: dry-run self-repair loop ────────────────────────────────

test('scripted dry-run loop: 0-rows finding → seed → clean dry-run → finalize', async () => {
    state.adapterCalls = [];
    dataState.queryRows = []; // the bound table starts EMPTY

    state.script = [
        // Turn 1 — create the table (also creates the app row).
        async (messages, options, onEvent) => {
            onEvent('tool_use', {
                id: 'dr1', name: 'app_upsert_table',
                input: { key: 'tasks', name: 'Tasks', fields: [{ key: 'title', type: 'text', required: true }] },
            });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 5 });
        },
        // Turn 2 — bind a grid to the real tbl_ id, into the fresh home section.
        async (messages, options, onEvent) => {
            const table = toolResultFor(messages, 'app_upsert_table');
            assert.ok(table && /^tbl_/.test(table.tableId), JSON.stringify(table));
            const draftState = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[DRAFT STATE'));
            const sec = draftState.content.match(/section (sec_[a-z0-9]+)/)[1];
            onEvent('tool_use', {
                id: 'dr2', name: 'app_add_components',
                input: {
                    parentId: sec,
                    components: [{
                        type: 'table',
                        props: { source: { kind: 'records', tableId: table.tableId, sort: [{ field: 'created_at', dir: 'desc' }] }, columns: [{ key: 'title', label: 'Title' }] },
                    }],
                },
            });
            onEvent('done', { prompt_tokens: 12, completion_tokens: 6 });
        },
        // Turn 3 — dry-run: the grid's table is empty → a 0-rows finding.
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'dr3', name: 'app_dry_run', input: {} });
            onEvent('done', { prompt_tokens: 12, completion_tokens: 6 });
        },
        // Turn 4 — the model sees the empty finding, seeds a row (and the stub
        // DB now returns a row so the NEXT dry-run reflects it).
        async (messages, options, onEvent) => {
            const dry = toolResultFor(messages, 'app_dry_run');
            assert.ok(dry && dry.ok === true, `dry-run never blocks on empty data: ${JSON.stringify(dry)}`);
            assert.strictEqual(dry.emptyTables.length, 1, 'the empty table binding was flagged');
            assert.ok(dry._hints.some((h) => /0 rows/.test(h)), JSON.stringify(dry._hints));
            const table = toolResultFor(messages, 'app_upsert_table');
            dataState.queryRows = [{ id: 'rec_1', title: 'Fix login bug' }];
            onEvent('tool_use', {
                id: 'dr4', name: 'app_seed_records',
                input: { tableId: table.tableId, records: [{ title: 'Fix login bug' }] },
            });
            onEvent('done', { prompt_tokens: 12, completion_tokens: 6 });
        },
        // Turn 5 — dry-run again: now clean (rows present, no empties).
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'dr5', name: 'app_dry_run', input: {} });
            onEvent('done', { prompt_tokens: 12, completion_tokens: 6 });
        },
        // Turn 6 — finalize.
        async (messages, options, onEvent) => {
            const dry = toolResultFor(messages, 'app_dry_run');
            assert.strictEqual(dry.ok, true);
            assert.deepStrictEqual(dry.emptyTables, [], 'the seeded table is no longer empty');
            assert.strictEqual(dry.bindings[0].rowCount, 1);
            onEvent('tool_use', { id: 'dr6', name: 'app_finalize', input: {} });
        },
    ];

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Build a task list and check it before saving', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    const toolCalls = eventsOf(events, 'tool_call');
    assert.deepStrictEqual(
        toolCalls.map((e) => [e.data.name, e.data.ok]),
        [
            ['app_upsert_table', true], ['app_add_components', true],
            ['app_dry_run', true], ['app_seed_records', true],
            ['app_dry_run', true], ['app_finalize', true],
        ],
        JSON.stringify(toolCalls.map((e) => e.data)),
    );
    // The two dry-run tool_call summaries reflect empty → clean.
    const dryCalls = toolCalls.filter((e) => e.data.name === 'app_dry_run');
    assert.match(dryCalls[0].data.summary, /empty/i);
    assert.match(dryCalls[1].data.summary, /clean/i);

    const done = eventsOf(events, 'done')[0];
    assert.strictEqual(done.data.finalized, true, JSON.stringify(events.map((e) => e.event)));
});

// ── Wave 5: plan-first UX, checkpoints, phased generation ───────────

const SAMPLE_PLAN = {
    title: 'Field dispatch',
    summary: 'Dispatch jobs to technicians and track their status.',
    tables: [{ key: 'jobs', name: 'Jobs', fields: [{ key: 'title', type: 'text' }, { key: 'status', type: 'select', options: ['open', 'done'] }] }],
    roles: [{ key: 'admin', label: 'Admin' }, { key: 'tech', label: 'Technician' }],
    screens: [
        { name: 'Dispatch', purpose: 'Admins assign jobs', contents: ['jobs table', 'assign form'], forRoles: ['admin'] },
        { name: 'My jobs', purpose: 'Technicians see their jobs', contents: ['my jobs list'], forRoles: ['tech'] },
    ],
    phases: [{ label: 'Data model', covers: ['jobs table'] }, { label: 'Screens', covers: ['both screens'] }],
};

test('app_propose_plan → plan SSE + done.awaitingPlan, pendingPlan persisted, turn ends', async () => {
    state.adapterCalls = [];
    const app = await mockStudioAppStore.createStudioApp({ userId: 'u-plan', name: 'Planner' });
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'p1', name: 'app_propose_plan', input: SAMPLE_PLAN });
            onEvent('done', { prompt_tokens: 20, completion_tokens: 10 });
        },
        // A second scripted turn must NOT run — proposing ends the turn.
        async (_messages, _options, _onEvent) => {
            throw new Error('the loop should have ended after the plan proposal');
        },
    ];

    const res = await api('POST', '/stream', { user: 'u-plan', body: { message: 'Build a field dispatch app for admins and technicians', appId: app.id, modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    // The plan SSE carries a minted planId + the bounded artifact.
    const plan = eventsOf(events, 'plan')[0];
    assert.ok(plan, 'plan event emitted');
    assert.match(plan.data.planId, /^plan_[0-9a-f]{6}$/, plan.data.planId);
    assert.strictEqual(plan.data.plan.title, 'Field dispatch');
    assert.strictEqual(plan.data.plan.screens.length, 2);

    // The proposing tool call succeeded and the turn ended awaiting approval.
    const proposeCall = eventsOf(events, 'tool_call').find((e) => e.data.name === 'app_propose_plan');
    assert.ok(proposeCall && proposeCall.data.ok, JSON.stringify(proposeCall));
    const done = eventsOf(events, 'done')[0];
    assert.strictEqual(done.data.awaitingPlan, true);
    assert.strictEqual(done.data.finalized, false);
    // The plan turn only ran ONE adapter call (the loop broke).
    assert.strictEqual(state.adapterCalls.length, 1, 'proposing ends the turn');

    // pendingPlan persisted on the session snapshot (top-level, trim-safe).
    const row = state.apps.get(app.id);
    assert.ok(row.builderSession.pendingPlan, 'pendingPlan stored');
    assert.strictEqual(row.builderSession.pendingPlan.planId, plan.data.planId);
    assert.strictEqual(row.builderSession.pendingPlan.plan.title, 'Field dispatch');
});

test('approval turn injects [APPROVED PLAN] and it persists into a follow-up turn (plan amnesia regression)', async () => {
    state.adapterCalls = [];
    const app = await mockStudioAppStore.createStudioApp({ userId: 'u-appr', name: 'Approved app' });
    state.script = [
        // Turn 1 — approval: the model just acknowledges (no finalize) so the
        // approved plan stays active for the next turn.
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Starting the build.' });
            onEvent('done', { prompt_tokens: 20, completion_tokens: 5 });
        },
        // Turn 2 — a normal follow-up (no plan in the body).
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Continuing.' });
            onEvent('done', { prompt_tokens: 20, completion_tokens: 5 });
        },
    ];

    // Approval turn.
    const approve = await api('POST', '/stream', {
        user: 'u-appr',
        body: { appId: app.id, modelTier: 'fast', plan: { planId: 'plan_abc123', action: 'approve', plan: SAMPLE_PLAN } },
    });
    assert.strictEqual(approve.status, 200);
    // The approval turn's prompt carried the [APPROVED PLAN] machine message.
    const t1 = state.adapterCalls[0].messages;
    const approvedT1 = t1.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(APPROVED_PLAN_PREFIX));
    assert.ok(approvedT1, 'approval turn injects [APPROVED PLAN]');
    assert.ok(approvedT1.content.includes('Field dispatch'), 'the approved artifact is in the message');
    // A "before plan" checkpoint was written.
    assert.ok((state.apps.get(app.id).versions || []).some((v) => v.summary === 'AI checkpoint — before plan'), 'before-plan checkpoint saved');
    // approvedPlan persisted on the snapshot.
    assert.ok(state.apps.get(app.id).builderSession.approvedPlan, 'approvedPlan persisted');

    // Follow-up turn — the approved plan must ride again even though the
    // approval message is stripped from cross-turn history (the amnesia bug).
    const follow = await api('POST', '/stream', { user: 'u-appr', body: { appId: app.id, message: 'keep going', modelTier: 'fast' } });
    assert.strictEqual(follow.status, 200);
    const t2 = state.adapterCalls[1].messages;
    const approvedT2 = t2.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(APPROVED_PLAN_PREFIX));
    assert.ok(approvedT2, 'the approved plan is re-rendered on the follow-up turn (no amnesia)');
    assert.ok(approvedT2.content.includes('Field dispatch'));
    // It never leaked into persisted prose history.
    assert.ok(state.apps.get(app.id).builderSession.messages.every((m) => !m.content.startsWith(APPROVED_PLAN_PREFIX)));
});

test('app_mark_phase emits phase + checkpoint SSE and writes a version snapshot', async () => {
    state.adapterCalls = [];
    const app = await mockStudioAppStore.createStudioApp({ userId: 'u-phase', name: 'Phased app' });
    // Prior snapshot carries the approved plan (with phases) so `total` is known.
    await mockStudioAppStore.setBuilderSession(app.id, 'u-phase', {
        sessionId: 'as_phase', appId: app.id, messages: [], approvedPlan: SAMPLE_PLAN,
    });
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'ph1', name: 'app_mark_phase', input: { index: 0, label: 'Data model' } });
            onEvent('text', { text: 'Building the data model.' });
            onEvent('done', { prompt_tokens: 20, completion_tokens: 5 });
        },
    ];
    const res = await api('POST', '/stream', { user: 'u-phase', body: { appId: app.id, message: 'go', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    const phase = eventsOf(events, 'phase')[0];
    assert.ok(phase, 'phase event emitted');
    assert.deepStrictEqual(phase.data, { index: 0, total: 2, label: 'Data model' });
    const checkpoint = eventsOf(events, 'checkpoint').find((c) => c.data.summary === 'AI checkpoint — Data model');
    assert.ok(checkpoint, 'phase checkpoint emitted');
    assert.match(checkpoint.data.versionId, /^ver-/);
    assert.ok((state.apps.get(app.id).versions || []).some((v) => v.summary === 'AI checkpoint — Data model'), 'snapshot row written');
});

test('continueToken turn reuses the persisted tier and skips auto re-resolution', async () => {
    state.adapterCalls = [];
    const app = await mockStudioAppStore.createStudioApp({ userId: 'u-cont', name: 'Continued app' });
    await mockStudioAppStore.setBuilderSession(app.id, 'u-cont', {
        sessionId: 'as_cont', appId: app.id, messages: [],
        continueToken: 'cont_deadbeef', lastTier: 'standard', approvedPlan: SAMPLE_PLAN,
    });
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Resuming the next phase.' });
            onEvent('done', { prompt_tokens: 20, completion_tokens: 5 });
        },
    ];
    const res = await api('POST', '/stream', { user: 'u-cont', body: { appId: app.id, continueToken: 'cont_deadbeef' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    const model = eventsOf(events, 'model_selected')[0];
    assert.strictEqual(model.data.tier, 'standard', 'the persisted tier was reused');

    // A stale/unknown token falls back to normal auto resolution — the most
    // capable configured model, NOT the persisted tier.
    state.tiers = { fast: { modelId: 'claude-haiku-4-5' }, smart: { modelId: 'claude-sonnet-5' } };
    try {
        state.script = [
            async (messages, options, onEvent) => { onEvent('text', { text: 'hi' }); onEvent('done', {}); },
        ];
        const res2 = await api('POST', '/stream', { user: 'u-cont', body: { appId: app.id, message: 'do a thing', continueToken: 'cont_wrong' } });
        assert.strictEqual(res2.status, 200);
        const model2 = eventsOf(parseSSE(res2.text), 'model_selected')[0];
        assert.deepStrictEqual(model2.data, { modelId: 'claude-sonnet-5', tier: 'smart' }, 'unknown token → auto ranking runs');
    } finally {
        state.tiers = DEFAULT_TIERS;
    }
});

// ── Small-model turn hygiene (parity with the automation builder) ──────

// The band profile for `test-model-large` is 'mid' (no small/frontier pattern
// matches); the admin override map is how the demo box makes Gemma 'small'
// at temperature 0.7 — the app route ignored that map until now.
test('builder_model_profiles overrides reach the profile: band, temperature, core tool menu, few-shots every turn', async () => {
    state.adapterCalls = [];
    state.config = { builder_model_profiles: JSON.stringify({ 'test-model-large': { band: 'small', temperature: 0.7 } }) };
    try {
        const app = await mockStudioAppStore.createStudioApp({ userId: 'u-hyg1', name: 'Override app' });
        state.script = [
            async (messages, options, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', { finish_reason: 'stop' }); },
            async (messages, options, onEvent) => { onEvent('text', { text: 'ok again' }); onEvent('done', { finish_reason: 'stop' }); },
        ];
        const r1 = await api('POST', '/stream', { user: 'u-hyg1', body: { message: 'Turn one', appId: app.id, modelTier: 'fast' } });
        assert.strictEqual(r1.status, 200);
        const c1 = state.adapterCalls[0];
        assert.strictEqual(c1.options.temperature, 0.7, 'the configured temperature, not the band default');
        assert.ok(c1.toolNames.includes('app_add_components') && !c1.toolNames.includes('app_screenshot'), 'small band → core tool menu');
        const fewShotsOf = (msgs) => msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => String(tc.id).startsWith('ex_')));
        assert.ok(fewShotsOf(c1.messages).length > 0, 'few-shots on turn 1');

        const r2 = await api('POST', '/stream', { user: 'u-hyg1', body: { message: 'Turn two', appId: app.id, modelTier: 'fast' } });
        assert.strictEqual(r2.status, 200);
        const c2 = state.adapterCalls[1];
        // Small profile: few-shots stay on turn 2 (a cached block), and the
        // prefix is byte-stable — same system prompt, same few-shot block,
        // then turn 1's prose as history, then the single folded user message.
        assert.strictEqual(c2.messages[0].content, c1.messages[0].content, 'system prompt identical across turns');
        const fs1 = fewShotsOf(c1.messages).length;
        assert.strictEqual(fewShotsOf(c2.messages).length, fs1, 'few-shots ride every turn on the small profile');
        const prefixLen = 1 + c1.messages.length - 2; // system + few-shot block (turn 1 had no history)
        assert.deepStrictEqual(c2.messages.slice(0, prefixLen), c1.messages.slice(0, prefixLen), 'turn 2 starts with turn 1\'s exact prefix');
        const hist = c2.messages.slice(prefixLen, -1);
        assert.deepStrictEqual(hist.map((m) => m.role), ['user', 'assistant'], 'then turn 1 as history');
        assert.strictEqual(hist[0].content, 'Turn one', 'history carries the human\'s words only, never the machine notes');
        assert.strictEqual(hist[1].content, 'ok');
        assert.ok(c2.messages[c2.messages.length - 1].content.endsWith('Turn two'));
    } finally {
        state.config = {};
    }
});

test('reasoning effort is resolved ONCE per turn from the tier — "none" stays none after a rejected call', async () => {
    state.adapterCalls = [];
    state.tiers = { fast: { modelId: 'test-model-large', reasoningEffort: 'none' } };
    try {
        state.script = [
            async (messages, options, onEvent) => {
                // A rejected call — the old loop escalated effort on the next round.
                onEvent('tool_use', { id: 'c1', name: 'app_add_components', input: { parentId: 'nope', components: [{ type: 'heading', props: { text: 'x' } }] } });
                onEvent('done', { finish_reason: 'tool_calls' });
            },
            async (messages, options, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', { finish_reason: 'stop' }); },
        ];
        const res = await api('POST', '/stream', { user: 'u-hyg2', body: { message: 'Build', modelTier: 'fast' } });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(state.adapterCalls.length, 2);
        assert.strictEqual(state.adapterCalls[0].options.reasoningEffort, 'none');
        assert.strictEqual(state.adapterCalls[1].options.reasoningEffort, 'none', 'no per-round escalation');
        const events = parseSSE(res.text);
        for (const r of eventsOf(events, 'round_start')) assert.strictEqual(r.data.effort, 'none');
    } finally {
        state.tiers = DEFAULT_TIERS;
    }
});

test('a round cut off at max_tokens without a tool call is retried once, then ends with code:model_truncated', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => { onEvent('text', { text: 'Let me think about' }); onEvent('done', { finish_reason: 'length' }); },
        async (messages, options, onEvent) => {
            // The retry carries the cut-off reply and a plain instruction.
            const tail = messages.slice(-2);
            assert.strictEqual(tail[0].role, 'assistant');
            assert.strictEqual(tail[0].content, 'Let me think about');
            assert.strictEqual(tail[1].role, 'user');
            assert.ok(tail[1].content.startsWith(VALIDATION_NOTE_PREFIX));
            assert.match(tail[1].content, /hit the length limit before it contained a tool call/);
            onEvent('text', { text: 'still thinking' }); onEvent('done', { finish_reason: 'length' });
        },
    ];
    const res = await api('POST', '/stream', { user: 'u-hyg3', body: { message: 'Build', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(state.adapterCalls.length, 2, 'exactly one retry');
    const events = parseSSE(res.text);
    const err = eventsOf(events, 'error')[0];
    assert.ok(err, 'the second cut-off is reported, not a silent done');
    assert.strictEqual(err.data.code, 'model_truncated');
    assert.match(err.data.message, /thinking off/);
    assert.ok(eventsOf(events, 'done').length === 1, 'the turn still closes');
});

test('a cut-off round followed by a real tool call builds on (the retry worked)', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => { onEvent('done', { finish_reason: 'max_tokens' }); },
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'c1', name: 'app_set_meta', input: { name: 'Recovered' } });
            onEvent('done', { finish_reason: 'tool_calls' });
        },
        async (messages, options, onEvent) => { onEvent('text', { text: 'Done.' }); onEvent('done', { finish_reason: 'stop' }); },
    ];
    const res = await api('POST', '/stream', { user: 'u-hyg4', body: { message: 'Build', modelTier: 'fast' } });
    const events = parseSSE(res.text);
    assert.deepStrictEqual(eventsOf(events, 'error'), []);
    assert.ok(eventsOf(events, 'tool_call').some((e) => e.data.name === 'app_set_meta' && e.data.ok));
    // An empty cut-off reply is never replayed as an empty assistant message.
    const retryAssistant = state.adapterCalls[1].messages.slice(-2)[0];
    assert.strictEqual(retryAssistant.role, 'assistant');
    assert.ok(retryAssistant.content.length > 0);
});

test('a permanent 4xx from the provider is code:model_rejected with the provider\'s own words', async () => {
    state.adapterCalls = [];
    state.script = [
        async () => { throw new Error('llamacpp API error 400: {"error":{"message":"roles must alternate between user and assistant"}}'); },
    ];
    const res = await api('POST', '/stream', { user: 'u-hyg5', body: { message: 'Build', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const err = eventsOf(parseSSE(res.text), 'error')[0];
    assert.strictEqual(err.data.code, 'model_rejected');
    assert.match(err.data.message, /HTTP 400/);
    assert.match(err.data.message, /roles must alternate/);
    assert.match(err.data.message, /Resending will not help/);
});

test('a 429 stays transient_upstream (the retry advice is right for it)', async () => {
    state.adapterCalls = [];
    // Transient → streamWithRetry backs off and retries twice before giving up.
    const thrower = async () => { throw new Error('openai API error 429: slow down'); };
    state.script = [thrower, thrower, thrower];
    const res = await api('POST', '/stream', { user: 'u-hyg6', body: { message: 'Build', modelTier: 'fast' } });
    const err = eventsOf(parseSSE(res.text), 'error')[0];
    assert.ok(err, 'error event after the retries');
    assert.strictEqual(err.data.code, 'transient_upstream');
});

test('streamed tool arguments become tool_draft events (the card being typed), prefill chunks become prompt_progress', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('prompt_progress', { total: 1000, cache: 800, processed: 200, time_ms: 300 });
            onEvent('prompt_progress', { total: 1000, cache: 800, processed: 1000, time_ms: 900 });
            const args = { parentId: 'nope', components: [{ type: 'kpi', props: { label: 'Totaal' } }, { type: 'data_grid', props: { title: 'Facturen' } }] };
            const json = JSON.stringify(args);
            onEvent('tool_args_delta', { name: 'app_add_components', partial: json.slice(0, 60) });
            onEvent('tool_args_delta', { name: 'app_add_components', partial: json });
            onEvent('tool_use', { id: 'c1', name: 'app_add_components', input: args });
            onEvent('done', { finish_reason: 'tool_calls', prompt_tokens: 1000, completion_tokens: 40, timings: { prompt_n: 200, cache_n: 800, predicted_per_second: 12.5 } });
        },
        async (messages, options, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', { finish_reason: 'stop' }); },
    ];
    const res = await api('POST', '/stream', { user: 'u-draft1', body: { message: 'Build', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    const drafts = eventsOf(events, 'tool_draft');
    assert.ok(drafts.length >= 1, 'at least one tool_draft');
    const last = drafts[drafts.length - 1].data;
    assert.strictEqual(last.name, 'app_add_components');
    assert.strictEqual(last.iter, 0);
    assert.strictEqual(last.parentId, 'nope');
    assert.deepStrictEqual(last.items.map((i) => i.type), ['stat', 'data_grid'], 'kpi previews as stat');
    assert.deepStrictEqual(last.items.map((i) => i.label), ['Totaal', 'Facturen']);
    const progress = eventsOf(events, 'prompt_progress');
    assert.ok(progress.length >= 1);
    assert.deepStrictEqual(progress[progress.length - 1].data, { iter: 0, total: 1000, cache: 800, processed: 1000, timeMs: 900 }, 'the completing chunk always passes');
    // The rejected call names the problem and its hint on the wire.
    const call = eventsOf(events, 'tool_call')[0].data;
    assert.strictEqual(call.ok, false);
    assert.match(call.error, /Unknown parentId/);
    assert.ok(typeof call.hint === 'string' && call.hint.length > 0);
    assert.strictEqual(call.added, undefined, 'nothing landed');
    // llama.cpp timings ride the usage event verbatim.
    const usage = eventsOf(events, 'usage')[0].data;
    assert.deepStrictEqual(usage.timings, { prompt_n: 200, cache_n: 800, predicted_per_second: 12.5 });
});

test('the same refused call three rounds running ends the turn with a plain message (rung 3 of the ladder)', async () => {
    state.adapterCalls = [];
    const bad = { parentId: 'sec_nope', components: [{ type: 'heading', props: { text: 'x' } }] };
    const again = async (messages, options, onEvent) => {
        onEvent('tool_use', { id: `c${messages.length}`, name: 'app_add_components', input: bad });
        onEvent('done', { finish_reason: 'tool_calls' });
    };
    state.script = [again, again, again, async (m, o, onEvent) => { onEvent('text', { text: 'never reached' }); onEvent('done', {}); }];
    const res = await api('POST', '/stream', { user: 'u-ladder1', body: { message: 'Add a heading', modelTier: 'fast' } });
    const events = parseSSE(res.text);
    const calls = eventsOf(events, 'tool_call');
    assert.strictEqual(calls.length, 3, 'three refusals, then the route stops');
    assert.strictEqual(state.adapterCalls.length, 3, 'no fourth model call');
    const msg = eventsOf(events, 'message').find((e) => /three times/.test(e.data.content));
    assert.ok(msg, 'the user is told in plain words');
    assert.match(msg.data.content, /Add components: Unknown parentId/);
    assert.strictEqual(eventsOf(events, 'done').length, 1);
});

test('the same TOOL refused four rounds running with DIFFERENT arguments ends the turn too (rung 3b — measured 2026-09-13: 20 rounds of one refusal)', async () => {
    state.adapterCalls = [];
    let n = 0;
    const varied = async (messages, options, onEvent) => {
        n += 1;
        // A new (unknown) parent id every round: never an identical resend, so rung 3 never fires.
        onEvent('tool_use', { id: `v${n}`, name: 'app_add_components', input: { parentId: `sec_nope_${n}`, components: [{ type: 'heading', props: { text: `x${n}` } }] } });
        onEvent('done', { finish_reason: 'tool_calls' });
    };
    state.script = [varied, varied, varied, varied, varied, async (m, o, onEvent) => { onEvent('text', { text: 'never reached' }); onEvent('done', {}); }];
    const res = await api('POST', '/stream', { user: 'u-ladder2', body: { message: 'Add a heading', modelTier: 'fast' } });
    const events = parseSSE(res.text);
    assert.strictEqual(eventsOf(events, 'tool_call').length, 4, 'four refusals, then the route stops');
    assert.strictEqual(state.adapterCalls.length, 4, 'no fifth model call');
    const msg = eventsOf(events, 'message').find((e) => /4 times in a row/.test(e.data.content));
    assert.ok(msg, 'the user is told in plain words');
    assert.match(msg.data.content, /Add components/);
    assert.strictEqual(eventsOf(events, 'done').length, 1);
});

// ── Wave 6c: observability (usage metrics + SSE error taxonomy) ─────

test('logs exactly ONE studio_app_builder usage event per turn, with token fields', async () => {
    state.adapterCalls = [];
    usageEvents.length = 0;
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'ux1', name: 'app_add_screen', input: { name: 'Home', icon: 'Home' } });
            onEvent('done', { prompt_tokens: 100, completion_tokens: 20 });
        },
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Done.' });
            onEvent('done', { prompt_tokens: 50, completion_tokens: 10 });
        },
    ];

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Build a home screen', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);

    assert.strictEqual(usageEvents.length, 1, `exactly one usage row: ${JSON.stringify(usageEvents)}`);
    const ev = usageEvents[0];
    assert.strictEqual(ev.agent_type, 'studio_app_builder');
    assert.strictEqual(ev.source, 'studio_app_builder');
    assert.strictEqual(ev.model, 'test-model-large');
    assert.strictEqual(ev.user_id, 'owner');
    // Tokens accumulate across BOTH rounds of the turn.
    assert.strictEqual(ev.prompt_tokens, 150);
    assert.strictEqual(ev.completion_tokens, 30);
    assert.strictEqual(ev.total_tokens, 180);
    assert.strictEqual(typeof ev.duration_ms, 'number');
    // Outcome folds into stop_reason (no metadata column). The model built a
    // screen and closed on prose without app_finalize, so the route's net
    // finalized the validating draft — still one row, and the token counts
    // above are the two model rounds only: the finalize calls no model.
    assert.strictEqual(ev.stop_reason, 'finalized');
    // The turn created an app row → agent_id + conversation_id carry the ids.
    assert.ok(ev.agent_id && ev.conversation_id, JSON.stringify(ev));
});

test('a chat failure emits an SSE error with code:transient_upstream (+ still logs usage)', async () => {
    state.adapterCalls = [];
    usageEvents.length = 0;
    state.script = [
        // A throw without an HTTP status makes streamWithRetry give up
        // immediately (no backoff) — the route keeps the transient wording for
        // anything it cannot prove permanent.
        async () => { throw new Error('provider exploded'); },
    ];

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Build something', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    const err = eventsOf(events, 'error')[0];
    assert.ok(err, 'error event emitted');
    assert.strictEqual(err.data.code, 'transient_upstream');
    assert.ok(err.data.message, 'error carries a user message');
    // A failed turn still records one usage row (the done finalization path).
    assert.strictEqual(usageEvents.length, 1, JSON.stringify(usageEvents));
    assert.strictEqual(usageEvents[0].agent_type, 'studio_app_builder');
});

test('an internal stream failure emits code:internal WITHOUT the exception message', async () => {
    state.adapterCalls = [];
    usageEvents.length = 0;
    state.script = [
        async (messages, options, onEvent) => { onEvent('text', { text: 'Done.' }); onEvent('done', {}); },
    ];
    // An infrastructure failure carrying connection details — nothing of it may
    // reach the client.
    state.usageThrows = 'ECONNREFUSED postgres://beeflow:s3cr3t@10.1.2.3:5432/beeflow_core';

    const res = await api('POST', '/stream', { user: 'owner', body: { message: 'Build something', modelTier: 'fast' } });
    state.usageThrows = null;
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    const err = eventsOf(events, 'error')[0];
    assert.ok(err, 'error event emitted');
    assert.strictEqual(err.data.code, 'internal');
    assert.ok(err.data.message, 'the client still gets a user-facing line');
    assert.ok(
        !/ECONNREFUSED|postgres|s3cr3t|10\.1\.2\.3/i.test(err.data.message),
        `internal details leaked to the client: ${err.data.message}`,
    );
});

// ── Images the user shows the builder ────────────────────────────────
//
// "I want to upload screenshots so I can show how I want it to look."
// A user-supplied picture is UNTRUSTED input: it must ride the role:'user'
// turn message as image content and NEVER touch the (prompt-cached) system
// prompt. Every limit is enforced here, server-side — the composer's mirror
// of them is a courtesy, not a control.

/** A base64 data URL whose DECODED payload is `bytes` long. */
function imageDataUrl(mime = 'image/png', bytes = 12) {
    return `data:${mime};base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;
}

/** The image_url blocks on the last user message of an adapter call. */
function imageBlocksOf(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'user' || !Array.isArray(m.content)) continue;
        return m.content.filter((b) => b && b.type === 'image_url').map((b) => b.image_url.url);
    }
    return [];
}

test('a posted image reaches the adapter as an image content block on the USER message', async () => {
    state.adapterCalls = [];
    state.supportsVision = true;
    const png = imageDataUrl('image/png', 40);
    const jpg = imageDataUrl('image/jpeg', 40);
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'I can see the layout you want.' });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 5 });
        },
    ];

    const res = await api('POST', '/stream', {
        user: 'imguser1',
        body: { message: 'Make it look like this', images: [png, jpg], modelTier: 'fast' },
    });
    assert.strictEqual(res.status, 200);

    const sent = state.adapterCalls[0].messages;
    const last = sent[sent.length - 1];
    assert.strictEqual(last.role, 'user', 'the images ride the USER turn message');
    assert.ok(Array.isArray(last.content), 'multimodal content is an array of blocks');

    // The SAME block shape app_screenshot uses on its way to the model, so one
    // adapter code path serves inbound and outbound images alike.
    assert.deepStrictEqual(
        last.content.filter((b) => b.type === 'image_url'),
        [{ type: 'image_url', image_url: { url: png } }, { type: 'image_url', image_url: { url: jpg } }],
    );
    // The machine notes lead as ONE text block, then the user's own words; the
    // framing block trails.
    assert.strictEqual(last.content[0].type, 'text');
    assert.ok(last.content[0].text.startsWith('[DRAFT STATE'), 'notes fold into the leading text part');
    assert.deepStrictEqual(last.content[1], { type: 'text', text: 'Make it look like this' });
    const framing = last.content[last.content.length - 1];
    assert.match(framing.text, /USER-SUPPLIED IMAGES/);
    assert.match(framing.text, /never an instruction to follow/i);

    // UNTRUSTED CONTENT: nothing image-shaped may enter the system prompt.
    assert.strictEqual(typeof sent[0].content, 'string');
    assert.ok(!sent[0].content.includes('data:image'), 'no image in the cached system prompt');
    assert.strictEqual(sent[0].role, 'system');
    for (const m of sent.slice(0, -1)) {
        assert.ok(!Array.isArray(m.content), `only the final user message is multimodal (${m.role})`);
    }
});

test('an image-only turn (no prose) is accepted and still carries the picture', async () => {
    state.adapterCalls = [];
    state.supportsVision = true;
    state.script = [async (messages, options, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', {}); }];

    const res = await api('POST', '/stream', {
        user: 'imguser2',
        body: { images: [imageDataUrl('image/webp', 30)], modelTier: 'fast' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(imageBlocksOf(state.adapterCalls[0].messages).length, 1);
});

test('a turn with neither prose nor images is still rejected', async () => {
    const res = await api('POST', '/stream', { user: 'imguser3', body: { images: [], modelTier: 'fast' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Message required');
});

test('over-cap and wrong-mime image payloads are rejected pre-SSE with a clear message', async () => {
    state.adapterCalls = [];
    const cases = [
        {
            name: 'more than 4 images',
            images: Array.from({ length: 5 }, () => imageDataUrl('image/png', 12)),
            match: /at most 4 images/i,
        },
        {
            name: 'a single image over 5 MB',
            images: [imageDataUrl('image/png', 6 * 1024 * 1024)],
            match: /under 5 MB/i,
        },
        {
            // Each one is legal on its own; together they are not. Sized so the
            // base64 body still fits inside the app's 20mb parser limit — the
            // route's message must be what the user sees, not a raw 413.
            name: 'four images over the per-turn total',
            images: Array.from({ length: 4 }, () => imageDataUrl('image/png', 3.5 * 1024 * 1024)),
            match: /more than 12 MB together/i,
        },
        {
            name: 'a disallowed image type (SVG — a script vector, not a screenshot)',
            images: [imageDataUrl('image/svg+xml', 12)],
            match: /PNG, JPEG, WebP or GIF/i,
        },
        {
            name: 'a non-image mime dressed as an attachment',
            images: [imageDataUrl('text/html', 12)],
            match: /PNG, JPEG, WebP or GIF/i,
        },
        {
            name: 'a remote URL instead of inline bytes (SSRF surface)',
            images: ['https://evil.example.com/pixel.png'],
            match: /not a readable image/i,
        },
        {
            name: 'a non-base64 data URL',
            images: ['data:image/png,%3Cscript%3E'],
            match: /not a readable image/i,
        },
        { name: 'not a list at all', images: 'data:image/png;base64,AAAA', match: /list of image data URLs/i },
    ];

    for (const c of cases) {
        const res = await api('POST', '/stream', {
            user: 'imguser4',
            body: { message: 'Build this', images: c.images, modelTier: 'fast' },
        });
        assert.strictEqual(res.status, 400, `${c.name}: expected a 400, got ${res.status}`);
        assert.ok(res.contentType.includes('application/json'), `${c.name}: rejection stays clean JSON (no SSE)`);
        assert.strictEqual(res.body.code, 'invalid_image', c.name);
        assert.match(res.body.error, c.match, c.name);
    }
    assert.strictEqual(state.adapterCalls.length, 0, 'no rejected payload ever reached the model');
});

test('the trusted mime comes from the data-URL header, never a client-declared field', async () => {
    state.adapterCalls = [];
    state.supportsVision = true;
    state.script = [async (messages, options, onEvent) => { onEvent('text', { text: 'ok' }); onEvent('done', {}); }];

    // Object form with a LYING mimeType next to an allowed header…
    const res = await api('POST', '/stream', {
        user: 'imguser5',
        body: {
            message: 'Look',
            images: [{ dataUrl: imageDataUrl('image/png', 12), mimeType: 'application/x-shockwave-flash' }],
            modelTier: 'fast',
        },
    });
    assert.strictEqual(res.status, 200, 'the header is what counts, and it is a PNG');
    assert.strictEqual(imageBlocksOf(state.adapterCalls[0].messages).length, 1);

    // …and the mirror image: an allowed client field over a banned header.
    const bad = await api('POST', '/stream', {
        user: 'imguser5',
        body: {
            message: 'Look',
            images: [{ dataUrl: imageDataUrl('application/pdf', 12), mimeType: 'image/png' }],
            modelTier: 'fast',
        },
    });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /PNG, JPEG, WebP or GIF/i);
});

test('a NON-VISION model degrades loudly: no image blocks, a machine note, and the user is told in-stream', async () => {
    state.adapterCalls = [];
    state.supportsVision = false;
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('text', { text: 'Tell me what the screenshot shows.' });
            onEvent('done', {});
        },
    ];

    const res = await api('POST', '/stream', {
        user: 'imguser6',
        body: { message: 'Make it look like this', images: [imageDataUrl('image/png', 40)], modelTier: 'fast' },
    });
    state.supportsVision = true;
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);

    // The user hears about it plainly — never a silent drop.
    const notice = eventsOf(events, 'message').find((e) => /can't see images/i.test(e.data.content || ''));
    assert.ok(notice, `expected an in-stream warning, got: ${JSON.stringify(eventsOf(events, 'message'))}`);
    assert.match(notice.data.content, /ignored/i);
    assert.match(notice.data.content, /vision-capable/i);

    // The model gets a note instead of the picture, and no base64 anywhere.
    const sent = state.adapterCalls[0].messages;
    assert.deepStrictEqual(imageBlocksOf(sent), []);
    const note = sent.find((m) => typeof m.content === 'string' && m.content.includes(IMAGE_NOTE_PREFIX));
    assert.ok(note, 'a machine note tells the blind model an image was attached');
    assert.strictEqual(note.role, 'user', 'the note is a user message, never system (prompt-cache discipline)');
    assert.match(note.content, /Do not pretend to have seen/i);
    for (const m of sent) {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        assert.ok(!text.includes('data:image'), 'no image bytes reach a blind model');
    }
    // The turn's own words close the single user message.
    assert.ok(sent[sent.length - 1].content.endsWith('\n\nMake it look like this'));
});

test('images leave a trace in the persisted history but never their bytes', async () => {
    state.adapterCalls = [];
    state.supportsVision = true;
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'i1', name: 'app_add_screen', input: { name: 'Home' } });
            onEvent('done', {});
        },
        async (messages, options, onEvent) => { onEvent('text', { text: 'Built it.' }); onEvent('done', {}); },
    ];

    const res = await api('POST', '/stream', {
        user: 'imguser7',
        body: { message: 'Build this screen', images: [imageDataUrl('image/gif', 24)], modelTier: 'fast' },
    });
    const appId = eventsOf(parseSSE(res.text), 'done')[0].data.appId;
    const snapshot = state.apps.get(appId).builderSession;

    const userTurn = snapshot.messages.find((m) => m.role === 'user');
    assert.strictEqual(typeof userTurn.content, 'string', 'the snapshot stays string-only');
    assert.match(userTurn.content, /attached 1 image on this turn/);
    assert.ok(!JSON.stringify(snapshot).includes('data:image'), 'no base64 in the 64KB-trimmed snapshot');
});

test('sanitizeInboundImages normalises the accepted shapes and strips nothing else', () => {
    const png = imageDataUrl('image/png', 9);
    assert.deepStrictEqual(sanitizeInboundImages(undefined), { images: [] });
    assert.deepStrictEqual(sanitizeInboundImages(null), { images: [] });
    assert.deepStrictEqual(sanitizeInboundImages([]), { images: [] });

    // Bare string and { dataUrl } object normalise to the same record.
    const fromString = sanitizeInboundImages([png]).images[0];
    const fromObject = sanitizeInboundImages([{ dataUrl: png }]).images[0];
    assert.deepStrictEqual(fromString, fromObject);
    assert.strictEqual(fromString.mimeType, 'image/png');
    assert.strictEqual(fromString.dataUrl, png);

    // An UPPERCASE header mime is accepted and lowercased.
    const upper = sanitizeInboundImages([png.replace('image/png', 'IMAGE/PNG')]);
    assert.strictEqual(upper.images[0].mimeType, 'image/png');

    // Byte accounting is exact (base64 padding included).
    assert.strictEqual(base64ByteLength('AAAA'), 3);
    assert.strictEqual(base64ByteLength('AAA='), 2);
    assert.strictEqual(base64ByteLength('AA=='), 1);
    for (const mime of IMAGE_MIME_ALLOWLIST) {
        assert.strictEqual(sanitizeInboundImages([imageDataUrl(mime, 6)]).images.length, 1, mime);
    }
    assert.strictEqual(MAX_IMAGES_PER_TURN, 4);
    assert.strictEqual(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
});

test('sanitizeHistory strips the [IMAGE NOTE] machine message', () => {
    const kept = sanitizeHistory([
        { role: 'user', content: 'Make it look like this' },
        { role: 'user', content: `${IMAGE_NOTE_PREFIX}\nThe human attached 1 image…` },
        { role: 'assistant', content: 'I cannot see images.' },
        // Multimodal turns never round-trip through history: content must be a string.
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ]);
    assert.deepStrictEqual(kept, [
        { role: 'user', content: 'Make it look like this' },
        { role: 'assistant', content: 'I cannot see images.' },
    ]);
});

// ── A tool call the model WROTE instead of made (core/llm/leakedToolCalls) ──
// Verbatim shape from the 2026-09-13 trace (Gemma 4, Fast tier): the whole
// round was this text inside the thought channel — no content, no tool call,
// stop='stop'. The turn used to end there in silence.
const GEMMA_LEAK = '<|tool_call>call:app_set_meta{name:<|">Invoice Tracker<|">,description:<|">Invoices from "all" suppliers<|">}<tool_call|>';
const thinkOut = (onEvent, text) => {
    onEvent('thinking_start', { partId: 't0' });
    onEvent('thinking', { partId: 't0', text });
    onEvent('thinking_stop', { partId: 't0' });
};

test('a tool call written as text in the thinking is parsed, run and marked recovered — the model reads the hint in its result', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => { thinkOut(onEvent, GEMMA_LEAK); onEvent('done', { finish_reason: 'stop' }); },
        async (messages, options, onEvent) => {
            // The next round sees a well-formed assistant tool call + its result,
            // exactly as if the model had called it — that is what teaches it.
            const assistant = messages[messages.length - 2];
            const toolMsg = messages[messages.length - 1];
            assert.strictEqual(assistant.role, 'assistant');
            assert.strictEqual(assistant.tool_calls.length, 1);
            assert.strictEqual(assistant.tool_calls[0].function.name, 'app_set_meta');
            assert.match(assistant.tool_calls[0].id, /^leak_\d+_0$/);
            assert.deepStrictEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { name: 'Invoice Tracker', description: 'Invoices from "all" suppliers' });
            assert.strictEqual(toolMsg.role, 'tool');
            assert.strictEqual(toolMsg.tool_call_id, assistant.tool_calls[0].id);
            assert.match(toolMsg.content, /written as TEXT inside your reasoning/);
            onEvent('text', { text: 'Named it.' }); onEvent('done', { finish_reason: 'stop' });
        },
    ];
    const res = await api('POST', '/stream', { user: 'u-leak1', body: { message: 'Build', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    assert.deepStrictEqual(eventsOf(events, 'error'), []);
    const call = eventsOf(events, 'tool_call').find((e) => e.data.name === 'app_set_meta');
    assert.ok(call, 'the written call ran');
    assert.strictEqual(call.data.ok, true);
    assert.strictEqual(call.data.recovered, 'thinking');
    assert.match(call.data.summary, /Invoice Tracker/);
    assert.ok(eventsOf(events, 'draft').length >= 1, 'the mutation persisted and streamed');
    assert.strictEqual(state.adapterCalls.length, 2);
});

test('a round with neither a tool call nor text is nudged once, then ends with code:model_empty_reply instead of a silent done', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => { thinkOut(onEvent, 'Hmm.'); onEvent('done', { finish_reason: 'stop' }); },
        async (messages, options, onEvent) => {
            const [a, u] = messages.slice(-2);
            assert.strictEqual(a.role, 'assistant');
            assert.match(a.content, /neither a tool call nor a message/);
            assert.strictEqual(u.role, 'user');
            assert.ok(u.content.startsWith(VALIDATION_NOTE_PREFIX));
            assert.match(u.content, /contained no tool call and no message/);
            assert.doesNotMatch(u.content, /written out as text/, 'nothing was written as text this time');
            onEvent('done', { finish_reason: 'stop' });
        },
    ];
    const res = await api('POST', '/stream', { user: 'u-leak2', body: { message: 'Build', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(state.adapterCalls.length, 2, 'exactly one nudge');
    const events = parseSSE(res.text);
    const err = eventsOf(events, 'error')[0];
    assert.ok(err, 'the second empty round is reported');
    assert.strictEqual(err.data.code, 'model_empty_reply');
    assert.match(err.data.message, /draft is saved/);
    assert.strictEqual(eventsOf(events, 'done').length, 1);
});

test('a written call the server cannot run (name off the menu) is named in the nudge; a real call after it builds on', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => { thinkOut(onEvent, '<|tool_call>call:app_make_table{name:<|">x<|">}<tool_call|>'); onEvent('done', { finish_reason: 'stop' }); },
        async (messages, options, onEvent) => {
            const note = messages[messages.length - 1];
            assert.match(note.content, /`app_make_table` is not a tool on this menu/);
            assert.match(note.content, /function-calling interface/);
            onEvent('tool_use', { id: 'c1', name: 'app_set_meta', input: { name: 'Recovered' } });
            onEvent('done', { finish_reason: 'tool_calls' });
        },
        async (messages, options, onEvent) => { onEvent('text', { text: 'Done.' }); onEvent('done', { finish_reason: 'stop' }); },
    ];
    const res = await api('POST', '/stream', { user: 'u-leak3', body: { message: 'Build', modelTier: 'fast' } });
    const events = parseSSE(res.text);
    assert.deepStrictEqual(eventsOf(events, 'error'), []);
    const call = eventsOf(events, 'tool_call').find((e) => e.data.name === 'app_set_meta');
    assert.ok(call && call.data.ok);
    assert.strictEqual(call.data.recovered, undefined, 'a call the model really made is not marked');
});

test('a final message with no tool call still ends the turn normally (the empty-reply guard never fires on real prose)', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => { thinkOut(onEvent, 'Nothing to change.'); onEvent('text', { text: 'The app already has that.' }); onEvent('done', { finish_reason: 'stop' }); },
    ];
    const res = await api('POST', '/stream', { user: 'u-leak4', body: { message: 'Build', modelTier: 'fast' } });
    const events = parseSSE(res.text);
    assert.deepStrictEqual(eventsOf(events, 'error'), []);
    assert.strictEqual(state.adapterCalls.length, 1, 'no nudge');
    assert.strictEqual(eventsOf(events, 'done').length, 1);
});

// ── 2026-09-13: the duplicate batch and the plan resend ──────────────────────
test('a components batch that already landed is refused as "Nothing new"; the third resend ends the turn with the duplicate wording, not "refused"', async () => {
    state.adapterCalls = [];
    const batch = (tempId) => ({
        parentId: 'HOME',
        components: [{ type: 'card', props: { title: 'Add a contact' }, style: { span: 6 }, children: [{ tempId, type: 'form', props: { name: 'contact', submitLabel: 'Save' }, children: [{ type: 'input_text', props: { name: 'name', label: 'Name' } }] }] }],
    });
    const homeOf = (messages) => {
        // The section id is in the draft state the route folded into the user
        // message (the few-shots carry sentinel sec_ ids of their own).
        const draftState = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[DRAFT STATE'));
        const m = draftState ? /section (sec_[a-z0-9]+)/.exec(draftState.content) : null;
        return m ? m[1] : 'sec_missing';
    };
    const send = (tempId, debris) => async (messages, options, onEvent) => {
        onEvent('tool_use', { id: `c${messages.length}`, name: 'app_add_components', input: { ...batch(tempId), parentId: homeOf(messages), ...(debris || {}) } });
        onEvent('done', { finish_reason: 'tool_calls' });
    };
    state.script = [
        send('frm'),
        send('frm', { type: 'section', style: { span: 12 } }),
        send('frm_real'),
        send('frm_real', { children: [] }),
        async (m, o, onEvent) => { onEvent('text', { text: 'never reached' }); onEvent('done', {}); },
    ];
    const res = await api('POST', '/stream', { user: 'u-dup1', body: { message: 'Add the contact form', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    const calls = eventsOf(events, 'tool_call');
    assert.strictEqual(calls.length, 4, 'one landing, three duplicates');
    assert.strictEqual(calls[0].data.ok, true);
    for (const c of calls.slice(1)) {
        assert.strictEqual(c.data.ok, false);
        assert.match(c.data.error, /^Nothing new: /);
        assert.match(c.data.hint, /^Reject reason: duplicate batch/);
    }
    assert.strictEqual(state.adapterCalls.length, 4, 'the route stops after the third duplicate — no fifth model call');
    const drafts = eventsOf(events, 'draft');
    assert.strictEqual(drafts.length, 1, 'only the landing changed the draft');
    // A stop is the ROUTE ending the turn, not the model saying it is done: no
    // auto-finalize, and no "saved" line under the sentence that says it stuck.
    assert.strictEqual(eventsOf(events, 'done')[0].data.finalized, false);
    assert.ok(!eventsOf(events, 'message').some((e) => /validates — saved/.test(e.data.content)));
    const msg = eventsOf(events, 'message').find((e) => /added those components once/.test(e.data.content));
    assert.ok(msg, `the duplicate wording, not "refused": ${JSON.stringify(eventsOf(events, 'message').map((e) => e.data.content))}`);
    assert.match(msg.data.content, /they are in the app once \(card cmp_/);
    assert.ok(!/refused it each time/.test(msg.data.content));
    assert.strictEqual(eventsOf(events, 'done').length, 1);
});

test('an identical app_set_plan resend keeps the ticks the build earned and sends no second plan event', async () => {
    state.adapterCalls = [];
    const todos = [{ text: 'Name the app' }, { text: 'Add the Home screen' }, { text: 'Finalize' }];
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'p1', name: 'app_set_plan', input: { todos } });
            onEvent('tool_use', { id: 'p2', name: 'app_set_meta', input: { name: 'Planned app' } });
            onEvent('done', { finish_reason: 'tool_calls' });
        },
        async (messages, options, onEvent) => {
            // The route ticked "Name the app" off the meta call; the model resends its list verbatim.
            onEvent('tool_use', { id: 'p3', name: 'app_set_plan', input: { todos } });
            onEvent('done', { finish_reason: 'tool_calls' });
        },
        async (messages, options, onEvent) => {
            const echo = JSON.parse(messages[messages.length - 1].content);
            assert.strictEqual(echo.todos[0].done, true, 'the resend did not reset the tick');
            assert.match(echo.note, /Plan unchanged — these items were already recorded; done flags kept/);
            onEvent('text', { text: 'ok' }); onEvent('done', { finish_reason: 'stop' });
        },
    ];
    const res = await api('POST', '/stream', { user: 'u-plan2', body: { message: 'Plan it', modelTier: 'fast' } });
    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.text);
    const plans = eventsOf(events, 'plan').filter((e) => Array.isArray(e.data.todos));
    // First list, then the tick from the meta call — and NOTHING for the resend.
    assert.strictEqual(plans.length, 2, JSON.stringify(plans.map((p) => p.data.todos)));
    assert.deepStrictEqual(plans[1].data.todos.map((t) => t.done), [true, false, false]);
    assert.strictEqual(state.adapterCalls.length, 3);
});

test('"only a dashboard" in the brief caps the screens the model can add: the second app_add_screen is refused with the screen to build on', async () => {
    state.adapterCalls = [];
    state.script = [
        async (messages, options, onEvent) => {
            onEvent('tool_use', { id: 'c1', name: 'app_add_screen', input: { name: 'Dashboard' } });
            onEvent('tool_use', { id: 'c2', name: 'app_add_screen', input: { name: 'Invoice detail' } });
            onEvent('done', { finish_reason: 'tool_calls' });
        },
        async (messages, options, onEvent) => {
            const refused = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
            state.screenCapToolMessages = refused;
            onEvent('text', { text: 'Done.' }); onEvent('done', { finish_reason: 'stop' });
        },
    ];
    const res = await api('POST', '/stream', { user: 'u-screencap', body: { message: '## Build a dashboard app\n1. `app_link_datatable {datatableId:"tbl_x"}`.\n**SCREENS (binding, from the person\'s own words "only a data insight dashboard"): exactly ONE screen — never add a second screen.**', modelTier: 'fast' } });
    const events = parseSSE(res.text);
    assert.deepStrictEqual(eventsOf(events, 'error'), []);
    const calls = eventsOf(events, 'tool_call').filter((e) => e.data.name === 'app_add_screen');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].data.ok, true);
    assert.strictEqual(calls[1].data.ok, false);
    assert.match(String(calls[1].data.error), /A screen "Invoice detail" was not added/);
    // The refusal reached the model as a tool result naming the evidence.
    assert.ok((state.screenCapToolMessages || []).some((c) => /exactly 1 screen/.test(c) && /SCREENS \(binding/.test(c)), (state.screenCapToolMessages || []).join('\n'));
});
