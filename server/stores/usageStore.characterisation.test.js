'use strict';

/**
 * usageStore — the golden behaviour, pinned before the store was split into
 * stores/usage/ (schema, payg, log, filters, queries, breakdowns, counts)
 * behind the usageStore barrel.
 *
 * Every dependency with an effect is replaced (preloadStubs) under its
 * RESOLVED path (so the doubles hold whatever relative path a moved module
 * uses to reach them): the db, the DDL runner, modelCosts (a deterministic
 * rater), the request client, the metrics sink, the currency helper, the PAYG
 * drain worker and the logger. Every statement, DDL batch, log line, metric,
 * FX lookup and drain call lands in ONE ordered trace next to each public
 * function's return value (or what it threw), and the trace is compared with
 * usageStore.characterisation.golden.json. The export surface is pinned too.
 *
 * Regenerate (only for a deliberate behaviour change):
 *   UPDATE_GOLDEN=1 node --test stores/usageStore.characterisation.test.js
 *
 * Run: cd server && node --test stores/usageStore.characterisation.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { preloadStubs, evictModule } = require('../testUtils/stubRequire');

const GOLDEN = path.join(__dirname, 'usageStore.characterisation.golden.json');
const TRACE = [];
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const plain = (v) => (v instanceof Date ? `Date(${v.toISOString()})` : v);

// ── db double ───────────────────────────────────────────────────────────────
const S = {
    costCols: [{ column_name: 'estimated_cost', data_type: 'real' }, { column_name: 'billed_cost', data_type: 'double precision' }],
    probeN: 10,
    orgPlans: {
        'org-payg': { stripe_customer_id: 'cus_1', status: 'active', billing_model: 'metered', markup_percent: '20', stripe_meter_event_name: 'ai_usage', currency: 'eur' },
        'org-fixed': { stripe_customer_id: 'cus_2', status: 'active', billing_model: 'fixed', markup_percent: null, stripe_meter_event_name: null, currency: 'usd' },
        'org-past-due': { stripe_customer_id: 'cus_3', status: 'canceled', billing_model: 'metered', markup_percent: '10', stripe_meter_event_name: 'ai_usage', currency: 'eur' },
    },
    userPlans: {
        'u-payg': { stripe_customer_id: 'cus_u', status: null, billing_model: 'metered', markup_percent: '0', stripe_meter_event_name: 'ai_usage', currency: null },
    },
    failInsert: false,
    failPlanQuery: false,
    nextId: 100,
};

function answer(sql, params) {
    if (/FROM information_schema\.columns/i.test(sql)) return { rows: S.costCols.map(c => ({ ...c })) };
    if (/COUNT\(\*\)::int AS n FROM \(SELECT 1 FROM ai_usage_log/i.test(sql)) return { rows: [{ n: S.probeN }] };
    if (/FROM organization_subscriptions/i.test(sql)) {
        if (S.failPlanQuery) throw new Error('plan query down');
        const r = S.orgPlans[params[0]];
        if (!r) return { rows: [] };
        return { rows: [/stripe_customer_id/.test(sql) ? { ...r } : { currency: r.currency }] };
    }
    if (/FROM consumer_subscriptions/i.test(sql)) {
        const r = S.userPlans[params[0]];
        if (!r) return { rows: [] };
        return { rows: [/stripe_customer_id/.test(sql) ? { ...r } : { currency: r.currency }] };
    }
    if (/^INSERT INTO ai_usage_log/i.test(sql)) {
        if (S.failInsert) throw new Error('insert failed');
        return { rows: [{ id: S.nextId++ }] };
    }
    if (/^INSERT INTO payg_meter_outbox/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/SELECT DISTINCT source/i.test(sql)) return { rows: [{ source: 'chat' }, { source: 'automation' }] };
    if (/SELECT DISTINCT model/i.test(sql)) return { rows: [{ model: 'gpt-4o' }] };
    if (/COUNT\(DISTINCT conversation_id\)::int AS test_chats/i.test(sql)) return { rows: [{ agent_id: 'a1', test_chats: '2' }, { agent_id: 'zz', test_chats: 9 }] };
    if (/COUNT\(\*\)::int AS runs/i.test(sql)) return { rows: [{ agent_id: 'app-1', runs: '5' }] };
    return { rows: [{ model: 'gpt-4o', calls: '3', total_tokens: '120', estimated_cost: '0.5', note: 'x' }] };
}
const rec = (via, sql, params) => TRACE.push({ via, sql: norm(sql), params: params === undefined ? null : params.map(plain) });
const db = {
    run: async (sql, params) => { rec('run', sql, params); return answer(norm(sql), params || []); },
    getOne: async (sql, params) => { rec('getOne', sql, params); return answer(norm(sql), params || []).rows[0] || null; },
    getAll: async (sql, params) => { rec('getAll', sql, params); return answer(norm(sql), params || []).rows; },
    exec: async (sql) => { rec('exec', sql); },
};

const ddl = {
    CODES: {},
    runDdl: async (tag, statements, opts) => {
        TRACE.push({ via: 'runDdl', tag, statements: statements.map(s => norm(typeof s === 'string' ? s : s.sql)), opts: opts || null });
        return { failures: S.ddlFail ? [{ sql: 'x' }] : [], tolerated: [] };
    },
};

const modelCosts = {
    resolveBilledModel: (model, providerType) => {
        TRACE.push({ via: 'resolveBilledModel', model, providerType: providerType ?? null });
        return model === 'my-deploy' ? 'gpt-4o' : (model === 'null-deploy' ? null : model);
    },
    rateUsage: (e) => {
        const tokens = (e.prompt_tokens || 0) + (e.completion_tokens || 0);
        const out = {
            cost: tokens / 1e6 * 3,
            currency: String(e.model).startsWith('mistral') ? 'EUR' : 'USD',
            price_input: 3, price_output: 15, price_cache_read: 0.3, price_cache_write: 3.75,
            source: 'litellm', catalog_version: 'v1', cost_basis: 'list',
            tier: e.service_tier || 'standard', at: e.timestamp instanceof Date ? e.timestamp.toISOString() : String(e.timestamp),
            inference_geo: null, long_context: false, valid_from: '2026-01-01', rates: { input: 3 }, multiplier: 1, notes: [],
        };
        TRACE.push({ via: 'rateUsage', model: e.model, provider_type: e.provider_type ?? null, timestamp: plain(e.timestamp), cost: out.cost });
        return out;
    },
};

const FX = { rates: { EUR: 0.8, USD: 1, GBP: 0 }, failStrict: false, failAll: false };
const currency = {
    getUsdToCurrencyRate: async (code, opts) => {
        TRACE.push({ via: 'fx', code, opts: opts || null });
        if (FX.failAll || (FX.failStrict && opts && opts.strict)) throw new Error(`fx down for ${code}`);
        return FX.rates[code] ?? 1;
    },
};

const logger = {};
for (const lvl of ['info', 'warn', 'error', 'debug']) {
    logger[lvl] = (...args) => TRACE.push({ via: `log.${lvl}`, args: args.map(a => (a && typeof a === 'object' ? JSON.parse(JSON.stringify(a)) : a)) });
}
const metrics = { recordLlmUsage: (m) => TRACE.push({ via: 'metrics', m: JSON.parse(JSON.stringify(m)) }) };
const drain = { drainOne: async (id) => { TRACE.push({ via: 'drainOne', id }); } };

const STUBS = {
    '../db': db,
    './lib/_ddl': ddl,
    '../core/llm/modelCosts': modelCosts,
    '../telemetry/requestClient': { currentClient: () => 'web' },
    '../telemetry/log': logger,
    '../telemetry/metrics': metrics,
    '../core/text/currency': currency,
    '../workers/paygDrain': drain,
};
preloadStubs(require, STUBS);
const prevMode = process.env.DEPLOYMENT_MODE;
const store = require('./usageStore');
after(() => {
    for (const req of Object.keys(STUBS)) evictModule(require.resolve(req));
    if (prevMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = prevMode;
});

const tick = () => new Promise((r) => setImmediate(r));

async function step(name, fn) {
    TRACE.push({ step: name });
    try {
        const out = await fn();
        await tick();
        const shown = out instanceof Map ? { Map: [...out.entries()] } : out;
        TRACE.push({ result: shown === undefined ? '<undefined>' : JSON.parse(JSON.stringify(shown)) });
    } catch (e) {
        await tick();
        TRACE.push({ threw: { name: e.name, message: e.message } });
    }
}

const T = '2026-01-02T03:04:05.000Z';

test('golden trace of every public path', async () => {
    TRACE.push({ step: 'exports', surface: Object.fromEntries(Object.entries(store).map(([k, v]) => [k, typeof v])) });
    TRACE.push({ step: 'constants', TEST_CHAT_SOURCE: store.TEST_CHAT_SOURCE, STUDIO_APP_ACTION_SOURCE: store.STUDIO_APP_ACTION_SOURCE, RUN_COUNT_WINDOWS: store.RUN_COUNT_WINDOWS });

    // ── schema ──
    await step('initDB', () => store.initDB());
    await step('initDB again (memoised)', () => store.initDB());
    S.costCols = [{ column_name: 'estimated_cost', data_type: 'double precision' }];
    await step('widenCostColumns already wide', () => store.widenCostColumns());
    S.costCols = [{ column_name: 'estimated_cost', data_type: 'real' }];
    S.probeN = 600000;
    await step('widenCostColumns too large', () => store.widenCostColumns());
    await step('widenCostColumns maxRows', () => store.widenCostColumns({ maxRows: 1e6 }));
    await step('widenCostColumns forced', () => store.widenCostColumns({ force: true }));
    S.ddlFail = true;
    await step('widenCostColumns ddl failed', () => store.widenCostColumns({ force: true }));
    S.ddlFail = false;

    // ── logUsage ──
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    await step('logUsage self-hosted minimal', () => store.logUsage({ timestamp: T }));
    await step('logUsage self-hosted with cost + cache', () => store.logUsage({
        timestamp: T, model: 'claude-x', prompt_tokens: 1000, completion_tokens: 500, cached_tokens: 50, cache_creation_tokens: 10,
        reasoning_tokens: 7, cache_ttl: '1h', stop_reason: 'end_turn', parent_call_id: 'p1', swarm_run_id: 's1', tool_name: 't',
        source: 'chat', duration_ms: 12, user_id: 'u1', agent_id: 'a1', agent_name: 'A', agent_type: 'swarm', conversation_id: 'c1',
        total_tokens: 9999, client: 'android', provider: 'anthropic', service_tier: 'priority',
        cache_ttl_ignored: 1, tool_use: { web_search: 2 }, modality: { image: 1 }, inference_geo: 'EU', traffic_type: 'BAD VALUE!',
        prompt_includes_cache: false, cache_creation_ttl_assumed: true, cache_creation_5m_tokens: 'x',
    }));
    process.env.DEPLOYMENT_MODE = 'cloud';
    await step('logUsage PAYG org EUR (USD price)', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 2_000_000, organization_id: 'org-payg', user_id: 'u1' }));
    await step('logUsage PAYG org again (cached target)', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, organization_id: 'org-payg' }));
    await step('logUsage fixed org USD, EUR price (inverse fx)', () => store.logUsage({ timestamp: T, model: 'mistral-large', prompt_tokens: 1_000_000, organization_id: 'org-fixed' }));
    await step('logUsage fixed org USD, USD price (no fx)', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, organization_id: 'org-fixed' }));
    await step('logUsage canceled metered org', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, organization_id: 'org-past-due' }));
    await step('logUsage PAYG user (null status, null currency)', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, user_id: 'u-payg' }));
    await step('logUsage no subscriber', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000 }));
    await step('logUsage unknown user (plan currency default)', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, user_id: 'u-none' }));
    await step('logUsage azure deployment', () => store.logUsage({ timestamp: T, model: 'my-deploy', prompt_tokens: 10 }));
    await step('logUsage deployment that resolves to null', () => store.logUsage({ timestamp: T, model: 'null-deploy', provider_type: 'azure', prompt_tokens: 10 }));
    await step('logUsage future timestamp clamps (rated at now)', async () => {
        const realNow = Date.now;
        Date.now = () => Date.parse('2026-05-05T00:00:00.000Z');
        try { await store.logUsage({ timestamp: '2099-01-01T00:00:00.000Z', model: 'gpt-4o' }); } finally { Date.now = realNow; }
    });
    await step('logUsage unparseable timestamp', async () => {
        const realNow = Date.now;
        Date.now = () => Date.parse('2026-05-05T00:00:00.000Z');
        try { await store.logUsage({ timestamp: 'garbage', model: 'gpt-4o' }); } finally { Date.now = realNow; }
    });
    await step('logUsage oversized usage_raw', () => store.logUsage({ timestamp: T, model: 'gpt-4o', tool_use: { big: 'x'.repeat(9000) }, modality: { a: 1 } }));
    await step('logUsage oversized even without tool_use', () => store.logUsage({ timestamp: T, model: 'my-deploy', notes: 1, tool_use: null, modality: null, cache_ttl: 'y'.repeat(60) }));

    FX.failAll = true;
    await step('logUsage fixed plan, fx down -> 1.0', () => store.logUsage({ timestamp: T, model: 'mistral-large', prompt_tokens: 1_000_000, organization_id: 'org-fixed' }));
    FX.failAll = false;
    FX.failStrict = true;
    await step('logUsage PAYG, strict fx throws (swallowed by outer catch)', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, organization_id: 'org-payg' }));
    FX.failStrict = false;
    FX.rates.EUR = 0;
    await step('logUsage PAYG, fx rate 0 -> fx_rate_unavailable propagates', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, organization_id: 'org-payg' }));
    FX.rates.EUR = 0.8;
    S.failInsert = true;
    await step('logUsage insert failure is swallowed', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, organization_id: 'org-payg' }));
    S.failInsert = false;

    await step('invalidatePaygCache org', () => store.invalidatePaygCache('org-payg', null));
    S.failPlanQuery = true;
    await step('logUsage after invalidate, plan query fails', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, organization_id: 'org-payg' }));
    S.failPlanQuery = false;
    await step('invalidatePaygCache user', () => store.invalidatePaygCache(null, 'u-payg'));
    await step('invalidatePaygCache all', () => store.invalidatePaygCache());
    await step('logUsage after clear-all', () => store.logUsage({ timestamp: T, model: 'gpt-4o', prompt_tokens: 1_000_000, organization_id: 'org-payg' }));

    // ── queries ──
    const ALL = { startDate: '2026-01-01', endDate: '2026-02-01', organizationId: 'o', userId: 'u', agentId: 'a', model: 'm', source: 's' };
    const queryFns = ['getUsageSummary', 'getPromptCacheStats', 'getPromptCacheHitRate', 'getUsageByModel', 'getUsageByAgent',
        'getUsageTimeline', 'getToolUsage', 'getCostTimeline', 'getUsageBySource', 'getUsageByUser', 'getUsageByOrg', 'getUsageRollup',
        'getUsageByConversation', 'getUsageByAgentType', 'getUsageByModelAndAgent', 'getUsageByModelAndUser', 'getUsageBySwarmRun'];
    for (const fn of queryFns) {
        await step(`${fn} no filters`, () => store[fn]());
        await step(`${fn} all filters`, () => store[fn](ALL));
    }
    await step('getUsageTimeline hour', () => store.getUsageTimeline({ model: 'm' }, 'hour'));
    await step('getCostTimeline hour', () => store.getCostTimeline({}, 'hour'));
    await step('getUsageRollup minute', () => store.getUsageRollup({}, 'minute'));
    await step('getUsageRollup bad interval', () => store.getUsageRollup({}, 'week; DROP'));
    await step('getRecentCalls default', () => store.getRecentCalls());
    await step('getRecentCalls all filters', () => store.getRecentCalls(7, { organizationId: 'o', source: 's', model: 'm', search: 'bob', startDate: 'a', endDate: 'b' }));
    await step('getRecentCalls end only', () => store.getRecentCalls(3, { endDate: 'b' }));
    // The scopes the route sets — the caller's own rows for a caller of no
    // organisation, ?agent= — must reach the SQL; the test below the trace
    // says so in words, the golden holds the statement.
    await step('getRecentCalls user scope', () => store.getRecentCalls(20, { userId: 'consumer-1', startDate: 'a', endDate: 'b' }));
    await step('getRecentCalls agent scope', () => store.getRecentCalls(5, { organizationId: 'o', agentId: 'agent-1', startDate: 'a', endDate: 'b' }));
    await step('getUsageSources', () => store.getUsageSources());
    await step('getUsageModels', () => store.getUsageModels());
    await step('numericAggregates', () => store.numericAggregates([{ calls: '2', total_cost: '1.5', avg_duration_ms: 'x', other: '9' }, { calls: null }]));
    await step('numericAggregates undefined', () => store.numericAggregates(undefined));

    // ── counts ──
    await step('getTestChatCounts empty', () => store.getTestChatCounts([]));
    await step('getTestChatCounts not array', () => store.getTestChatCounts('a1'));
    await step('getTestChatCounts default db', () => store.getTestChatCounts(['a1', 'a1', '', null, 5]));
    await step('getTestChatCounts injected db', () => store.getTestChatCounts(['a1'], {
        db: { query: async (sql, params) => { rec('inj', sql, params); return { rows: [{ agent_id: 'a1', test_chats: 4 }] }; } },
    }));
    await step('getTestChatCounts injected db no rows', () => store.getTestChatCounts(['a1'], { db: { query: async () => ({}) } }));
    await step('getStudioAppRunCounts bad window', () => store.getStudioAppRunCounts(['app-1'], { window: 'year' }));
    await step('getStudioAppRunCounts empty', () => store.getStudioAppRunCounts(null));
    await step('getStudioAppRunCounts default db', () => store.getStudioAppRunCounts(['app-1', 'app-2']));
    await step('getStudioAppRunCounts injected db', () => store.getStudioAppRunCounts(['app-1'], {
        window: 'month', db: { query: async (sql, params) => { rec('inj', sql, params); return { rows: [{ agent_id: 'app-1', runs: 'x' }] }; } },
    }));

    const actual = JSON.parse(JSON.stringify(TRACE));
    if (process.env.UPDATE_GOLDEN) {
        fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
        return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (let i = 0; i < Math.min(actual.length, golden.length); i++) assert.deepStrictEqual(actual[i], golden[i], `trace entry ${i}`);
    assert.strictEqual(actual.length, golden.length, 'same number of trace entries');
});

// The statement a step sent: the first db call recorded after the step marker.
/** @param {string} name */
function statementOf(name) {
    const at = TRACE.findIndex((e) => e.step === name);
    assert.notStrictEqual(at, -1, `step "${name}" is in the trace`);
    const call = TRACE.slice(at + 1).find((e) => e.via === 'getAll' || e.via === 'getOne');
    assert.ok(call, `step "${name}" sent a statement`);
    return call;
}

