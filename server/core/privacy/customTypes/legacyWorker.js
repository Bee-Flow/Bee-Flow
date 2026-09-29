'use strict';
/**
 * Worker thread for the MIGRATED patterns RE2 cannot run (lookarounds,
 * backreferences): the old "Always hide these" regexes kept working on V8
 * semantics, but never on the event loop. See legacyRunner.js for the
 * protocol; this side only answers.
 *
 * One message per pattern, so a pattern that finishes before a slow sibling
 * still counts; the counter in the shared buffer wakes the waiting thread.
 */

const { workerData } = require('worker_threads');

const flags = new Int32Array(workerData.sab);
const port = workerData.port;
const MAX_SPANS = 20_000;

function scanOne(job, text) {
    const re = new RegExp(job.source, job.caseSensitive ? 'g' : 'gi');
    const spans = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
            // Zero-width match: never a span, and it must not loop forever.
            re.lastIndex = m.index + 1;
            continue;
        }
        spans.push({ start: m.index, end: m.index + m[0].length });
        if (spans.length >= MAX_SPANS) return { spans, capped: true };
    }
    return { spans, capped: false };
}

port.on('message', (msg) => {
    const { jobId, jobs, text } = msg || {};
    for (const job of jobs || []) {
        let result;
        try {
            result = { ...scanOne(job, String(text || '')), error: null };
        } catch (_) {
            result = { spans: [], capped: false, error: 'compile_failed' };
        }
        port.postMessage({ jobId, id: job.id, ...result });
        Atomics.add(flags, 0, 1);
        Atomics.notify(flags, 0);
    }
});

Atomics.store(flags, 1, 1);
Atomics.notify(flags, 1);
