#!/usr/bin/env node
/**
 * Prove that an edition of the server starts: schema on an empty database, boot, probe, stop.
 *
 * The boundary ratchet catches the next import from a core file into a module, but not a core
 * file that needs a module's TABLE, nor a boot step that needs a module. This runs the real
 * thing against a real (empty) Postgres database:
 *
 *   1. `node migrateDb.js` in server/ with the chosen edition; fails on a non-zero exit and
 *      prints every error-level log line;
 *   2. the same once more, on what the first run left (the schema is idempotent);
 *   3. counts the tables in `public` and prints the number; `--expect-tables n` fails when it
 *      differs;
 *   4. starts `node index.js`, polls GET /api/ready until 200 (fails after 90 s, or at once
 *      when the process exits), then probes: /api/health 200, /api/kb 401 (a core route that
 *      needs a session), and /api/automation and /api/datatables: 404 when the edition leaves
 *      their module out, 401 when it has it;
 *   5. sends SIGTERM and fails unless the process exits 0 within 30 s;
 *   6. fails when the server log holds `is not present` or `Cannot find module` (a core file
 *      reached for a module), and prints the error-level lines it saw (some are expected on a
 *      bare install: no SERVICES_API_KEY, an ephemeral OPAQUE setup, a pricing fetch).
 *
 * Editions: `--hide-modules all|<ids>` (BEEFLOW_HIDE_MODULES: the modules' files count as
 * absent), `--edition core` (BEEFLOW_EDITION: the files are there, the modules are not
 * loaded), `--modules a,b` (BEEFLOW_MODULES), or none of them (every module).
 *
 * The server runs with NODE_ENV=production, OTEL_ENABLED=false and throwaway secret values
 * (named as such below); nothing else of the caller's environment reaches it but PATH and HOME.
 *
 *   node scripts/core-boot-check.mjs --database <url> [--hide-modules all | --edition core | --modules a,b]
 *                                    [--port 3199] [--expect-tables n]
 *
 * CI: ci.yml's `server-core` job. Pure parts are tested in core-boot-check.test.mjs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');

// Throwaway CI values, never a real secret: the server refuses to start without a session
// secret and a master key of 32+ characters.
const THROWAWAY_SESSION_SECRET = 'ci-boot-check-throwaway-session-secret-not-real';
const THROWAWAY_MASTER_KEY = 'ci-boot-check-throwaway-master-key-not-a-real-one';

const READY_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 30_000;

/** Routes owned by a module: 404 when the edition leaves the module out, 401 when it has it. */
export const MODULE_PROBES = [
    { path: '/api/automation', module: 'automation' },
    { path: '/api/datatables', module: 'datatables' },
];

/** A core file that reached for a module leaves one of these in the log. */
export const FORBIDDEN_LOG = ['is not present', 'Cannot find module'];

const VALUE_FLAGS = new Map([
    ['--database', 'database'],
    ['--hide-modules', 'hide'],
    ['--edition', 'edition'],
    ['--modules', 'modules'],
    ['--port', 'port'],
    ['--expect-tables', 'expectTables'],
]);

/**
 * @typedef {{ database: string, hide: string | null, edition: string | null, modules: string | null,
 *   port: number, expectTables: number | null }} Options
 */

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {Options}
 */
export function parseArgs(argv) {
    /** @type {Record<string, string>} */
    const raw = {};
    for (let i = 0; i < argv.length; i++) {
        const key = VALUE_FLAGS.get(argv[i]);
        if (!key) throw new Error(`unknown argument: ${argv[i]}`);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
        raw[key] = value;
        i++;
    }
    if (!raw.database) throw new Error('--database <url> is required');
    const chosen = ['hide', 'edition', 'modules'].filter((k) => raw[k] !== undefined);
    if (chosen.length > 1) throw new Error('choose one of --hide-modules, --edition, --modules');
    return {
        database: raw.database,
        hide: raw.hide ?? null,
        edition: raw.edition ?? null,
        modules: raw.modules ?? null,
        port: raw.port === undefined ? 3199 : positiveInt(raw.port, '--port'),
        expectTables: raw.expectTables === undefined ? null : positiveInt(raw.expectTables, '--expect-tables'),
    };
}

/**
 * @param {string} value
 * @param {string} flag
 */
