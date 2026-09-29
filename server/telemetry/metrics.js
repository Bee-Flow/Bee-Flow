// @typecheck
'use strict';

/**
 * Domain metrics for the LLM / agent / MCP hot-paths.
 *
 * SAFE ATTRIBUTES ONLY. Never attach prompt/response content, user text, org
 * names, emails, API keys, or unbounded-cardinality IDs. Allowed: provider,
 * model, status, source, agent_type, error_type, mcp server/tool (all
 * low-cardinality, operational), plus numeric token counts / duration / cost.
 * See the allow/deny list at the bottom.
 *
 * No-op automatically when the OTel SDK is not started (getMeter → no-op meter),
 * so these helpers are always safe to call, gated or not.
 */

const { metrics } = require('@opentelemetry/api');
const meter = metrics.getMeter('beeflow-server', process.env.APP_BUILD_SHA || 'dev');

// ── LLM ─────────────────────────────────────────────────────────────────────
const llmRequests  = meter.createCounter('llm.requests',        { description: 'LLM completion calls', unit: '{request}' });
const llmDuration  = meter.createHistogram('llm.request.duration', { description: 'LLM call wall time', unit: 'ms' });
const llmTokensIn  = meter.createCounter('llm.tokens.input',    { description: 'Prompt tokens (incl. cached)', unit: '{token}' });
const llmTokensOut = meter.createCounter('llm.tokens.output',   { description: 'Completion tokens', unit: '{token}' });
const llmCostUsd   = meter.createCounter('llm.cost.usd',        { description: 'Estimated cost', unit: 'USD' });
const llmErrors    = meter.createCounter('llm.provider.errors', { description: 'Provider call failures', unit: '{error}' });

// ── Agent runs (helper exported; wire at agent entrypoints as a follow-up) ───
const agentRuns     = meter.createCounter('agent.runs',           { description: 'Agent invocations', unit: '{run}' });
const agentDuration = meter.createHistogram('agent.run.duration', { description: 'Agent run wall time', unit: 'ms' });

// ── MCP ─────────────────────────────────────────────────────────────────────
const mcpCalls    = meter.createCounter('mcp.calls',          { description: 'MCP tool calls', unit: '{call}' });
const mcpDuration = meter.createHistogram('mcp.call.duration', { description: 'MCP tool call wall time', unit: 'ms' });

// ── Auth / sessions (status only — never a user id/email) ────────────────────
const authEvents = meter.createCounter('auth.events', { description: 'Auth events (login/mfa/lockout)', unit: '{event}' });

// ── Python sidecars (search / rerank / guard / pii / whisperx) ───────────────
const sidecarCalls    = meter.createCounter('sidecar.calls',          { description: 'Python sidecar HTTP calls', unit: '{call}' });
const sidecarDuration = meter.createHistogram('sidecar.call.duration', { description: 'Sidecar call wall time', unit: 'ms' });

// ── Embeddings (source = provider|azure|cpu — exposes CPU-fallback rate) ──────
const embedCalls = meter.createCounter('embed.calls', { description: 'Embedding dispatch calls', unit: '{call}' });

// ── Background-job health (liveness = rate of ok increments) ─────────────────
const jobRuns     = meter.createCounter('job.runs',           { description: 'Background job executions', unit: '{run}' });
const jobDuration = meter.createHistogram('job.run.duration', { description: 'Background job wall time', unit: 'ms' });

// ── Licensing feature-gate outcomes (deny = upsell signal) ───────────────────
const featureGate = meter.createCounter('feature.gate', { description: 'License feature-gate decisions', unit: '{check}' });

/** Cheap provider inference from a model id (avoids an async provider lookup on
 * the usage hot-path). Low-cardinality, PII-safe. */
function providerFromModel(model) {
    const m = String(model || '').toLowerCase();
    if (!m) return 'unknown';
    if (m.includes('claude')) return 'anthropic';
    if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.includes('openai')) return 'openai';
    if (m.includes('gemini')) return 'google';
    if (m.includes('mistral') || m.includes('mixtral')) return 'mistral';
    // Mistral's other families carry no "mistral" in the id.
    if (/^(ministral|magistral|codestral|devstral|pixtral|voxtral)/.test(m)) return 'mistral';
    if (m.includes('azure')) return 'azure';
    return 'other';
}

/** Record one completed LLM call. Call from usageStore.logUsage (the single
 * authoritative sink for every model call's tokens/cost/duration). */
function recordLlmUsage({ provider, model, source, status, durationMs,
                          promptTokens, completionTokens, costUsd }) {
    const attrs = {
        provider: provider || providerFromModel(model),
        model: model || 'unknown',
        source: source || 'unknown',   // e.g. 'chat', 'title', 'automation', 'swarm'
        status: status || 'ok',        // 'ok' | 'error'
    };
    llmRequests.add(1, attrs);
    if (Number.isFinite(durationMs)) llmDuration.record(durationMs, attrs);
    if (promptTokens)     llmTokensIn.add(promptTokens, { provider: attrs.provider, model: attrs.model });
    if (completionTokens) llmTokensOut.add(completionTokens, { provider: attrs.provider, model: attrs.model });
    if (Number.isFinite(costUsd) && costUsd > 0) llmCostUsd.add(costUsd, { provider: attrs.provider, model: attrs.model });
}

