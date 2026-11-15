// @typecheck strict
/**
 * telemetry/otel.js isUntracedRequest: the incoming requests that get no span.
 *
 * The compose healthcheck and the readiness probe of the Kubernetes guide ask
 * /api/ready every few seconds per replica; like the liveness probe they must
 * stay out of the trace stream.
 *
 * Run: cd server && node --test telemetry/otel.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

// Off whatever the machine's environment says, so requiring the module starts no SDK.
process.env.OTEL_ENABLED = 'false';
const { isUntracedRequest } = require('./otel');

test('the probes of an orchestrator and the metrics scrape get no span', () => {
    for (const url of ['/api/health', '/api/health/schema', '/api/ready', '/api/ready?t=1700000000', '/api/admin/metrics?format=prometheus']) {
        assert.strictEqual(isUntracedRequest(url), true, url);
    }
});

test('every other request is traced, also one without a url', () => {
    for (const url of ['/api', '/api/agents', '/auth/login', '/api/guard/health', '/']) {
        assert.strictEqual(isUntracedRequest(url), false, url);
    }
    assert.strictEqual(isUntracedRequest(), false);
});
