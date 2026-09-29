/**
 * The `ai_step_model` override, and the two things execAi.js does with it.
 *
 * The pure decision (`aiStepOverrideFor`) is exercised directly. The three
 * claims that used to be regexes over execAi.js and the admin route are now
 * driven: the override reaches the adapter as the model id, every model call
 * carries a reasoning setting, and the admin route round-trips the key.
 *
 * execAi.js is real here — only the provider, the tier map, the tool catalog
 * and the two stores it writes to are cut at the require seam, so the module
 * under test is the code that ships.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/aiStepModel.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.NODE_ENV = 'test';


// ── What the seams answer this run ───────────────────────────────────
const fx = {
    /** Config rows both the override resolver and the admin route read. */
    config: {},
    /** The tier catalog the step resolves against. */
    tiers: { fast: { modelId: 'tier-fast-model', maxTokens: 2048 } },
    /** Tools offered to a step with allowTools. */
    catalogTools: [],
    /** What the tool dispatcher returns for an integration action. */
    toolResult: { rows: [] },
    /** Every adapter.chat call this run. */
    calls: [],
};

const configStoreStub = {
    getConfig: async (k) => (k in fx.config ? fx.config[k] : null),
    setConfig: async (k, v) => { fx.config[k] = v; },
    getAllConfig: async () => ({ ...fx.config }),
};
// aiStepModel.js's own read, and the admin route's — the real resolver is
// part of what is under test, so only the store below it is replaced.
const csPath = require.resolve('../../stores/configStore');
require.cache[csPath] = { id: csPath, filename: csPath, loaded: true, exports: configStoreStub };

const { aiStepOverrideFor, AI_STEP_MODEL_KEY, DEFAULT_TIERS } = require('./aiStepModel');

const EXEC_AI_MOCKS = {
    '../aiAgent': {
        getProviderForModel: async () => ({ providerType: 'claude', url: 'https://x', apiKey: 'k' }),
        getAIConfig: async () => ({ model: 'global-fallback-model' }),
    },
    '../providers': {
        getAdapter: () => ({
            chat: async (apiKey, url, modelId, messages, options) => {
                fx.calls.push({ modelId, options });
                return { content: '{"a":"b"}' };
            },
        }),
    },
    '../llm/modelResolver': { getUserTierMap: async () => fx.tiers },
    '../entitlements/userTiers': { getPermittedTierKeys: async () => null },
    '../integrations/integrationTools': { getIntegrationTools: async () => ({ tools: fx.catalogTools }) },
    '../tools/toolDispatcher': { executeTool: async () => fx.toolResult },
    '../integrations/integrationToolMap': { resolveIntegration: () => null },
    '../../stores/usageStore': { recordUsage: async () => {}, logUsage: async () => {} },
    '../../stores/terminationStore': { isTerminated: async () => false },
};

const ROUTE_MOCKS = {
    './shared': { isAdminUser: async () => true },
    '../../../auth/permissions': { requireAuth: (req, res, next) => next(), getUserPermissions: async () => ({}) },
    '../../../core/aiAgent': { getProviderForModel: async (id) => ({ providerType: 'claude', modelId: id }) },
};

