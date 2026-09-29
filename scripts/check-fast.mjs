#!/usr/bin/env node
/**
 * check:fast — what CI's cheap gates will say, in a few seconds.
 *
 *   npm run check:fast                     # or: node scripts/check-fast.mjs
 *   node scripts/check-fast.mjs --list     # what would run, without running it
 *   node scripts/check-fast.mjs --only i18n    # just the gates whose name has "i18n"
 *
 * Runs, at most os.availableParallelism() at a time:
 *   - every root package.json script whose name starts with `lint:`, except
 *     the ones in DENYLIST below. The list is read from package.json on every
 *     run, so a ratchet added there is gated here without touching this file;
 *   - scripts/i18n-key-guard.mjs against the merge-base with origin/main (ci.yml
 *     runs it against the pull request's base);
 *   - scripts/scan-secrets.sh --range <merge-base>..HEAD, the commit scan of
 *     the required `scan` context (secret-scan.yml).
 *
 * Nothing is installed and nothing is fetched: a stale origin/main only moves
 * the merge-base back. The full test suites, eslint and the builds stay in CI.
 *
 * Each gate's command string is read from package.json and run the way npm
 * would run it, minus npm: an `npm run` per gate is one more process start
 * per gate, and on Windows npm's script-shell is cmd.exe, which cannot run a
 * .sh file. So a command that invokes a *.sh file goes to bash (Git Bash on
 * Windows); every other one to the platform shell. Without a bash the .sh
 * gates are SKIP, never PASS.
 *
 * Output: one line per gate as it finishes (PASS / FAIL / SKIP and how long
 * it took), then the full output of every failing gate, then a summary.
 * Exit 0 when nothing failed, 1 when a gate failed, 2 on a usage error.
 * A gate that times out or is killed is a FAIL: it did not say yes. One that
 * passes but takes over 10 s is named in the summary as a DENYLIST candidate.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * lint:* scripts check:fast leaves out, and why. Each needs something this
 * command does not have (the network, an install, a build, a coverage run)
 * or takes long enough to defeat the point of it. CI runs all of them.
 */
export const DENYLIST = new Map([
    ['lint:deps', 'npm audit: needs the network'],
    ['lint:deps:test', 'unit tests of audit-ratchet.mjs (~8 s); `npm run test:scripts` runs them'],
    ['lint:budget', 'full eslint over agent-hub and server (~3 min), needs their node_modules'],
    ['lint:bundle', 'needs a production build of agent-hub'],
    ['lint:coverage', 'needs a coverage run of each package'],
    ['lint:duplication', 'jscpd over the whole tree (~7 s), needs the root node_modules'],
    ['lint:gitleaks', 'full-tree scan; the commit hook scans the changed files and scan-secrets --range the commits'],
]);

// Long enough for any gate on a slow Windows disk, short enough that a hung
// one is reported instead of waited on.
const GATE_TIMEOUT_MS = 120_000;

// A gate that passes but takes longer than this is named in the summary: the
// lint:* list is open-ended, and a new script that runs eslint over a whole
// package would otherwise turn "a few seconds" into a minute without a word.
const SLOW_GATE_MS = 10_000;

