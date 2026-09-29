// @typecheck
'use strict';
/**
 * Runs migrated V8-only patterns in a worker thread with a hard time budget.
 *
 * The old custom-terms scanner ran admin-authored regexes on the event loop
 * against arbitrary user input. New patterns must compile under RE2, which is
 * linear and cannot backtrack catastrophically; a MIGRATED pattern RE2 rejects
 * (a lookahead, a backreference) keeps its old V8 meaning, but only here: in a
 * worker, answered through a SharedArrayBuffer so the caller can wait
 * SYNCHRONOUSLY with a deadline (the same matcher serves the synchronous
 * test bench and production). A pattern that does not finish within the budget
 * is reported as timed out, the worker is terminated (V8 can interrupt a
 * running regex), and that id is not tried again for COOLDOWN_MS: a pattern
 * that timed out once would otherwise cost the full budget on every scan.
 *
 * Protocol: flags[1] = 1 once the worker listens; flags[0] increments after
 * every per-pattern reply posted on the MessagePort. The caller loads
 * flags[0], drains the port with receiveMessageOnPort, and only then waits on
 * the loaded value, so a reply that lands between the drain and the wait
 * wakes it immediately instead of costing the rest of the budget.
 */

const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const log = require('../../../telemetry/log');

const DEFAULT_BUDGET_MS = 50;
const READY_WAIT_MS = 2000;
const COOLDOWN_MS = 60_000;

/** @type {{ worker: Worker, port: import('worker_threads').MessagePort, flags: Int32Array, seq: number } | null} */
let _state = null;
/** id → epoch ms until which the pattern is not run again */
const _cooldown = new Map();

function _spawn() {
    const sab = new SharedArrayBuffer(8);
    const flags = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(path.join(__dirname, 'legacyWorker.js'), {
        workerData: { sab, port: port2 },
        transferList: [port2],
    });
    // Never keep the process alive for this worker: a test file or a
    // shutting-down server must be able to exit with it idle.
    worker.unref();
    const state = { worker, port: port1, flags, seq: 0 };
    const forget = () => { if (_state === state) _state = null; };
    worker.on('error', forget);
    worker.on('exit', forget);
    _state = state;
    return state;
}

/** Start the worker ahead of the first scan (worker start-up is ~30-40 ms). */
function prewarm() {
    if (!_state) {
        try { _spawn(); } catch (err) { log.warn('[CustomTypes] legacy pattern worker could not start:', err.message); }
    }
}

function _kill(state) {
    if (_state === state) _state = null;
    state.worker.terminate().catch(() => { /* already gone */ });
    try { state.port.close(); } catch (_) { /* closed */ }
}

/**
 * @param {Array<{ id: string, source: string, caseSensitive: boolean }>} jobs
 * @param {string} text
 * @param {number} [budgetMs]
 * @returns {{ results: Map<string, Array<{start:number,end:number}>>, timedOut: string[], capped: string[], failed: string[] }}
 */
function runLegacySync(jobs, text, budgetMs = DEFAULT_BUDGET_MS) {
    const results = new Map();
    const timedOut = [];
    const capped = [];
    const failed = [];
    const now = Date.now();
    const runnable = [];
    for (const job of jobs || []) {
        const until = _cooldown.get(job.id);
        if (until && until > now) { timedOut.push(job.id); continue; }
        if (until) _cooldown.delete(job.id);
        runnable.push(job);
    }
    if (!runnable.length) return { results, timedOut, capped, failed };

    let state = _state;
    try { state = state || _spawn(); } catch (err) {
        log.warn('[CustomTypes] legacy pattern worker could not start:', err.message);
        return { results, timedOut: [...timedOut, ...runnable.map(j => j.id)], capped, failed };
    }
    if (Atomics.load(state.flags, 1) !== 1) Atomics.wait(state.flags, 1, 0, READY_WAIT_MS);
    if (Atomics.load(state.flags, 1) !== 1) {
        return { results, timedOut: [...timedOut, ...runnable.map(j => j.id)], capped, failed };
    }

    state.seq += 1;
    const jobId = state.seq;
    const pending = new Set(runnable.map(j => j.id));
    const drain = () => {
        let msg;
        while ((msg = receiveMessageOnPort(state.port))) {
            const m = msg.message;
            if (!m || m.jobId !== jobId || !pending.has(m.id)) continue;
            pending.delete(m.id);
            if (m.error) { failed.push(m.id); continue; }
            results.set(m.id, Array.isArray(m.spans) ? m.spans : []);
            if (m.capped) capped.push(m.id);
        }
    };

    state.port.postMessage({
        jobId,
        jobs: runnable.map(j => ({ id: j.id, source: j.source, caseSensitive: !!j.caseSensitive })),
        text,
    });
    const deadline = Date.now() + Math.max(1, budgetMs);
    for (;;) {
        const seen = Atomics.load(state.flags, 0);
        drain();
        if (!pending.size) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        Atomics.wait(state.flags, 0, seen, remaining);
    }
    drain();

    if (pending.size) {
        const until = Date.now() + COOLDOWN_MS;
        for (const id of pending) { timedOut.push(id); _cooldown.set(id, until); }
        // Ids only: the pattern itself is the admin's configuration.
        log.warn(`[CustomTypes] legacy pattern(s) exceeded the ${budgetMs}ms budget: ${[...pending].join(',')} (skipped for ${COOLDOWN_MS / 1000}s)`);
        _kill(state);
    }
    return { results, timedOut, capped, failed };
}

/** Test seam. */
function _resetLegacyRunner() {
    _cooldown.clear();
    if (_state) _kill(_state);
}

module.exports = { runLegacySync, prewarm, _resetLegacyRunner, DEFAULT_BUDGET_MS, COOLDOWN_MS };
