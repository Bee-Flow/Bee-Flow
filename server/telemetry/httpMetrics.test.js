/**
 * Unit — httpMetrics event-loop-delay gauge + snapshot shape.
 * DB-free. Run: node --test telemetry/httpMetrics.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const metrics = require('./httpMetrics');

test('eventLoopDelayMs returns numeric quantiles', () => {
    const eld = metrics.eventLoopDelayMs();
    for (const q of ['p50', 'p99', 'max', 'mean']) {
        assert.strictEqual(typeof eld[q], 'number', `${q} is a number`);
        assert.ok(eld[q] >= 0, `${q} is non-negative`);
        assert.ok(Number.isFinite(eld[q]), `${q} is finite`);
    }
});

test('snapshot includes eventLoopDelayMs alongside counters/durations', () => {
    metrics.recordHttp({ method: 'GET', route: '/api/x', status: 200, ms: 5 });
    metrics.recordQuery(3);
    const snap = metrics.snapshot();
    assert.ok(snap.eventLoopDelayMs, 'snapshot has eventLoopDelayMs');
    assert.strictEqual(typeof snap.eventLoopDelayMs.p99, 'number');
    assert.ok(snap.counters, 'snapshot has counters');
    assert.ok(snap.durations, 'snapshot has durations');
});

test('renderTextFormat emits the event_loop_delay_ms lines', () => {
    const text = metrics.renderTextFormat();
    for (const q of ['p50', 'p99', 'max', 'mean']) {
        assert.ok(
            text.includes(`event_loop_delay_ms{quantile="${q}"}`),
            `text has ${q} line`,
        );
    }
});

test('resetEventLoopDelay does not throw', () => {
    assert.doesNotThrow(() => metrics.resetEventLoopDelay());
});
