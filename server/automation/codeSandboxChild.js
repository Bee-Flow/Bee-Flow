// @typecheck strict
/**
 * The child process of an out-of-process script (./codeSandboxProcess.js): it receives ONE job over IPC, runs it in
 * the isolated-vm sandbox (./codeSandbox.js) with no bridges at all (no network, no apps, no secrets), sends back the
 * result or the error, and exits. It is started with an environment that holds no secrets and its own heap limit, so
 * even a script that escaped the V8 isolate would find no credentials and no memory of the API process.
 */

'use strict';

/** @typedef {{ code: string, inputs: unknown, limits: Record<string, number>, mode: 'live' | 'test' }} Job */

process.once('message', async (/** @type {Job} */ job) => {
    /** @type {Record<string, unknown>} */
    let reply;
    try {
        const { runCode } = require('./codeSandbox');
        const ran = await runCode({ code: job.code, inputs: /** @type {Record<string, unknown>} */ (job.inputs ?? {}), limits: job.limits, mode: job.mode, bridges: {} });
        reply = { ok: true, result: ran.result, logs: ran.logs };
    } catch (e) {
        reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (process.send) process.send(reply, () => process.exit(0));
    else process.exit(0);
});
