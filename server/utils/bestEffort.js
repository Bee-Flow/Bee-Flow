// @typecheck strict
'use strict';

/**
 * Failures that are allowed to happen, but not to be invisible.
 *
 * A telemetry write, a notification, a cache fill or a cleanup may fail without
 * failing the request; a read may degrade to a default. Swallowing that with a
 * bare `log.debug` hides it at production log levels. These two helpers keep
 * the "carry on" and add the trace:
 *
 *   bestEffort(label, err)         a side effect that failed; nothing to return
 *   fallback(label, err, value)    a read that degrades to `value` (returned)
 *
 * Both count the failure per label and log it at warn, at most once per label
 * per minute (`LOG_INTERVAL_MS`); the failures in between are only counted, and
 * the next warn says how many were held back. The label is a static
 * `<module>:<what>` string: low cardinality, and never personal data. The error
 * itself goes to the log call (log.js formats its message); it is not an
 * attribute of the metric.
 *
 *     await notify(user).catch((e) => bestEffort('notifications/send:welcome', e));
 *     const rows = await load().catch((e) => fallback('reports/list:load', e, []));
 *
 * `bestEffortCounts()` is the snapshot for a health or metrics endpoint.
 */

const log = require('../telemetry/log');

const LOG_INTERVAL_MS = 60_000;
const MAX_LABELS = 2000;

/**
 * The OTel counter, made on first use. A repo script that loads a server module
 * runs without the server's node_modules; there the counter is skipped and the
 * per-label counts and warns below still work.
 * @type {{ add(n: number, attrs: Record<string, string>): void } | null | undefined}
 */
let failures;
function counter() {
    if (failures !== undefined) return failures;
    try {
        const { metrics } = require('@opentelemetry/api');
        failures = metrics
            .getMeter('beeflow-server', process.env.APP_BUILD_SHA || 'dev')
            .createCounter('best_effort.failures', { description: 'Failures a caller chose to carry on from', unit: '{failure}' });
    } catch {
        failures = null;
    }
    return failures;
}

/** @type {Map<string, { count: number, kind: string, lastLogAt: number, held: number }>} */
const labels = new Map();

/**
 * @param {string} kind 'best-effort' | 'fallback'
 * @param {string} label
 * @param {unknown} err
 */
function note(kind, label, err) {
    let entry = labels.get(label);
    if (!entry) {
        // A label is a literal at the call site, so this bound is a backstop against a dynamic one.
        if (labels.size >= MAX_LABELS) label = '(other)';
        entry = labels.get(label);
    }
    if (!entry) {
        entry = { count: 0, kind, lastLogAt: -Infinity, held: 0 };
        labels.set(label, entry);
    }
    entry.count++;
    counter()?.add(1, { site: label, kind });
    const now = Date.now();
    if (now - entry.lastLogAt < LOG_INTERVAL_MS) {
        entry.held++;
        return;
    }
    const held = entry.held;
    entry.lastLogAt = now;
    entry.held = 0;
    const what = kind === 'fallback' ? 'fell back to a default' : 'failed, carrying on';
    log.warn(`[${kind}] ${label} ${what}${held ? ` (+${held} more in the last minute)` : ''}`, err);
}

/**
 * A side effect failed and the caller goes on without it.
 * @param {string} label static `<module>:<what>`
 * @param {unknown} err
 * @returns {undefined}
 */
function bestEffort(label, err) {
    note('best-effort', label, err);
    return undefined;
}

/**
 * A read failed and the caller uses `value` instead.
 * @template [T=undefined]
 * @param {string} label static `<module>:<what>`
 * @param {unknown} err
 * @param {T} [value]
 * @returns {T}
 */
function fallback(label, err, value) {
    note('fallback', label, err);
    return /** @type {T} */ (value);
}

/** @returns {Record<string, { count: number, kind: string }>} failures per label since the process started */
function bestEffortCounts() {
    /** @type {Record<string, { count: number, kind: string }>} */
    const out = {};
    for (const [label, { count, kind }] of labels) out[label] = { count, kind };
    return out;
}

/** Test seam: forget every label. */
function resetBestEffort() {
    labels.clear();
}

module.exports = { bestEffort, fallback, bestEffortCounts, resetBestEffort, LOG_INTERVAL_MS };
