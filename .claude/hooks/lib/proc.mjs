// Running the scanners, linters and test runners the hooks start, and reading
// what their exit means.
//
// A run that did not finish is not a pass. spawnSync reports a timeout or a
// signal as `status: null`, and the old hooks tested `if (res.status)`, which
// reads null as success: a secret scan that timed out let the commit through
// without a word.

import { spawn, spawnSync } from 'node:child_process';

// SIGKILL the child and everything it started. A scan is bash running
// gitleaks, and `node --test` and vitest run workers: killing only the direct
// child leaves the process doing the work running, and its open pipes keep
// the run from ever reporting (server/scripts/run-tests.mjs learned the same).
function killTree(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch {
            // group already gone
        }
    }
    try {
        child.kill('SIGKILL');
    } catch {
        // already reaped
    }
}

/**
 * Run `cmd args` without a shell. Resolves (never rejects) to the fields of
 * a spawnSync result, `{ status, signal, error, stdout, stderr }`, plus
 * `timedOut` and `ms`. On the timeout the whole process tree is killed.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts]
 */
export function run(cmd, args, { cwd, env, timeoutMs } = {}) {
    return new Promise((resolve) => {
        const started = Date.now();
        const out = [];
        const err = [];
        let timedOut = false;
        let settled = false;
        let timer = null;
        let child = null;

        const finish = (fields) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                status: null,
                signal: null,
                error: undefined,
                ...fields,
                stdout: Buffer.concat(out).toString('utf8'),
                stderr: Buffer.concat(err).toString('utf8'),
                timedOut,
                ms: Date.now() - started,
            });
        };

        try {
            child = spawn(cmd, args, {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                // Its own process group, so the timeout can signal all of it.
                detached: process.platform !== 'win32',
            });
        } catch (error) {
            finish({ error });
            return;
        }

        if (timeoutMs) {
            timer = setTimeout(() => {
                timedOut = true;
                killTree(child);
                // Should a grandchild survive holding the pipes, stop waiting.
                setTimeout(() => finish({ signal: 'SIGKILL' }), 2000).unref();
            }, timeoutMs);
        }
        child.stdout.on('data', (b) => out.push(b));
        child.stderr.on('data', (b) => err.push(b));
        child.on('error', (error) => finish({ error }));
        child.on('close', (status, signal) => finish({ status, signal }));
    });
}

/**
 * What a run's exit means:
 *   'passed'     exit 0
 *   'failed'     it ran to the end and answered no: an exit code in
 *                `failCodes`, or any non-zero code when that is not given
 *   'incomplete' it did not start, timed out, was killed, or exited with a
 *                code that is not one of its answers
 * Works on a spawnSync result as well as on run()'s. `reason` is for the
 * message.
 *
 * @param {{ status?: number|null, signal?: string|null, error?: Error & { code?: string }, timedOut?: boolean }} res
 * @param {{ failCodes?: number[] }} [opts]
 * @returns {{ outcome: 'passed'|'failed'|'incomplete', reason: string }}
 */
export function classify(res, { failCodes } = {}) {
    if (!res) return { outcome: 'incomplete', reason: 'did not run' };
    if (res.timedOut || res.error?.code === 'ETIMEDOUT') return { outcome: 'incomplete', reason: 'timed out' };
    if (res.error) {
        const reason = res.error.code === 'ENOENT' ? 'command not found' : `could not run: ${res.error.message}`;
        return { outcome: 'incomplete', reason };
    }
    if (res.signal) return { outcome: 'incomplete', reason: `killed by ${res.signal}` };
    if (typeof res.status !== 'number') return { outcome: 'incomplete', reason: 'no exit status' };
    if (res.status === 0) return { outcome: 'passed', reason: 'exit 0' };
    if (!failCodes || failCodes.includes(res.status)) return { outcome: 'failed', reason: `exit ${res.status}` };
    return { outcome: 'incomplete', reason: `exit ${res.status}` };
}

/** Output without the colour codes the scripts print for a terminal. */
export const plain = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
