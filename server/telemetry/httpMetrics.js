// @typecheck
/**
 * HTTP / DB / cache metrics — lightweight, dependency-free, same Map-counter
 * style as the other in-process metric modules. No external dependency (prom-client is
 * not installed); swap internals behind this API if/when it is.
 *
 * Mount renderTextFormat()/snapshot() behind an ADMIN-gated endpoint only —
 * route labels are templated (low cardinality) but still operational data.
 *
 * Metrics exposed:
 *   - http_requests_total{method,route,status}        (status = "2xx".."5xx")
 *   - http_request_duration_ms_sum{method,route}
 *   - http_request_duration_ms_count{method,route}
 *   - http_request_duration_ms_max{method,route}
 *   - http_requests_slow_total{method,route}          (> HTTP_SLOW_MS)
 *   - db_queries_total
 *   - db_query_duration_ms_sum / _count / _max
 *   - db_queries_slow_total                           (> DB_SLOW_MS)
 *   - cache_hits_total{cache}
 *   - cache_misses_total{cache}
 *   - event_loop_delay_ms{quantile}                    (p50/p99/max/mean)
 */

const { monitorEventLoopDelay } = require('perf_hooks');

const HTTP_SLOW_MS = Number(process.env.HTTP_SLOW_MS || 1000);
const DB_SLOW_MS = Number(process.env.DB_SLOW_MS || 200);

// ── Event-loop delay gauge ───────────────────────────────
// Measures how long the event loop is blocked (sync crypto, sync fs, big
// JSON.parse, tight loops). This is the number the [PERF] refactor items are
// judged against — snapshot p99 before/after each change. The monitor's timer
// does not keep the process alive (passive libuv histogram), so it's safe to
// leave enabled for the process lifetime.
const _eld = monitorEventLoopDelay({ resolution: 20 });
_eld.enable();

/** Event-loop delay quantiles in milliseconds. NaN (no samples yet) → 0. */
function eventLoopDelayMs() {
    const ms = (ns) => (Number.isFinite(ns) ? ns / 1e6 : 0);
    return {
        p50: ms(_eld.percentile(50)),
        p99: ms(_eld.percentile(99)),
        max: ms(_eld.max),
        mean: ms(_eld.mean),
    };
}

/** Reset the event-loop histogram (call between before/after measurements). */
function resetEventLoopDelay() {
    _eld.reset();
}

const counters = new Map();   // "name::labelKey" → number
const durations = new Map();  // "name::labelKey" → { sum, count, max }

function labelKey(labels) {
    return Object.entries(labels || {}).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
}

function inc(name, labels, delta = 1) {
    const key = `${name}::${labelKey(labels)}`;
    counters.set(key, (counters.get(key) || 0) + delta);
}

function observe(name, labels, ms) {
    const key = `${name}::${labelKey(labels)}`;
    const d = durations.get(key) || { sum: 0, count: 0, max: 0 };
    d.sum += ms;
    d.count += 1;
    if (ms > d.max) d.max = ms;
    durations.set(key, d);
}

function recordHttp({ method, route, status, ms }) {
    const cls = `${Math.floor((status || 0) / 100)}xx`;
    inc('http_requests_total', { method, route, status: cls });
    observe('http_request_duration_ms', { method, route }, ms);
    if (ms > HTTP_SLOW_MS) inc('http_requests_slow_total', { method, route });
}

function recordQuery(ms) {
    inc('db_queries_total', {});
    observe('db_query_duration_ms', {}, ms);
    if (ms > DB_SLOW_MS) inc('db_queries_slow_total', {});
}

/** Record a cache lookup outcome. `cache` is a stable cache name (e.g. 'permissions'). */
function recordCache(cache, hit) {
    inc(hit ? 'cache_hits_total' : 'cache_misses_total', { cache });
}

function _fmtLabels(labelStr) {
    if (!labelStr) return '';
    return `{${labelStr.split('|').map(p => {
        const i = p.indexOf('=');
        return `${p.slice(0, i)}="${p.slice(i + 1)}"`;
    }).join(',')}}`;
}

/** Prometheus-style textual dump. Safe to mount behind an admin endpoint. */
function renderTextFormat() {
    const lines = [];
    for (const [key, value] of counters) {
        const [name, labelStr] = key.split('::');
        lines.push(`${name}${_fmtLabels(labelStr)} ${value}`);
    }
    for (const [key, d] of durations) {
        const [name, labelStr] = key.split('::');
        const l = _fmtLabels(labelStr);
        lines.push(`${name}_sum${l} ${d.sum.toFixed(1)}`);
        lines.push(`${name}_count${l} ${d.count}`);
        lines.push(`${name}_max${l} ${d.max.toFixed(1)}`);
    }
    const eld = eventLoopDelayMs();
    for (const q of ['p50', 'p99', 'max', 'mean']) {
        lines.push(`event_loop_delay_ms{quantile="${q}"} ${eld[q].toFixed(2)}`);
    }
    return lines.join('\n');
}

function snapshot() {
    return {
        thresholds: { httpSlowMs: HTTP_SLOW_MS, dbSlowMs: DB_SLOW_MS },
        counters: Object.fromEntries(counters),
        durations: Object.fromEntries(durations),
        eventLoopDelayMs: eventLoopDelayMs(),
    };
}

module.exports = {
    HTTP_SLOW_MS,
    DB_SLOW_MS,
    recordHttp,
    recordQuery,
    recordCache,
    eventLoopDelayMs,
    resetEventLoopDelay,
    renderTextFormat,
    snapshot,
};