test('getRecentCalls: every scope the route can set is in the WHERE, bound as a parameter', () => {
    // routes/usage.js scopes a caller of no organisation to filters.userId and
    // nothing else. This function once built its WHERE by hand from
    // organizationId, source, model, search and the dates, so that one scope
    // never reached the SQL and the read ran over every organisation's rows.
    const user = statementOf('getRecentCalls user scope');
    assert.match(user.sql, /user_id = \$\d/);
    assert.deepStrictEqual(user.params, ['a', 'b', 'consumer-1', 20]);
    const agent = statementOf('getRecentCalls agent scope');
    assert.match(agent.sql, /organization_id = \$\d/);
    assert.match(agent.sql, /agent_id = \$\d/);
    assert.deepStrictEqual(agent.params, ['a', 'b', 'o', 'agent-1', 5]);
    // The hand-written parts survived the move to the shared filters.
    const all = statementOf('getRecentCalls all filters');
    assert.match(all.sql, /agent_name ILIKE \$\d OR user_id ILIKE \$\d OR model ILIKE \$\d/);
    const bare = statementOf('getRecentCalls default');
    assert.match(bare.sql, /WHERE timestamp >= NOW\(\) - INTERVAL '30 days' ORDER BY timestamp DESC LIMIT \$1$/);
});