/** Record a provider-side failure (no usage row is written on failure). */
function recordLlmError({ provider, model, errorType }) {
    llmErrors.add(1, {
        provider: provider || providerFromModel(model),
        model: model || 'unknown',
        error_type: errorType || 'unknown',   // e.g. 'http_5xx','http_4xx','timeout','parse'
    });
}

function recordAgentRun({ agentType, status, durationMs }) {
    const attrs = { agent_type: agentType || 'chat', status: status || 'ok' };
    agentRuns.add(1, attrs);
    if (Number.isFinite(durationMs)) agentDuration.record(durationMs, attrs);
}

function recordMcpCall({ server, tool, status, durationMs }) {
    const attrs = { server: server || 'unknown', tool: tool || 'unknown', status: status || 'ok' };
    mcpCalls.add(1, attrs);
    if (Number.isFinite(durationMs)) mcpDuration.record(durationMs, attrs);
}

/** Record an auth event. `kind` e.g. 'login'|'opaque_login'|'mfa'|'lockout';
 * `status` 'ok'|'fail'. NEVER pass a user id/email — status/kind only. */
function recordAuthEvent({ kind, status }) {
    authEvents.add(1, { kind: kind || 'login', status: status || 'ok' });
}

/** Record a Python-sidecar HTTP call. `service` e.g. 'search'|'rerank'|'guard'|
 * 'pii'|'whisperx'; `status` 'ok'|'error'|'timeout'. */
function recordSidecarCall({ service, status, durationMs }) {
    const attrs = { service: service || 'unknown', status: status || 'ok' };
    sidecarCalls.add(1, attrs);
    if (Number.isFinite(durationMs)) sidecarDuration.record(durationMs, attrs);
}

/** Record an embedding dispatch. `source` 'provider'|'azure'|'cpu'|'none';
 * `status` 'ok'|'error'. The cpu source is the fallback-rate signal. */
function recordEmbedCall({ source, status }) {
    embedCalls.add(1, { source: source || 'none', status: status || 'ok' });
}

/** Record a background-job execution. `job` is a stable job name; `status`
 * 'ok'|'error'. Liveness alerts fire on the absence of ok increments. */
function recordJobRun({ job, status, durationMs }) {
    const attrs = { job: job || 'unknown', status: status || 'ok' };
    jobRuns.add(1, attrs);
    if (Number.isFinite(durationMs)) jobDuration.record(durationMs, attrs);
}

/** Record a license feature-gate decision. `feature`/`tier` are bounded keys;
 * `decision` 'allow'|'deny'. Deny volume by feature is an upsell signal. */
function recordFeatureGate({ feature, tier, decision }) {
    featureGate.add(1, { feature: feature || 'unknown', tier: tier || 'unknown', decision: decision || 'deny' });
}

// ── Observable gauges (polled at each metric export interval) ─────────────────
// PG pool saturation + event-loop delay. Sources are lazy-required so this
// module stays load-order/circular-safe (it is required before db.js is ready).
try {
    const poolGauge = meter.createObservableGauge('db.pool.connections', {
        description: 'Postgres pool connections by state', unit: '{connection}',
    });
    poolGauge.addCallback((obs) => {
        try {
            const { getPoolStats } = require('../db');
            const s = /** @type {{ total?: number, idle?: number, waiting?: number }} */ (getPoolStats() || {});
            obs.observe(Number(s.total) || 0, { state: 'total' });
            obs.observe(Number(s.idle) || 0, { state: 'idle' });
            obs.observe(Number(s.waiting) || 0, { state: 'waiting' });
        } catch (_) { /* db not ready yet — skip this tick */ }
    });

    const eldGauge = meter.createObservableGauge('nodejs.eventloop.delay', {
        description: 'Event-loop delay quantiles', unit: 'ms',
    });
    eldGauge.addCallback((obs) => {
        try {
            const { eventLoopDelayMs } = require('./httpMetrics');
            const d = eventLoopDelayMs() || {};
            for (const q of ['p50', 'p99', 'max', 'mean']) obs.observe(Number(d[q]) || 0, { quantile: q });
        } catch (_) { /* skip */ }
    });
} catch (_) { /* createObservableGauge unavailable on no-op meter — ignore */ }

module.exports = {
    providerFromModel,
    recordLlmUsage,
    recordLlmError,
    recordAgentRun,
    recordMcpCall,
    recordAuthEvent,
    recordSidecarCall,
    recordEmbedCall,
    recordJobRun,
    recordFeatureGate,
};

// ── SAFE vs FORBIDDEN attributes ─────────────────────────────────────────────
// SAFE:      provider, model, status, source, agent_type, error_type,
//            mcp server id (stable), mcp tool name, token COUNTS, duration, cost,
//            auth kind, sidecar service name, embed source, job name, pool state,
//            event-loop quantile, feature/tier keys, allow|deny decision.
// FORBIDDEN: prompt/response/tool-arg CONTENT, system prompts, user_id/email,
//            org name, api keys, file names, conversation text, IP, raw error
//            bodies (may echo prompt). error_type must be a CLASSIFIED enum,
//            never err.message. Attributes must stay LOW-cardinality (no ids).
