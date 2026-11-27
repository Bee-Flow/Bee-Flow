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
 *     an answer; the API process only ever sees an answer or an error;
 *   - at most COWORK_SANDBOX_MAX_CHILDREN children (default 4) run at once in this process, and at most
 *     CODE_STEP_MAX_CONCURRENCY_PER_ORG (default 2) of one organisation (the slots of ./codeSandboxSlots.js), so one
 *     organisation's long scripts never hold every slot: the next script waits its turn, and one that waits longer
 *     than CHILD_WAIT_MS fails its step with a plain "busy" message rather than piling up processes without end.
 *
 * Two walls, then: the V8 isolate inside the child, and the child process around it.
 *
 * The child keeps the module resolver (moduleRoots.cjs, `--require` in its execArgv): it requires files of the tree
 * (../utils/ssrfGuard by way of ./codeSandbox) that may sit in another root than this one, and the scrubbed
 * environment drops the NODE_OPTIONS that carries the resolver in the API process. The resolver only changes how
 * the child's own requires are found; the script inside the isolate never sees a require at all.
 */

'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');
const { envInt } = require('../utils/envNumber.mts');
const { createSlots, MAX_PER_KEY } = require('./codeSandboxSlots');

const CHILD = path.join(__dirname, 'codeSandboxChild.js');
/** The resolver, in the core root wherever this file lives; an absolute path, so the child finds it without NODE_OPTIONS. */
const RESOLVER = path.join(require('../moduleRoots.cjs').coreRoot, 'moduleRoots.cjs');
const CHILD_HEAP_MB = 128;
const MARGIN_MS = 3000;
const MAX_WALL_MS = 30_000;
/** What a child may inherit: what Node needs to start and find its modules, never a secret. */
const KEPT_ENV = ['PATH', 'NODE_ENV', 'LANG', 'TZ', 'HOME', 'TMPDIR'];
const MAX_CHILDREN = envInt('COWORK_SANDBOX_MAX_CHILDREN', 4, { min: 1 });
const CHILD_WAIT_MS = 20_000;
const BUSY = 'Too many scripts are running on this server right now, so this step did not start. Try again in a moment.';

/**
 * Slots for children: one cap for the whole process, which every org's scripts share, and a smaller one per org.
 * @param {{ maxChildren?: number, maxPerOrg?: number, waitMs?: number }} [opts]
 */
function createChildSlots({ maxChildren = MAX_CHILDREN, maxPerOrg = MAX_PER_KEY, waitMs = CHILD_WAIT_MS } = {}) {
    return createSlots({ maxTotal: maxChildren, maxPerKey: Math.min(maxPerOrg, maxChildren), maxWaitMs: waitMs, busyMessage: BUSY });
}
const childSlots = createChildSlots();

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

/** The child's Node options: its own heap limit, and the resolver. */
function childExecArgv() {
    return [`--max-old-space-size=${CHILD_HEAP_MB}`, '--require', RESOLVER];
}

/**
 * Run one script in a child process, once a slot is free. Resolves with what the script returned and what it logged;
 * rejects with the script's own error, a time-out, the child's end, or a wait for a slot that took too long.
 * `concurrencyKey` is the organisation the slot is counted against; it never reaches the child.
 * `deps` (tests): the slots and the fork to use.
 * @param {{ code: string, inputs?: unknown, limits?: Record<string, number>, mode?: 'live' | 'test', concurrencyKey?: string | null }} job
 * @param {{ slots?: { acquireSlot: (args?: { key?: string }) => Promise<() => void> }, fork?: typeof fork }} [deps]
 * @returns {Promise<{ result: unknown, logs: string[] }>}
 */
async function runCodeIsolated(job, deps = {}) {
    const release = await (deps.slots ?? childSlots).acquireSlot(job.concurrencyKey ? { key: job.concurrencyKey } : {});
    try {
        return await runInChild(job, deps.fork ?? fork);
    } finally {
        release();
    }
}

/**
 * The child process of one script.
 * @param {{ code: string, inputs?: unknown, limits?: Record<string, number>, mode?: 'live' | 'test' }} job
 * @param {typeof fork} forkChild
 * @returns {Promise<{ result: unknown, logs: string[] }>}
 */
function runInChild({ code, inputs = {}, limits = {}, mode = 'live' }, forkChild) {
    const wallMs = Math.min(MAX_WALL_MS, Number.isFinite(limits.wallMs) && limits.wallMs > 0 ? limits.wallMs : 5000);
    return new Promise((resolve, reject) => {
        const child = forkChild(CHILD, [], {
            env: childEnv(),
            execArgv: childExecArgv(),
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

module.exports = { runCodeIsolated, createChildSlots, childEnv, childExecArgv, CHILD_HEAP_MB, MAX_CHILDREN };
