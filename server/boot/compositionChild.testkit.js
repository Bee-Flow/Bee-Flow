'use strict';
/**
 * Run one of the composition recorders (boot/composition*.testkit.cjs) in a
 * child process and return the JSON it wrote. The child gets this process's
 * environment (or the one given) minus the switches that would change the recording: core mode
 * (BEEFLOW_HIDE_MODULES), the edition (BEEFLOW_EDITION) and DEPLOYMENT_MODE, so
 * every recording is of the full tree with every module available.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..');
const DROPPED = ['BEEFLOW_HIDE_MODULES', 'BEEFLOW_EDITION', 'DEPLOYMENT_MODE'];

/**
 * @param {string} recorder file name in boot/
 * @param {string[]} [args] after the output file
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts] `env` replaces the inherited one
 * @returns {unknown} the recorder's JSON
 */
function runRecorder(recorder, args = [], { env: given, timeoutMs = 120_000 } = {}) {
    const out = path.join(os.tmpdir(), `bf-${path.basename(recorder, '.cjs')}-${process.pid}-${Date.now()}.json`);
    const env = { ...(given || process.env) };
    for (const name of DROPPED) delete env[name];
    try {
        const res = spawnSync(process.execPath, [path.join(__dirname, recorder), out, ...args], {
            cwd: SERVER, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
        });
        if (res.status !== 0) {
            const tail = String(res.stderr || res.error || '').split('\n').slice(-25).join('\n');
            throw new Error(`${recorder} failed (exit ${res.status}):\n${tail}`);
        }
        return JSON.parse(fs.readFileSync(out, 'utf8'));
    } finally {
        fs.rmSync(out, { force: true });
    }
}

module.exports = { runRecorder };
