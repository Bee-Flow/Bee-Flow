// @typecheck
'use strict';
const log = require('./log');

/**
 * OpenTelemetry bootstrap (traces + metrics) → OpenObserve via OTLP/HTTP.
 *
 * MUST be required before express / pg / http (see index.js, right after the
 * dotenv line). FULLY GATED: a no-op unless OTEL is switched on, so dev /
 * self-host stay clean. Any wiring/exporter failure is logged and swallowed —
 * telemetry must never crash the app (the process has an
 * uncaughtException → exit(1) handler).
 *
 * Enable by setting OTEL_ENABLED=true (or just OTEL_EXPORTER_OTLP_ENDPOINT).
 * Exports:
 *   isEnabled() — for /api/health
 *   shutdown()  — flush spans/metrics on SIGTERM/SIGINT before exit
 */

const ENABLED = (() => {
    // Explicit master switch takes priority; otherwise infer from endpoint.
    if (process.env.OTEL_ENABLED === 'true') return true;
    if (process.env.OTEL_ENABLED === 'false') return false;
    return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
})();

let _sdk = null;
let _started = false;

function isEnabled() { return _started; }

async function shutdown() {
    if (!_sdk) return;
    try {
        // Bound the final flush so a DOWN OpenObserve can't delay pod
        // termination past the k8s grace period — drop buffered telemetry
        // rather than hang shutdown.
        const budget = Number(process.env.OTEL_SHUTDOWN_TIMEOUT_MS || 2000);
        await Promise.race([
            _sdk.shutdown(),
            new Promise((resolve) => setTimeout(resolve, budget)),
        ]);
    } catch (e) {
        log.warn('[otel] shutdown error (ignored):', e && e.message);
    }
}

/**
 * @param {string} [raw] OTEL_EXPORTER_OTLP_HEADERS, `k=v,k=v`
 * @returns {Record<string, string>|undefined}
 */
function parseHeaders(raw) {
    if (!raw) return undefined;
    /** @type {Record<string, string>} */
    const out = {};
    for (const pair of raw.split(',')) {
        const i = pair.indexOf('=');
        if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    return out;
}

if (!ENABLED) {
    log.info('[otel] disabled (OTEL_ENABLED!=true and no OTEL_EXPORTER_OTLP_ENDPOINT) — no-op');
    // @ts-ignore TS2323: module.exports is assigned once per branch; tsc reads both as declarations
    module.exports = { isEnabled, shutdown };
} else {
    try {
        const { NodeSDK } = require('@opentelemetry/sdk-node');
        const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
        const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
        const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
        const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
        const { resourceFromAttributes } = require('@opentelemetry/resources');
        const {
            ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION,
        } = require('@opentelemetry/semantic-conventions');
        const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
        const {
            CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator,
        } = require('@opentelemetry/core');

        // Exporter errors are logged here (ERROR level) and dropped — never thrown.
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

        // Endpoint MUST NOT have a trailing slash. The HTTP exporters append
        // `/v1/traces` and `/v1/metrics`, matching OpenObserve's
        // /api/{org}/v1/{traces,metrics}.
        const base = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').replace(/\/+$/, '');
        // OTEL_EXPORTER_OTLP_HEADERS (e.g. "Authorization=Basic xxx") — only
        // needed for direct export to OpenObserve (option A). Empty for the
        // in-cluster collector (option B).
        const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'beeflow-server',
            [ATTR_SERVICE_VERSION]: process.env.APP_BUILD_SHA || process.env.APP_VERSION || 'dev',
            'deployment.environment': process.env.DEPLOYMENT_MODE || process.env.NODE_ENV || 'development',
            // OTEL_RESOURCE_ATTRIBUTES (k8s.pod.name, k8s.namespace, …) is merged
            // automatically by the SDK from the env var — no code needed.
        });

        // RESILIENCE: telemetry must never slow Bee Flow, even if OpenObserve is
        // down or slow. Everything below runs OFF the request path:
        //   * traces → BatchSpanProcessor (NodeSDK default): spans are buffered
        //     and flushed on a background timer; the queue is bounded
        //     (OTEL_BSP_MAX_QUEUE_SIZE, default 2048) and DROPS on overflow — no
        //     unbounded memory, no back-pressure onto request handlers.
        //   * metrics → PeriodicExportingMetricReader: exported on a timer, never
        //     inline.
        //   * a short per-request export TIMEOUT so a hung endpoint fails fast in
        //     the background instead of piling up connections.
        //   * exporter failures are logged via diag (ERROR) and dropped — they
        //     never throw into app code.
        // For the strongest decoupling in prod, export to the in-cluster
        // collector (option B) so the app is isolated from the OpenObserve VM's
        // availability entirely (see .env.example).
        const EXPORT_TIMEOUT_MS = Number(process.env.OTEL_EXPORT_TIMEOUT_MS || 8000);
        const METRIC_INTERVAL_MS = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS || 60000);
        // The metric reader requires exportInterval >= exportTimeout; clamp so a
        // low interval can never break init.
        const METRIC_TIMEOUT_MS = Math.min(EXPORT_TIMEOUT_MS, METRIC_INTERVAL_MS);
        _sdk = new NodeSDK({
            resource,
            traceExporter: new OTLPTraceExporter(Object.assign(
                { timeoutMillis: EXPORT_TIMEOUT_MS },
                base ? { url: `${base}/v1/traces` } : {},
                headers ? { headers } : {},
            )),
            metricReader: new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter(Object.assign(
                    { timeoutMillis: METRIC_TIMEOUT_MS },
                    base ? { url: `${base}/v1/metrics` } : {},
                    headers ? { headers } : {},
                )),
                exportIntervalMillis: METRIC_INTERVAL_MS,
                exportTimeoutMillis: METRIC_TIMEOUT_MS,
            }),
            textMapPropagator: new CompositePropagator({
                propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
            }),
            instrumentations: [getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': { enabled: false },    // noisy: uploads/PDF/temp I/O
                '@opentelemetry/instrumentation-dns': { enabled: false },   // noisy, low value
                '@opentelemetry/instrumentation-net': { enabled: false },
                '@opentelemetry/instrumentation-express': { enabled: true },
                '@opentelemetry/instrumentation-http': {
                    enabled: true,
                    // Don't span the k8s/Docker health probe or the metrics
                    // scrape — they would swamp the trace stream.
                    ignoreIncomingRequestHook: (req) => {
                        const url = (req && req.url) || '';
                        return url.startsWith('/api/health') || url.startsWith('/api/admin/metrics');
                    },
                },
                // Outbound LLM/provider fetch() spans + provider status codes.
                // Set OTEL_DISABLE_UNDICI=1 if the trace volume is too high.
                '@opentelemetry/instrumentation-undici': {
                    enabled: process.env.OTEL_DISABLE_UNDICI !== '1',
                },
                '@opentelemetry/instrumentation-pg': { enabled: true },
                '@opentelemetry/instrumentation-ioredis': { enabled: true },
                '@opentelemetry/instrumentation-redis': { enabled: true },
            })],
        });

        _sdk.start();               // synchronous in this SDK line
        _started = true;
        log.info(`[otel] started → ${base || '(default OTLP env)'} `
            + `service=${process.env.OTEL_SERVICE_NAME || 'beeflow-server'}`);
    } catch (err) {
        // Wiring failure must be non-fatal.
        log.error('[otel] init failed (telemetry disabled, app continues):', err && err.message);
        _sdk = null;
        _started = false;
    }

    // @ts-ignore TS2323: module.exports is assigned once per branch; tsc reads both as declarations
    module.exports = { isEnabled, shutdown };
}
