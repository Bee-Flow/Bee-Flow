// @typecheck strict
/**
 * Scripts outside the API process: the isolated-vm sandbox (./codeSandbox.js) run in a child process of its own
 * (./codeSandboxChild.js), one per script, for a Cowork plan's code steps (core/cowork/plan/planRunCopy.mts marks
 * them `isolated`).
 *
 *   - the child gets an environment with nothing but what Node needs to start (no secrets, no database address, no
 *     keys) and a heap of its own (CHILD_HEAP_MB);
 *   - it gets no bridges: no network, no app, no secret. A plan's script is a calculation on the data of earlier
 *     steps; what it returns is its output, and the plan's own steps do everything else;
 *   - it is killed when the script's own wall limit plus a margin passes, or when it ends in any other way than with
 *     an answer; the API process only ever sees an answer or an error.
 *
 * Two walls, then: the V8 isolate inside the child, and the child process around it.
 */

'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

const CHILD = path.join(__dirname, 'codeSandboxChild.js');
const CHILD_HEAP_MB = 128;
const MARGIN_MS = 3000;
const MAX_WALL_MS = 30_000;
/** What a child may inherit: what Node needs to start and find its modules, never a secret. */
const KEPT_ENV = ['PATH', 'NODE_ENV', 'LANG', 'TZ', 'HOME', 'TMPDIR'];

/** The child's environment. @param {NodeJS.ProcessEnv} [env] */
function childEnv(env = process.env) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const key of KEPT_ENV) {
        const value = env[key];
        if (typeof value === 'string') out[key] = value;
    }
    return out;
}

/**
 * Run one script in a child process. Resolves with what the script returned and what it logged; rejects with the
 * script's own error, a time-out, or the child's end.
 * @param {{ code: string, inputs?: unknown, limits?: Record<string, number>, mode?: 'live' | 'test' }} job
 * @returns {Promise<{ result: unknown, logs: string[] }>}
 */
function runCodeIsolated({ code, inputs = {}, limits = {}, mode = 'live' }) {
    const wallMs = Math.min(MAX_WALL_MS, Number.isFinite(limits.wallMs) && limits.wallMs > 0 ? limits.wallMs : 5000);
    return new Promise((resolve, reject) => {
        const child = fork(CHILD, [], {
            env: childEnv(),
            execArgv: [`--max-old-space-size=${CHILD_HEAP_MB}`],
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            serialization: 'advanced',
        });
        let settled = false;
        /** @param {() => void} finish */
        const settle = (finish) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null) child.kill('SIGKILL');
            finish();
        };
        const timer = setTimeout(() => settle(() => reject(new Error(`The script took longer than ${Math.round(wallMs / 1000)} s and was stopped.`))), wallMs + MARGIN_MS);
        child.once('message', (/** @type {{ ok?: boolean, result?: unknown, logs?: string[], error?: string }} */ reply) => {
            settle(() => (reply?.ok ? resolve({ result: reply.result, logs: Array.isArray(reply.logs) ? reply.logs : [] }) : reject(new Error(reply?.error || 'The script failed.'))));
        });
        child.once('error', (e) => settle(() => reject(new Error(`The script's sandbox could not start: ${e.message}`))));
        child.once('exit', (codeNumber, signal) => settle(() => reject(new Error(`The script's sandbox ended without an answer (${signal || codeNumber}).`))));
        child.send({ code, inputs, limits, mode });
    });
}

module.exports = { runCodeIsolated, childEnv, CHILD_HEAP_MB };