const BASH_CANDIDATES = ['bash', 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'];

/** Does this command string run a *.sh file (and so need bash)? */
export function invokesShellScript(command) {
    return /\w\.sh(?=$|[\s;&|)"'])/.test(command);
}

/** The lint:* scripts of a package.json `scripts` object, minus the DENYLIST. */
export function lintGates(scripts = {}) {
    return Object.entries(scripts)
        .filter(([name]) => name.startsWith('lint:') && !DENYLIST.has(name))
        .map(([name, command]) => ({ name, command, bash: invokesShellScript(command) }));
}

/**
 * The first bash that runs, or null. A bare `bash` on Windows can be WSL's
 * launcher with no distribution behind it, so each candidate has to exit 0.
 */
export function findBash(candidates = BASH_CANDIDATES) {
    for (const bash of candidates) {
        const res = spawnSync(bash, ['-c', 'exit 0'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
        if (!res.error && res.status === 0) return bash;
    }
    return null;
}

function git(root, args) {
    const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * The two gates that compare against main. Both need the merge-base of HEAD
 * and origin/main; without it they are listed with the reason they skip.
 */
export function branchGates(root, gitFn = git) {
    const base = gitFn(root, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'])
        ? gitFn(root, ['merge-base', 'HEAD', 'origin/main'])
        : null;
    const skip = base ? null : 'origin/main does not resolve in this clone (or has no merge-base with HEAD); CI runs this gate';
    return [
        {
            name: 'i18n-key-guard',
            command: `node scripts/i18n-key-guard.mjs --base ${base ?? '<merge-base>'}`,
            bash: false,
            skip,
        },
        {
            name: 'scan-secrets --range',
            command: `./scripts/scan-secrets.sh --range ${base ?? '<merge-base>'}..HEAD`,
            bash: true,
            skip,
            // Without gitleaks the script exits 2 and says so: its regex
            // fallback reads only the tree. Not a finding, and not a pass.
            skipWhen: (res) => (res.code === 2 && /needs gitleaks/.test(res.output)
                ? 'gitleaks is not installed, and --range has no regex fallback; CI\'s scan context runs it'
                : null),
        },
    ];
}

// SIGKILL the gate and everything it started: a shell running `a && b`, or
// bash running gitleaks, would otherwise outlive the timeout holding the pipes.
function killTree(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        // already gone
    }
}

const running = new Set();

/** Run one gate. Resolves to { code, signal, output, timedOut, error, ms }. */
function runGate(gate, { root, env, bash, timeoutMs }) {
    return new Promise((resolve) => {
        const started = Date.now();
        const chunks = [];
        let timedOut = false;
        let timer = null;
        let child;
        const finish = (fields) => {
            clearTimeout(timer);
            running.delete(child);
            resolve({ code: null, signal: null, timedOut, ...fields, output: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started });
        };
        const opts = {
            cwd: root,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // Its own process group, so a timeout can signal all of it.
            detached: process.platform !== 'win32',
        };
        try {
            child = gate.bash ? spawn(bash, ['-c', gate.command], opts) : spawn(gate.command, { ...opts, shell: true });
        } catch (error) {
            finish({ error });
            return;
        }
        running.add(child);
        timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
            // Should something outside the group still hold the pipes, stop waiting.
            setTimeout(() => finish({ signal: 'SIGKILL' }), 2000).unref();
        }, timeoutMs);
        child.stdout.on('data', (b) => chunks.push(b));
        child.stderr.on('data', (b) => chunks.push(b));
        child.on('error', (error) => finish({ error }));
        child.on('close', (code, signal) => finish({ code, signal }));
    });
}

/** PASS / FAIL / SKIP for a finished run, with the reason shown next to it. */
export function verdict(gate, res, timeoutMs = GATE_TIMEOUT_MS) {
    if (res.timedOut) return { status: 'FAIL', reason: `timed out after ${timeoutMs / 1000} s` };
    if (res.error) return { status: 'FAIL', reason: `could not start: ${res.error.message}` };
    if (res.signal) return { status: 'FAIL', reason: `killed by ${res.signal}` };
    if (res.code === 0) return { status: 'PASS', reason: '' };
    const skip = gate.skipWhen?.(res);
    if (skip) return { status: 'SKIP', reason: skip };
    return { status: 'FAIL', reason: `exit ${res.code}` };
}

async function pool(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

// What npm adds before it runs a script: the root's own .bin on PATH.
function npmLikeEnv(root) {
    const env = { ...process.env };
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = [path.join(root, 'node_modules', '.bin'), env[key]].filter(Boolean).join(path.delimiter);
    return env;
}

const USAGE = 'usage: node scripts/check-fast.mjs [--list] [--only <substring>]';

/**
 * @param {object} [o]
 * @param {string[]} [o.argv]      CLI arguments
 * @param {string} [o.root]        directory holding the package.json
 * @param {(candidates?: string[]) => string|null} [o.findBash]
 * @param {(root: string) => object[]} [o.branchGates]
 * @param {number} [o.parallel]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.slowMs]      a gate slower than this is named in the summary
 * @param {(line: string) => void} [o.print]
 * @returns {Promise<number>} the exit code
 */
export async function main({
    argv = process.argv.slice(2),
    root = ROOT,
    findBash: bashLookup = findBash,
    branchGates: branchGatesFn = branchGates,
    parallel = os.availableParallelism(),
    timeoutMs = GATE_TIMEOUT_MS,
    slowMs = SLOW_GATE_MS,
    print = (line) => process.stdout.write(`${line}\n`),
} = {}) {
    let only = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--list') continue;
        if (argv[i] === '--only') {
            only = argv[++i];
            if (!only || only.startsWith('--')) {
                print(`check-fast: --only needs a substring of a gate name\n${USAGE}`);
                return 2;
            }
            continue;
        }
        if (argv[i] === '--help' || argv[i] === '-h') {
            print(USAGE);
            return 0;
        }
        print(`check-fast: unexpected argument '${argv[i]}'\n${USAGE}`);
        return 2;
    }
    const list = argv.includes('--list');

    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    let gates = [...lintGates(scripts), ...branchGatesFn(root)];
    if (only !== null) gates = gates.filter((g) => g.name.includes(only));
    if (gates.length === 0) {
        print(`check-fast: no gate matches --only '${only}'`);
        return 2;
    }
    const width = Math.max(...gates.map((g) => g.name.length));

    if (list) {
        print(`check:fast would run ${gates.length} gate(s), up to ${parallel} at a time:`);
        for (const g of gates) {
            print(`  ${g.name.padEnd(width)}  ${g.bash ? 'bash ' : 'shell'}  ${g.command}${g.skip ? `\n  ${''.padEnd(width)}  (skips: ${g.skip})` : ''}`);
        }
        print('Left out (DENYLIST in scripts/check-fast.mjs; CI runs them):');
        const w = Math.max(...[...DENYLIST.keys()].map((k) => k.length));
        for (const [name, why] of DENYLIST) print(`  ${name.padEnd(w)}  ${why}`);
        return 0;
    }

    const bash = gates.some((g) => g.bash && !g.skip) ? bashLookup() : null;
    const env = npmLikeEnv(root);
    const started = Date.now();
    const results = [];
    const line = (status, name, ms, reason) =>
        print(`  ${status}  ${name.padEnd(width)}  ${(ms / 1000).toFixed(1).padStart(5)} s${reason ? `  ${reason}` : ''}`);

    print(`check:fast: ${gates.length} gate(s), up to ${parallel} at a time`);
    await pool(gates, parallel, async (gate) => {
        let result;
        if (gate.skip) result = { gate, status: 'SKIP', reason: gate.skip, ms: 0 };
        else if (gate.bash && !bash) {
            result = { gate, status: 'SKIP', reason: `no bash found (tried ${BASH_CANDIDATES.join(', ')})`, ms: 0 };
        } else {
            const res = await runGate(gate, { root, env, bash, timeoutMs });
            result = { gate, res, ...verdict(gate, res, timeoutMs), ms: res.ms };
        }
        results.push(result);
        line(result.status, gate.name, result.ms, result.status === 'PASS' ? '' : result.reason);
    });

    const failed = results.filter((r) => r.status === 'FAIL');
    for (const r of failed) {
        print(`\n──── ${r.gate.name} (${r.reason}) ────\n$ ${r.gate.command}`);
        print((r.res?.output || '').trimEnd() || '(no output)');
    }
    const slow = results.filter((r) => r.status !== 'FAIL' && r.ms > slowMs);
    if (slow.length) {
        print(`\nSlow: ${slow.map((r) => `${r.gate.name} (${(r.ms / 1000).toFixed(1)} s)`).join(', ')}. check:fast is meant to take`
            + ' seconds; a gate that needs this long belongs in DENYLIST (scripts/check-fast.mjs), with its reason.');
    }
    const count = (s) => results.filter((r) => r.status === s).length;
    const wall = ((Date.now() - started) / 1000).toFixed(1);
    print(`\ncheck:fast: ${count('PASS')} passed, ${count('SKIP')} skipped, ${failed.length} failed in ${wall} s`
        + (failed.length ? ` — failing: ${failed.map((r) => r.gate.name).join(', ')}` : ''));
    return failed.length ? 1 : 0;
}

// Run as a command, not imported by a test (see entry-point.mjs).
if (isEntryPoint(import.meta.url)) {
    // Ctrl-C: the gates run in their own process groups, so take them along.
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
        process.on(sig, () => {
            for (const child of running) killTree(child);
            process.exit(code);
        });
    }
    main().then(
        (code) => { process.exitCode = code; },
        (e) => {
            console.error(`check-fast: ${e.message}`);
            process.exitCode = 2;
        },
    );
}