function positiveInt(value, flag) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a whole number, got ${value}`);
    return n;
}

/** @param {string} list */
function idList(list) {
    return list.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The environment the server and the migration runner get.
 * @param {Options} opts
 * @param {NodeJS.ProcessEnv} base the caller's environment (only PATH and HOME are taken)
 * @returns {Record<string, string>}
 */
export function serverEnv(opts, base) {
    /** @type {Record<string, string>} */
    const env = {
        NODE_ENV: 'production',
        OTEL_ENABLED: 'false',
        PORT: String(opts.port),
        SESSION_SECRET: THROWAWAY_SESSION_SECRET,
        MASTER_ENCRYPTION_KEY: THROWAWAY_MASTER_KEY,
        CORE_DATABASE_URL: opts.database,
    };
    if (base.PATH) env.PATH = base.PATH;
    if (base.HOME) env.HOME = base.HOME;
    if (opts.hide) env.BEEFLOW_HIDE_MODULES = opts.hide;
    if (opts.edition) env.BEEFLOW_EDITION = opts.edition;
    if (opts.modules) env.BEEFLOW_MODULES = opts.modules;
    return env;
}

/**
 * Whether the edition loads a module: true, false, or null when it depends on how the loader
 * treats `requires` (a module only pulled in by a listed one) and is therefore not asserted.
 * @param {Options} opts
 * @param {string} id
 * @param {Record<string, { requires?: string[] }>} moduleMap `modules` of scripts/module-map.json
 * @returns {boolean | null}
 */
export function editionHas(opts, id, moduleMap) {
    if (opts.hide) return !(opts.hide === 'all' || idList(opts.hide).includes(id));
    if (opts.edition) return opts.edition.trim().toLowerCase() !== 'core';
    if (!opts.modules) return true;
    const listed = idList(opts.modules);
    if (listed.includes(id)) return true;
    return requiredBy(listed, moduleMap).has(id) ? null : false;
}

/**
 * Every module the listed ones require, transitively (the listed ones not included).
 * @param {string[]} listed
 * @param {Record<string, { requires?: string[] }>} moduleMap
 */
function requiredBy(listed, moduleMap) {
    const seen = new Set();
    const queue = [...listed];
    while (queue.length > 0) {
        const id = /** @type {string} */ (queue.shift());
        for (const dep of moduleMap[id]?.requires ?? []) {
            if (seen.has(dep)) continue;
            seen.add(dep);
            queue.push(dep);
        }
    }
    for (const id of listed) seen.delete(id);
    return seen;
}

/**
 * The probes and the status each must answer (`expect` null: printed, not asserted).
 * @param {Options} opts
 * @param {Record<string, { requires?: string[] }>} moduleMap
 * @returns {{ path: string, expect: number | null }[]}
 */
export function probesFor(opts, moduleMap) {
    const probes = [
        { path: '/api/health', expect: /** @type {number | null} */ (200) },
        { path: '/api/kb', expect: /** @type {number | null} */ (401) },
    ];
    for (const probe of MODULE_PROBES) {
        const has = editionHas(opts, probe.module, moduleMap);
        probes.push({ path: probe.path, expect: has === null ? null : has ? 401 : 404 });
    }
    return probes;
}

/**
 * The error-level lines of a log: JSON lines of level error or fatal (pino names or numbers),
 * and plain lines that start like an uncaught error.
 * @param {string} text
 * @returns {string[]}
 */
export function errorLines(text) {
    return text.split('\n').filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
            try {
                const level = JSON.parse(trimmed).level;
                return level === 'error' || level === 'fatal' || (typeof level === 'number' && level >= 50);
            } catch {
                return false;
            }
        }
        return /^(\w*Error|\[error\])\b/.test(trimmed);
    });
}

/**
 * The lines of a log that show a core file reaching for a module.
 * @param {string} text
 * @returns {string[]}
 */
export function forbiddenLines(text) {
    return text.split('\n').filter((line) => FORBIDDEN_LOG.some((needle) => line.includes(needle)));
}

/**
 * The failures of one step, as messages (empty: the step passed).
 * @param {{ path: string, expect: number | null }[]} probes
 * @param {Record<string, number>} answers status per path
 * @returns {string[]}
 */
export function probeFailures(probes, answers) {
    return probes
        .filter((p) => p.expect !== null && answers[p.path] !== p.expect)
        .map((p) => `GET ${p.path} answered ${answers[p.path]}, expected ${p.expect}`);
}

// ── the run ────────────────────────────────────────────────────────────────

/** @param {string} msg */
function say(msg) {
    console.log(`[core-boot-check] ${msg}`);
}

/**
 * @param {string} title
 * @param {string[]} lines
 */
function printLines(title, lines) {
    say(`${title}: ${lines.length}`);
    for (const line of lines) console.log(`    ${line}`);
}

/**
 * Run `node migrateDb.js` in server/ and collect its output.
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number | null, output: string }>}
 */
function runMigrate(env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['migrateDb.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        child.on('close', (code) => resolve({ code, output }));
    });
}

/**
 * @param {string} label
 * @param {Record<string, string>} env
 * @returns {Promise<string[]>}
 */
async function migrateStep(label, env) {
    const started = Date.now();
    const { code, output } = await runMigrate(env);
    say(`${label}: exit ${code} after ${Math.round((Date.now() - started) / 1000)} s`);
    printLines(`${label}: error-level lines`, errorLines(output));
    if (code === 0) return [];
    console.log(output.split('\n').slice(-40).join('\n'));
    return [`${label} exited ${code}`];
}

/**
 * @param {string} database
 * @returns {Promise<number>}
 */
async function countTables(database) {
    const pg = createRequire(path.join(SERVER, 'package.json'))('pg');
    const client = new pg.Client({ connectionString: database });
    await client.connect();
    try {
        const res = await client.query(
            "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        );
        return res.rows[0].n;
    } finally {
        await client.end();
    }
}

/**
 * @param {number} port
 * @param {string} route
 * @returns {Promise<number>} the status, 0 when nothing answered
 */
async function statusOf(port, route) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        await res.arrayBuffer();
        return res.status;
    } catch {
        return 0;
    }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {number} port
 * @param {{ exited: boolean }} state
 * @returns {Promise<number | null>} seconds until ready, null when it never was
 */
async function waitReady(port, state) {
    const started = Date.now();
    while (Date.now() - started < READY_TIMEOUT_MS && !state.exited) {
        if ((await statusOf(port, '/api/ready')) === 200) return Math.round((Date.now() - started) / 1000);
        await sleep(1000);
    }
    return null;
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ exited: boolean, code: number | null, signal: string | null }} state
 * @returns {Promise<string[]>}
 */
async function stopServer(child, state) {
    if (state.exited) return [`the server exited early (code ${state.code}, signal ${state.signal})`];
    child.kill('SIGTERM');
    const started = Date.now();
    while (!state.exited && Date.now() - started < STOP_TIMEOUT_MS) await sleep(250);
    if (!state.exited) {
        child.kill('SIGKILL');
        return [`the server did not exit within ${STOP_TIMEOUT_MS / 1000} s of SIGTERM`];
    }
    say(`stopped: exit ${state.code} after ${Math.round((Date.now() - started) / 1000)} s`);
    return state.code === 0 ? [] : [`the server exited ${state.code} (signal ${state.signal}) on SIGTERM`];
}

/**
 * @param {Options} opts
 * @param {Record<string, string>} env
 * @param {{ path: string, expect: number | null }[]} probes
 * @returns {Promise<string[]>}
 */
async function bootStep(opts, env, probes) {
    const child = spawn(process.execPath, ['index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const state = { exited: false, code: /** @type {number | null} */ (null), signal: /** @type {string | null} */ (null) };
    child.on('exit', (code, signal) => Object.assign(state, { exited: true, code, signal }));

    const failures = [];
    const seconds = await waitReady(opts.port, state);
    say(seconds === null ? 'not ready' : `ready after ${seconds} s`);
    if (seconds === null) failures.push(`/api/ready never answered 200 (${state.exited ? 'the process exited' : 'timed out'})`);
    else failures.push(...(await probeStep(opts.port, probes)));
    failures.push(...(await stopServer(child, state)));

    printLines('server: error-level lines', errorLines(log));
    const forbidden = forbiddenLines(log);
    printLines('server: lines of a core file reaching for a module', forbidden);
    if (forbidden.length > 0) failures.push(`${forbidden.length} log line(s) show a core file reaching for a module`);
    if (seconds === null) console.log(log.split('\n').slice(-60).join('\n'));
    return failures;
}

/**
 * @param {number} port
 * @param {{ path: string, expect: number | null }[]} probes
 */
async function probeStep(port, probes) {
    /** @type {Record<string, number>} */
    const answers = {};
    for (const probe of probes) {
        answers[probe.path] = await statusOf(port, probe.path);
        say(`GET ${probe.path} -> ${answers[probe.path]} (expected ${probe.expect ?? 'not asserted'})`);
    }
    return probeFailures(probes, answers);
}

/** @param {string[]} argv */
async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        console.error(`core-boot-check: ${/** @type {Error} */ (e).message}`);
        process.exit(2);
    }
    const env = serverEnv(opts, process.env);
    const moduleMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/module-map.json'), 'utf8')).modules;
    say(`edition: ${opts.hide ? `hide ${opts.hide}` : opts.edition ? `edition ${opts.edition}` : opts.modules ? `modules ${opts.modules}` : 'every module'}`);

    const before = await countTables(opts.database);
    if (before > 0) {
        console.error(`core-boot-check: the database already holds ${before} tables in public; give it an empty one`);
        process.exit(1);
    }
    const failures = [...(await migrateStep('migrate (first run)', env)), ...(await migrateStep('migrate (second run)', env))];
    const tables = await countTables(opts.database);
    say(`tables in public: ${tables}${opts.expectTables === null ? '' : ` (expected ${opts.expectTables})`}`);
    if (opts.expectTables !== null && tables !== opts.expectTables) failures.push(`${tables} tables, expected ${opts.expectTables}`);
    failures.push(...(await bootStep(opts, env, probesFor(opts, moduleMap))));

    if (failures.length > 0) {
        for (const f of failures) console.error(`core-boot-check: FAIL ${f}`);
        process.exit(1);
    }
    say('passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