function install(tag, ownerRe, mocks) {
    const ids = {};
    for (const [request, exportsObj] of Object.entries(mocks)) {
        const id = `mock:${tag}:${request}`;
        ids[request] = id;
        require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
    }
    return { ownerRe, ids };
}
const INSTALLED = [
    install('ai-step-exec', /automationRunner[\\/]execAi\.js$/, EXEC_AI_MOCKS),
    install('ai-step-route', /config[\\/]modelTiers\.js$/, ROUTE_MOCKS),
];
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    for (const { ownerRe, ids } of INSTALLED) {
        if (parent && ownerRe.test(parent.filename) && Object.prototype.hasOwnProperty.call(ids, request)) return ids[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { execAiStep, execIntegrationAction } = require('./execAi');
const modelTiersRouter = require('../../routes/ai/config/modelTiers');

test.after(() => { Module._resolveFilename = originalResolve; });

function reset() {
    for (const k of Object.keys(fx.config)) delete fx.config[k];
    fx.tiers = { fast: { modelId: 'tier-fast-model', maxTokens: 2048 } };
    fx.catalogTools = [];
    fx.toolResult = { rows: [] };
    fx.calls.length = 0;
}

/** Run one ai_step and hand back the single adapter.chat call it made. */
async function runAiStep(step = {}, ctxOverrides = {}) {
    const full = { id: 's1', type: 'ai_step', prompt: 'summarise the invoice', ...step };
    const ctx = { userId: 'u1', orgId: null, session: {}, definition: { steps: [full] }, ...ctxOverrides };
    const out = await execAiStep(full, ctx, {}, 'live');
    assert.equal(fx.calls.length, 1, 'expected exactly one model call');
    return { out, call: fx.calls[0] };
}

// ═══ 1. The pure decision ════════════════════════════════════════

test('unset config → never an override, whatever the tier', () => {
    for (const configured of [null, undefined, '', '   ', 42, {}]) {
        assert.equal(aiStepOverrideFor({ configured, requestedTier: 'auto' }), null);
        assert.equal(aiStepOverrideFor({ configured, requestedTier: 'fast' }), null);
    }
});

test('a configured model replaces the default tiers only', () => {
    const configured = ' lfm2-1.2b-extract ';
    assert.equal(aiStepOverrideFor({ configured, requestedTier: 'auto' }), 'lfm2-1.2b-extract');
    assert.equal(aiStepOverrideFor({ configured, requestedTier: 'fast' }), 'lfm2-1.2b-extract');
    // No tier on the step is the builder's "auto".
    assert.equal(aiStepOverrideFor({ configured, requestedTier: undefined }), 'lfm2-1.2b-extract');
    assert.equal(aiStepOverrideFor({ configured, requestedTier: '' }), 'lfm2-1.2b-extract');
});

test('an explicit heavier or custom tier keeps the author\'s choice', () => {
    const configured = 'lfm2-1.2b-extract';
    for (const tier of ['thinking', 'pro', 'writer', 'standard', 'deep_thinking', 'custom:abc', 'swarm']) {
        assert.equal(aiStepOverrideFor({ configured, requestedTier: tier }), null, tier);
    }
});

test('the key and the default-tier set are the documented ones', () => {
    assert.equal(AI_STEP_MODEL_KEY, 'ai_step_model');
    assert.deepEqual([...DEFAULT_TIERS].sort(), ['auto', 'fast']);
});

// ═══ 2. What the step actually runs on ═══════════════════════════

test('with the override set, a default-tier step calls the override model', async () => {
    reset();
    fx.config[AI_STEP_MODEL_KEY] = 'lfm2-1.2b-extract';
    const { call } = await runAiStep({ modelTier: 'fast' });
    assert.equal(call.modelId, 'lfm2-1.2b-extract', 'the override must win over the tier\'s model');
});

test('with the override set, an auto step skips the classifier and still runs on the override', async () => {
    reset();
    fx.config[AI_STEP_MODEL_KEY] = 'lfm2-1.2b-extract';
    const { call, out } = await runAiStep({ modelTier: 'auto' });
    assert.equal(call.modelId, 'lfm2-1.2b-extract');
    assert.equal(out._tier, 'fast', 'no classification round — the default tier is assumed');
});

test('with the override set, a heavier tier still runs on its own model', async () => {
    reset();
    fx.config[AI_STEP_MODEL_KEY] = 'lfm2-1.2b-extract';
    fx.tiers.thinking = { modelId: 'tier-thinking-model', maxTokens: 32_000 };
    const { call } = await runAiStep({ modelTier: 'thinking' });
    assert.equal(call.modelId, 'tier-thinking-model');
});

test('without the override the tier decides, and its token ceiling travels with it', async () => {
    reset();
    fx.tiers.thinking = { modelId: 'tier-thinking-model', maxTokens: 32_000 };
    const fast = await runAiStep({ modelTier: 'fast' });
    assert.equal(fast.call.modelId, 'tier-fast-model');
    assert.equal(fast.call.options.maxTokens, 2048);

    reset();
    fx.tiers.thinking = { modelId: 'tier-thinking-model', maxTokens: 32_000 };
    const thinking = await runAiStep({ modelTier: 'thinking' });
    assert.equal(thinking.call.modelId, 'tier-thinking-model');
    assert.equal(thinking.call.options.maxTokens, 32_000, 'an author who picked thinking must get its ceiling too');
});

// ═══ 3. Every model call tells the model whether to think ════════
//
// It never did: the options were { maxTokens, temperature } only, so a
// thinking-capable local model decided for itself. qwen3.5-9b spent the Fast
// tier's whole 2048-token budget reasoning and returned an EMPTY answer, which
// the step reported as "asked for JSON … answered with something else" with
// nothing after the colon (2026-09-12).

test('a schema step asks for no thinking at all', async () => {
    reset();
    const { call } = await runAiStep({ modelTier: 'fast', outputSchema: { total: 'string' } });
    assert.equal(call.options.reasoningEffort, 'none',
        'a schema-shaped extraction has nothing to deliberate about, and reasoning eats the answer\'s budget');
});

test('a schema INFERRED from downstream bindings counts the same', async () => {
    reset();
    const aiStep = { id: 's1', type: 'ai_step', prompt: 'extract', modelTier: 'fast' };
    const consumer = { id: 's2', type: 'notify', inputs: { body: { kind: 'ref', path: 'steps.s1.output.total' } } };
    const ctx = { userId: 'u1', orgId: null, session: {}, definition: { steps: [aiStep, consumer] } };
    await execAiStep(aiStep, ctx, {}, 'live');
    assert.equal(fx.calls[0].options.reasoningEffort, 'none');
});

test('the tier\'s own setting wins over the schema default', async () => {
    reset();
    fx.tiers.thinking = { modelId: 'tier-thinking-model', maxTokens: 32_000, reasoningEffort: 'high' };
    const { call } = await runAiStep({ modelTier: 'thinking', outputSchema: { total: 'string' } });
    assert.equal(call.options.reasoningEffort, 'high');
});

test('a free-text step with a silent tier sends no reasoning key at all', async () => {
    reset();
    const { call } = await runAiStep({ modelTier: 'fast' });
    assert.ok(!('reasoningEffort' in call.options),
        'no tier setting and no schema means the provider default, not an invented one');
});

test('the tools path carries the same setting as the plain path', async () => {
    reset();
    fx.catalogTools = [{ type: 'function', function: { name: 'gmail_search', parameters: {} } }];
    const { call } = await runAiStep({ modelTier: 'fast', allowTools: true, outputSchema: { total: 'string' } });
    assert.ok(Array.isArray(call.options.tools) && call.options.tools.length === 1, 'the tools path was not taken');
    assert.equal(call.options.reasoningEffort, 'none');
});

// ═══ 4. A dry run must not pass a step that cannot run ═══════════
//
// The old rule was "in dry run, a soft { error } is not a failure", so the
// builder could finalise a routine whose steps referenced `loop.f.path` with
// no forEach anywhere: every iteration answered {error:"path is required"} and
// the dry run reported green (2026-09-12). Now only an ENVIRONMENT error keeps
// the sample fallback — an unconnected app is still plannable.

const STEP_FAULTS = [
    'path is required',
    'values must be an object mapping column titles to values',
    'Unknown column(s) in this table: btw, vdate. Available columns: Datum, Leverancier',
    'Unknown triggerStepId "trg2"',
    'tableId is required',
];
const ENVIRONMENT_FAULTS = [
    'Nextcloud is not connected for this account.',
    'Your Nextcloud session has expired.',
    'The Bee Flow connector could not reach Nextcloud.',
    'Nextcloud Tables is not installed or the table does not exist.',
    'No access token for this user',
    'Permission denied',
];

test('the classifier tells a step\'s own fault from the environment', () => {
    const { isEnvironmentToolError } = require('./shared');
    for (const msg of STEP_FAULTS) assert.equal(isEnvironmentToolError(msg), false, `step error misread as environment: ${msg}`);
    for (const msg of ENVIRONMENT_FAULTS) assert.equal(isEnvironmentToolError(msg), true, `environment error misread as step fault: ${msg}`);
    assert.equal(isEnvironmentToolError(undefined), false);
    assert.equal(isEnvironmentToolError({ error: 'x' }), false, 'only a string is classified');
});

// A READ-ONLY tool: a side-effecting one never reaches the dispatcher in a
// dry run at all (it is synthesised one gate earlier), so it could not show
// which error the carve-out below accepts.
function runIntegrationStep(mode) {
    const step = { id: 'i1', type: 'integration_action', tool: 'gmail_search', inputs: {} };
    const ctx = {
        userId: 'u1', orgId: null, session: {}, definition: { steps: [step] },
        allowedToolNames: new Set(['gmail_search']),
    };
    return execIntegrationAction(step, ctx, {}, mode);
}

test('a dry run FAILS on the step\'s own fault — no more green on a routine that cannot run', async () => {
    for (const error of STEP_FAULTS) {
        reset();
        fx.toolResult = { error };
        await assert.rejects(
            () => runIntegrationStep('dry_run'),
            (e) => e.toolError === true && String(e.message).includes(error),
            `"${error}" must fail the dry run`,
        );
    }
});

test('a dry run still samples past an environment fault — an unconnected app stays plannable', async () => {
    for (const error of ENVIRONMENT_FAULTS) {
        reset();
        fx.toolResult = { error };
        const out = await runIntegrationStep('dry_run');
        assert.equal(out.dryRunSynthesised, true, `"${error}" should have fallen back to a sample`);
        assert.equal(out.dryRunFallback, 'not_connected');
    }
});

test('a LIVE run fails on either kind — the carve-out is the dry run\'s alone', async () => {
    for (const error of [...STEP_FAULTS, ...ENVIRONMENT_FAULTS]) {
        reset();
        fx.toolResult = { error };
        await assert.rejects(() => runIntegrationStep('live'), (e) => e.toolError === true, error);
    }
});

// ═══ 5. The admin route the override is set from ═════════════════

test('the admin route reads and writes the same config key the runner resolves', async () => {
    reset();
    const routeFor = (method, path) => {
        const layer = modelTiersRouter.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
        assert.ok(layer, `${method.toUpperCase()} ${path} is no longer mounted`);
        const handlers = layer.route.stack.map(s => s.handle);
        return handlers[handlers.length - 1];
    };
    const call = async (handler, req) => {
        let body = null; let status = 200;
        const res = { json: (b) => { body = b; return res; }, status: (s) => { status = s; return res; } };
        await handler(req, res);
        return { status, body };
    };

    const get = routeFor('get', '/config/ai-step-model');
    assert.deepEqual((await call(get, { session: {} })).body, { modelId: null }, 'unset reads as null');

    const post = routeFor('post', '/config/ai-step-model');
    const saved = await call(post, { session: {}, body: { modelId: 'lfm2-1.2b-extract' } });
    assert.equal(saved.body.success, true);
    assert.deepEqual((await call(get, { session: {} })).body, { modelId: 'lfm2-1.2b-extract' });

    // And that is exactly the key the step resolves against: the same store
    // the route wrote to now changes which model a default-tier step calls.
    const { call: chat } = await runAiStep({ modelTier: 'fast' });
    assert.equal(chat.modelId, 'lfm2-1.2b-extract');
});
