/**
 * Route tests for POST /api/studio/ai/route (routes/studio/aiRoute.js).
 *
 * Every dependency is injected through createAiRouteRouter(deps) — including
 * the model client and the resolver — so no DB, no provider and no key is
 * touched; requests go over real HTTP against express app.listen(0).
 *
 * What is pinned is the CONTRACT:
 *   - a gated kind is never in the enum the MODEL is given (the gating reaches
 *     the vocabulary, not only the answer afterwards),
 *   - a gate that cannot answer puts its kind in `undecided` and NOT in
 *     `available` — unknown narrows, and "none" and "unknown" stay two shapes,
 *   - the gate is MAY CREATE: the three kinds whose create route carries a
 *     permission (agent, kb, skill) disappear for a caller who lacks it, even
 *     though two of them are perfectly visible to that same caller,
 *   - a model that answers with a kind this caller may not build is refused
 *     (502), never passed through,
 *   - no model → 503 no_model; unusable structured → 502 ai_unusable; broken
 *     companions are dropped rather than repaired,
 *   - empty text → 400 no_text, long text is clamped at MAX_TEXT_CHARS,
 *   - the payload that leaves for the provider carries the caller's text and
 *     the kind catalogue and NOTHING that identifies anybody (BFSF-441),
 *   - one usage row per call,
 *   - and the rate limiter sits BEFORE the handler.
 *
 * Run: node --test --test-reporter=tap routes/studio/aiRoute.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const {
    createAiRouteRouter, ROUTE_KIND_KEYS, MAX_TEXT_CHARS, MAX_COMPANIONS,
    buildRouteTool, buildRouteMessages, parseRouteAnswer,
} = require('./aiRoute');

// Everything that identifies the caller. Nothing on this list may appear in
// what is sent to the provider.
const USER = {
    id: 'u1',
    organizationId: 'orgA',
    name: 'Tom Smit',
    email: 'tom@example.test',
};
const ORG_NAME = 'Acme Roofing BV';

const GOOD_ANSWER = {
    kind: 'automation',
    name: 'Factuur-herinnering',
    seed: 'Stuur elke maandag een herinnering voor openstaande facturen.',
    companions: [{ kind: 'datatable', name: 'Facturen', why: 'om de openstaande rijen te bewaren' }],
};

// ── A fully-open, fully-populated fake dependency set ───────────────────────
function makeDeps(overrides = {}) {
    const calls = { chat: [], usage: [], gates: [] };
    const deps = {
        _calls: calls,
        modules: { isModuleActive: async (id) => { calls.gates.push(`module:${id}`); return true; } },
        license: { featureAllowedForRequest: async () => ({ allowed: true, resolution: {} }) },
        entitlements: { hasCapability: async () => true },
        permissions: { hasPermission: async () => true },
        configStore: { getConfig: async () => null },
        modelResolver: {
            resolveModelForTier: async () => 'fast-model-1',
            resolveModelWithGlobalFallback: async () => 'fast-model-2',
        },
        llmClient: {
            chatForcedTool: async (modelId, messages, toolDef, options) => {
                calls.chat.push({ modelId, messages, toolDef, options });
                return { structured: { ...GOOD_ANSWER }, usage: { prompt_tokens: 11, completion_tokens: 7 } };
            },
        },
        usageStore: { logUsage: async (row) => { calls.usage.push(row); } },
    };
    return Object.assign(deps, overrides);
}

// ── Server harness ──────────────────────────────────────────────────────────
let server;
let baseUrl;
let deps;

function mount(nextDeps) {
    deps = nextDeps;
    const app = express();
    app.use(express.json());
    // The real mount sits behind requireAuth; here a header stands in for the
    // session so an unauthenticated request can be exercised too. The session
    // carries the caller's identity, exactly as the real one does — that is
    // what makes the BFSF-441 assertion below mean something.
    app.use((req, _res, next) => {
        const who = req.headers['x-test-user'];
        req.session = who
            ? { isAuthenticated: true, user: { ...USER, id: who }, organizationName: ORG_NAME }
            : {};
        next();
    });
    app.use('/api/studio', createAiRouteRouter(deps));
    return app;
}

async function listen(app) {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
});

const post = (body = { text: 'stuur elke maandag een factuurherinnering' }, user = 'u1') => fetch(
    `${baseUrl}/api/studio/ai/route`,
    {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
        body: JSON.stringify(body),
    },
);

const enumOfLastCall = () => deps._calls.chat.at(-1).toolDef.function.parameters.properties.kind.enum;

// ── The happy path ──────────────────────────────────────────────────────────

test('classifies the text and hands back kind, name, seed and companions', async () => {
    await listen(mount(makeDeps()));
    const res = await post();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'private, no-store');
    const body = await res.json();
    assert.strictEqual(body.kind, 'automation');
    assert.strictEqual(body.name, 'Factuur-herinnering');
    assert.strictEqual(body.seed, GOOD_ANSWER.seed);
    assert.deepStrictEqual(body.companions, [{ kind: 'datatable', name: 'Facturen', why: 'om de openstaande rijen te bewaren' }]);
    assert.deepStrictEqual(body.available, [...ROUTE_KIND_KEYS]);
    assert.deepStrictEqual(body.undecided, []);
    // Fast tier, one call, the options the plan fixes.
    assert.strictEqual(deps._calls.chat.length, 1);
    assert.strictEqual(deps._calls.chat[0].modelId, 'fast-model-1');
    assert.deepStrictEqual(deps._calls.chat[0].options, { maxTokens: 600, temperature: 0.2 });
});

// ── The gates decide the vocabulary ─────────────────────────────────────────

test('a gated kind is not in the enum the model is given, and cannot come back', async () => {
    await listen(mount(makeDeps({
        entitlements: { hasCapability: async (capId) => capId !== 'app_studio' },
    })));
    const body = await (await post()).json();
    assert.ok(!body.available.includes('app'), 'app must not be available');
    assert.deepStrictEqual(body.undecided, []);
    const kinds = enumOfLastCall();
    assert.ok(!kinds.includes('app'), 'the model must never see a kind this caller may not build');
    assert.ok(kinds.includes('automation'));
    // The companion schema is narrowed by the same list.
    const companionEnum = deps._calls.chat.at(-1).toolDef.function.parameters.properties.companions.items.properties.kind.enum;
    assert.ok(!companionEnum.includes('app'));
});

test('a whole module being off drops every kind behind it', async () => {
    await listen(mount(makeDeps({
        modules: { isModuleActive: async (id) => id !== 'automation' },
        // The model must still answer with something that IS available.
        llmClient: {
            chatForcedTool: async (modelId, messages, toolDef) => {
                deps._calls.chat.push({ modelId, messages, toolDef });
                return { structured: { kind: 'kb', name: 'Handboek', seed: 'Verzamel de handleidingen.' }, usage: {} };
            },
        },
    })));
    const body = await (await post()).json();
    for (const gone of ['automation', 'form', 'datatable']) {
        assert.ok(!body.available.includes(gone), `${gone} must be gone with the automation module`);
        assert.ok(!enumOfLastCall().includes(gone));
    }
    assert.strictEqual(body.kind, 'kb');
});

test('a gate that cannot answer puts the kind in `undecided`, never in `available`', async () => {
    // resolveCapabilitySet reporting `degraded` is the GateUndecidable path in
    // shared.js — the entitlement snapshot could not be read.
    await listen(mount(makeDeps({
        entitlements: { resolveCapabilitySet: async () => ({ degraded: true, has: () => true }) },
    })));
    const body = await (await post()).json();
    // app, webpage, skill and solution all resolve through capability().
    for (const key of ['app', 'webpage', 'skill', 'solution']) {
        assert.ok(body.undecided.includes(key), `${key} must be reported as undecided`);
        assert.ok(!body.available.includes(key), `${key} must NOT be available when unknown`);
        assert.ok(!enumOfLastCall().includes(key), `${key} must not reach the model`);
    }
    // …and the kinds whose gates DID answer are unaffected.
    assert.ok(body.available.includes('automation'));
});

test('a degraded permission lookup makes agent undecided rather than absent', async () => {
    await listen(mount(makeDeps({
        permissions: { hasPermission: async () => false, isPermissionLookupDegraded: () => true },
    })));
    const body = await (await post()).json();
    assert.ok(body.undecided.includes('agent'));
    assert.ok(!body.available.includes('agent'));
});

test('a plain refusal is NOT undecided — "none" and "unknown" stay two shapes', async () => {
    await listen(mount(makeDeps({
        permissions: { hasPermission: async () => false, isPermissionLookupDegraded: () => false },
    })));
    const body = await (await post()).json();
    assert.ok(!body.available.includes('agent'));
    assert.deepStrictEqual(body.undecided, []);
});

// ── The gate is "may CREATE", not "may see" ─────────────────────────────────
//
// The three kinds whose create route carries a permission of its own. Gating
// these on the LIST gate (which is what counts.js needs) hands an ordinary
// member a card saying "New Knowledge base: Quotes" with a live button, and
// then creates nothing and says nothing.

test('kb and skill need the permission their CREATE route enforces, not their list gate', async () => {
    await listen(mount(makeDeps({
        // Everything else wide open: only the org-role permissions say no.
        permissions: { hasPermission: async () => false, isPermissionLookupDegraded: () => false },
        llmClient: {
            chatForcedTool: async (modelId, messages, toolDef) => {
                deps._calls.chat.push({ modelId, messages, toolDef });
                return { structured: { kind: 'automation', name: 'Herinnering', seed: 'Stuur een herinnering.' }, usage: {} };
            },
        },
    })));
    const body = await (await post()).json();
    for (const gone of ['kb', 'skill', 'agent']) {
        assert.ok(!body.available.includes(gone), `${gone} needs a create permission this caller lacks`);
        assert.ok(!enumOfLastCall().includes(gone), `${gone} must not even be a word the model may answer`);
    }
    // A plain "no" is not "unknown", and the kinds with no create permission
    // at all are untouched.
    assert.deepStrictEqual(body.undecided, []);
    assert.deepStrictEqual(body.available, ['automation', 'form', 'datatable', 'app', 'webpage', 'solution']);
});

test('a permission the caller HAS puts kb and skill back', async () => {
    await listen(mount(makeDeps({
        permissions: { hasPermission: async (_u, perm) => perm === 'manage_knowledge' || perm === 'manage_skills' },
    })));
    const body = await (await post()).json();
    assert.ok(body.available.includes('kb'));
    assert.ok(body.available.includes('skill'));
    assert.ok(!body.available.includes('agent'), 'manage_agents is still refused');
});

test('a degraded permission lookup makes kb and skill undecided, never quietly available', async () => {
    await listen(mount(makeDeps({
        permissions: { hasPermission: async () => false, isPermissionLookupDegraded: () => true },
    })));
    const body = await (await post()).json();
    for (const key of ['kb', 'skill', 'agent']) {
        assert.ok(body.undecided.includes(key), `${key} must be undecided when the permission lookup is degraded`);
        assert.ok(!body.available.includes(key), `${key} must NOT be available when unknown`);
        assert.ok(!enumOfLastCall().includes(key));
    }
});

test('with nothing available the model is never called and the answer says so', async () => {
    await listen(mount(makeDeps({
        modules: { isModuleActive: async () => false },
        entitlements: { hasCapability: async () => false },
        permissions: { hasPermission: async () => false },
        llmClient: {
            chatForcedTool: async (modelId, messages, toolDef) => {
                deps._calls.chat.push({ modelId, messages, toolDef });
                return { structured: { kind: 'kb', name: 'Handboek', seed: 'Verzamel de handleidingen.' }, usage: {} };
            },
        },
    })));
    const res = await post();
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.available, []);
    assert.deepStrictEqual(body.undecided, []);
    assert.strictEqual(body.kind, null);
    assert.strictEqual(deps._calls.chat.length, 0, 'no kinds means no question to ask');
});

test('an empty availability set answers kind:null without touching the model', async () => {
    // EVERY gate undecidable — reachable over HTTP now that no kind is
    // hard-coded open: `available` empty with a FULL `undecided` is the shape
    // the screen must read as "we could not find out", not as "you have none".
    await listen(mount(makeDeps({
        modules: { isModuleActive: async () => { throw new Error('module status unreadable'); } },
        license: { featureAllowedForRequest: async () => ({ allowed: false, resolution: { error: 'tier_unavailable' } }) },
        entitlements: { resolveCapabilitySet: async () => ({ degraded: true, has: () => true }) },
        permissions: { hasPermission: async () => false, isPermissionLookupDegraded: () => true },
    })));
    const body = await (await post()).json();
    assert.deepStrictEqual(body.available, []);
    assert.deepStrictEqual(body.undecided, [...ROUTE_KIND_KEYS]);
    assert.strictEqual(body.kind, null);
    assert.strictEqual(deps._calls.chat.length, 0);
    // …and the pure helpers agree: an empty vocabulary offers the model
    // nothing, and nothing it could invent survives the re-check.
    const tool = buildRouteTool([]);
    assert.deepStrictEqual(tool.function.parameters.properties.kind.enum, []);
    assert.strictEqual(parseRouteAnswer(GOOD_ANSWER, { available: [] }), null);
});

// ── The model's answer is untrusted ─────────────────────────────────────────

test('a kind the caller may not build is refused with 502, not passed through', async () => {
    await listen(mount(makeDeps({
        entitlements: { hasCapability: async (capId) => capId !== 'app_studio' },
        llmClient: {
            chatForcedTool: async () => ({ structured: { kind: 'app', name: 'Portaal', seed: 'Bouw een portaal.' }, usage: {} }),
        },
    })));
    const res = await post();
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).code, 'ai_unusable');
});

test('unusable structured output is 502 ai_unusable, never half an answer', async () => {
    for (const structured of [null, {}, { kind: 'automation' }, { kind: 'automation', name: 'X' }, { kind: 'automation', name: '  ', seed: 'x' }, { kind: 'nope', name: 'X', seed: 'y' }, []]) {
        await listen(mount(makeDeps({
            llmClient: { chatForcedTool: async () => ({ structured, usage: {} }) },
        })));
        const res = await post();
        assert.strictEqual(res.status, 502, `structured ${JSON.stringify(structured)} must be refused`);
        assert.strictEqual((await res.json()).code, 'ai_unusable');
    }
});

test('broken companion entries are DROPPED, the rest of the answer survives', async () => {
    await listen(mount(makeDeps({
        entitlements: { hasCapability: async (capId) => capId !== 'app_studio' },
        llmClient: {
            chatForcedTool: async () => ({
                structured: {
                    kind: 'automation',
                    name: 'Herinnering',
                    seed: 'Stuur een herinnering.',
                    companions: [
                        { kind: 'app', name: 'Portaal' },            // gated → out
                        { kind: 'datatable' },                       // no name → out
                        'nonsense',                                  // not an object → out
                        { kind: 'datatable', name: 'Facturen' },     // keeper
                        { kind: 'kb', name: 'Handboek', why: 'x' },  // keeper
                    ],
                },
                usage: {},
            }),
        },
    })));
    const body = await (await post()).json();
    assert.strictEqual(body.kind, 'automation');
    assert.deepStrictEqual(body.companions, [
        { kind: 'datatable', name: 'Facturen', why: '' },
        { kind: 'kb', name: 'Handboek', why: 'x' },
    ]);
});

test('companions are capped at MAX_COMPANIONS and names are clamped', () => {
    const parsed = parseRouteAnswer({
        kind: 'kb',
        name: `${'n'.repeat(500)}`,
        seed: 'iets',
        companions: Array.from({ length: 9 }, (_, i) => ({ kind: 'kb', name: `kb ${i}` })),
    }, { available: ['kb'] });
    assert.strictEqual(parsed.companions.length, MAX_COMPANIONS);
    assert.strictEqual(parsed.name.length, 120);
});

// ── Model availability ──────────────────────────────────────────────────────

test('no model configured is 503 no_model — and nothing is invented instead', async () => {
    await listen(mount(makeDeps({
        modelResolver: {
            resolveModelForTier: async () => null,
            resolveModelWithGlobalFallback: async () => null,
        },
    })));
    const res = await post();
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await res.json()).code, 'no_model');
    assert.strictEqual(deps._calls.chat.length, 0);
});

test('a throwing tier resolver falls through to the global fallback', async () => {
    await listen(mount(makeDeps({
        modelResolver: {
            resolveModelForTier: async () => { throw new Error('no tier'); },
            resolveModelWithGlobalFallback: async () => 'fast-model-2',
        },
    })));
    assert.strictEqual((await post()).status, 200);
    assert.strictEqual(deps._calls.chat[0].modelId, 'fast-model-2');
});

// ── Input ───────────────────────────────────────────────────────────────────

test('empty or whitespace-only text is 400 no_text, before any model call', async () => {
    await listen(mount(makeDeps()));
    for (const body of [{}, { text: '' }, { text: '   \n ' }, { text: null }]) {
        const res = await post(body);
        assert.strictEqual(res.status, 400, `body ${JSON.stringify(body)}`);
        assert.strictEqual((await res.json()).code, 'no_text');
    }
    assert.strictEqual(deps._calls.chat.length, 0);
});

test('text is clamped at MAX_TEXT_CHARS', async () => {
    await listen(mount(makeDeps()));
    const long = 'a'.repeat(MAX_TEXT_CHARS + 500);
    assert.strictEqual((await post({ text: long })).status, 200);
    const sent = JSON.stringify(deps._calls.chat[0].messages);
    assert.ok(sent.includes('a'.repeat(MAX_TEXT_CHARS)), 'the whole allowance is sent');
    assert.ok(!sent.includes('a'.repeat(MAX_TEXT_CHARS + 1)), 'and not one character more');
});

test('an unauthenticated request is refused before any gate or model call', async () => {
    await listen(mount(makeDeps()));
    const res = await fetch(`${baseUrl}/api/studio/ai/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'iets' }),
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(deps._calls.chat.length, 0);
    assert.deepStrictEqual(deps._calls.gates, []);
});

// ── BFSF-441: what leaves the building ──────────────────────────────────────

test('the provider payload carries the text and the catalogue and NO identity', async () => {
    await listen(mount(makeDeps()));
    await post({ text: 'ik wil facturen bijhouden' });
    const sent = JSON.stringify(deps._calls.chat[0].messages);

    // (a) the caller's own text, (b) the kinds they may build. Nothing else.
    assert.ok(sent.includes('ik wil facturen bijhouden'));
    assert.ok(sent.includes('automation:'));

    for (const secret of [USER.id, USER.organizationId, USER.name, USER.email, ORG_NAME]) {
        assert.ok(!sent.includes(secret), `identity leaked into the prompt: ${secret}`);
    }
    // Allow-list, not a filtered context object: the builder takes two
    // arguments and there is nothing else it could pass on.
    assert.strictEqual(buildRouteMessages.length, 2);
    const direct = JSON.stringify(buildRouteMessages('mijn tekst', ['kb']));
    assert.ok(direct.includes('mijn tekst'));
    assert.ok(!direct.includes('orgA') && !direct.includes('u1'));
});

// ── Usage ───────────────────────────────────────────────────────────────────

test('one usage row per call, with the model, the tokens and the org', async () => {
    await listen(mount(makeDeps()));
    await post();
    assert.strictEqual(deps._calls.usage.length, 1);
    const row = deps._calls.usage[0];
    assert.strictEqual(row.user_id, 'u1');
    assert.strictEqual(row.agent_name, 'studio-router');
    assert.strictEqual(row.agent_type, 'system');
    assert.strictEqual(row.source, 'studio_ai_route');
    assert.strictEqual(row.model, 'fast-model-1');
    assert.strictEqual(row.prompt_tokens, 11);
    assert.strictEqual(row.completion_tokens, 7);
    assert.strictEqual(row.total_tokens, 18);
    assert.strictEqual(row.organization_id, 'orgA');
    assert.ok(Number.isFinite(row.duration_ms));
});

test('a failing usage store never fails the request', async () => {
    await listen(mount(makeDeps({
        usageStore: { logUsage: async () => { throw new Error('usage db down'); } },
    })));
    assert.strictEqual((await post()).status, 200);
});

test('a refused answer is still logged — the tokens were spent either way', async () => {
    await listen(mount(makeDeps({
        llmClient: { chatForcedTool: async () => ({ structured: null, usage: { total_tokens: 5 } }) },
    })));
    assert.strictEqual((await post()).status, 502);
    assert.strictEqual(deps._calls.usage.length, 1);
});

// ── The rate limiter ────────────────────────────────────────────────────────

test('the limiter sits BEFORE the handler: the 11th call in a minute is 429', async () => {
    await listen(mount(makeDeps()));
    const codes = [];
    for (let i = 0; i < 11; i += 1) codes.push((await post()).status);
    assert.deepStrictEqual(codes.slice(0, 10), Array(10).fill(200));
    assert.strictEqual(codes[10], 429);
    // Ten model calls, not eleven — the brake is in front of the spend.
    assert.strictEqual(deps._calls.chat.length, 10);
});

// ── A failure inside the handler ────────────────────────────────────────────

test('a throwing model client is a 500, not an empty card', async () => {
    await listen(mount(makeDeps({
        llmClient: { chatForcedTool: async () => { throw new Error('provider down'); } },
    })));
    const res = await post();
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.ok(!('kind' in body));
});
