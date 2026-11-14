#!/usr/bin/env node
/**
 * Mutation sample — do the tests next to a file notice when its logic is
 * changed? A bounded, repeatable sample over the code where a silent change is
 * most expensive (sign-in, licence checks, encryption).
 *
 * Line coverage says a line ran, not that a test would fail if the line were
 * wrong. This changes one thing at a time in a source file (a mutant), runs
 * the tests NEXT TO that file, and counts the mutants no test noticed
 * (survivors). A survivor is either a missing test case or a change that makes
 * no observable difference (an equivalent mutant); reading the list is the
 * point of the run.
 *
 * What is changed (one per mutant, found on the syntax tree, never in a
 * comment, a string or a type):
 *   equality        === <-> !==, == <-> !=
 *   boundary        < <-> <=, > <-> >=
 *   logical         && <-> ||
 *   arithmetic      + <-> -   (not next to a string literal)
 *   negate-condition  if (c) / while (c) / c ? a : b  ->  !(c)
 *   remove-negation   !x -> x
 *   return-value    return true <-> return false, return <expr> -> return undefined
 *   boolean-literal true <-> false elsewhere
 *   remove-call     a call statement is dropped (not logging)
 *
 * The sample: <package>/.mutation-ratchet.json names the groups (folders or
 * files), how many mutants and the seed. Each group gets an equal share, spread
 * round-robin over its files that have a test next to them (`x.test.js`,
 * `x.<anything>.test.js`), so the same tree gives the same mutants. A file's
 * tests must pass unchanged first; a mutant is KILLED when a test file fails or
 * runs out of time (four times its unchanged time, at least
 * MUTATION_MIN_TIMEOUT_MS, default 20000; 0 = no time-out).
 *
 * Tests under another name: a route file is often exercised by a test named
 * after the feature, not the file. `"tests": { "<source>": ["<test>", ...] }`
 * in the ratchet file names those; they run for that source file's mutants on
 * top of the tests next to it. The map does not decide which files are
 * sampled (that stays "has a test next to it"), so filling it leaves the
 * sample as it is. A path in the map or in a group that is not there is an
 * error: a moved file would otherwise drop out without a word.
 *
 * Safety: one mutant at a time, written into the working tree; the original
 * bytes go back in a `finally`, on SIGINT/SIGTERM and on an uncaught error, and
 * each file is compared with its original bytes when its mutants are done. The
 * original is also kept in a journal under the temp directory, so a run that
 * was killed outright is undone by the next start (or by `--restore` alone).
 * Each test process is bounded in time and memory (see runTest). Run it in a
 * clean checkout of your own, never while something else builds from it.
 *
 * Usage (from the repo root, with the environment the package's tests need):
 *   node scripts/mutation-sample.mjs <package>                  the sample, kill rate per group, the survivors
 *   node scripts/mutation-sample.mjs <package> --gate           also fail under the floor in the ratchet file
 *   node scripts/mutation-sample.mjs <package> --update         raise the floor (never lowers it)
 *   node scripts/mutation-sample.mjs <package> --json <file>    write every mutant and its verdict
 *   node scripts/mutation-sample.mjs <package> --replay <file>  run the survivors of an earlier --json again
 *   node scripts/mutation-sample.mjs <package> --list           print the sample, run nothing
 *   node scripts/mutation-sample.mjs <package> --restore        only put back what a killed run left behind
 *   options: --count <n>  --seed <n>  --per-file <n>  --only <group>
 *
 * The floor sits five points under the measurement it was taken from: the
 * sample moves when the code does, and at a few hundred mutants that is a few
 * points either way. It takes minutes, so it is not a lint:* script.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = Object.freeze({ count: 180, seed: 20261114, perFile: 6 });
const SOURCE = /\.(?:[cm]?js|mts)$/;
const TEST = /\.test\.[cm]?[jt]s$|\.testkit\.|\.testutil\./;
/** Calls whose removal nothing can observe. */
const UNOBSERVABLE_CALL = /^(?:log|logger|console|debug)\b/;

/** The TypeScript API (the root's `typescript-api`), used as a parser only. */
export function loadTs() {
    const name = 'typescript-api';
    return createRequire(path.join(ROOT, 'package.json'))(name);
}

/** A small seeded generator (mulberry32): the same seed, the same sample. */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher-Yates with the seeded generator; returns a new array. */
export function shuffled(list, random) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Every place in a source text this tool can change.
 * @param {any} ts
 * @param {string} text
 * @param {string} fileName
 * @returns {{ op: string, start: number, end: number, replacement: string, line: number, original: string }[]}
 */
export function mutantsOf(ts, text, fileName) {
    const K = ts.SyntaxKind;
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const SWAP = new Map([
        [K.EqualsEqualsEqualsToken, ['!==', 'equality']], [K.ExclamationEqualsEqualsToken, ['===', 'equality']],
        [K.EqualsEqualsToken, ['!=', 'equality']], [K.ExclamationEqualsToken, ['==', 'equality']],
        [K.LessThanToken, ['<=', 'boundary']], [K.LessThanEqualsToken, ['<', 'boundary']],
        [K.GreaterThanToken, ['>=', 'boundary']], [K.GreaterThanEqualsToken, ['>', 'boundary']],
        [K.AmpersandAmpersandToken, ['||', 'logical']], [K.BarBarToken, ['&&', 'logical']],
        [K.PlusToken, ['-', 'arithmetic']], [K.MinusToken, ['+', 'arithmetic']],
    ]);
    const out = [];
    const add = (op, start, end, replacement) => {
        out.push({ op, start, end, replacement, line: sf.getLineAndCharacterOfPosition(start).line + 1, original: text.slice(start, end) });
    };
    const isStringy = (n) => ts.isStringLiteralLike(n) || ts.isTemplateExpression(n);
    const isNegation = (n) => ts.isPrefixUnaryExpression(n) && n.operator === K.ExclamationToken;
    const condition = (expr) => {
        // `if (!x)` is already covered by remove-negation on the `!`.
        if (!isNegation(expr)) add('negate-condition', expr.getStart(sf), expr.getEnd(), `!(${expr.getText(sf)})`);
    };
    const visit = (node) => {
        if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node) || node.kind === K.JSDoc) return;
        if (ts.isBinaryExpression(node)) {
            const swap = SWAP.get(node.operatorToken.kind);
            const stringConcat = swap?.[1] === 'arithmetic' && (isStringy(node.left) || isStringy(node.right));
            if (swap && !stringConcat) add(swap[1], node.operatorToken.getStart(sf), node.operatorToken.getEnd(), swap[0]);
        } else if (ts.isIfStatement(node) || ts.isWhileStatement(node)) {
            condition(node.expression);
        } else if (ts.isConditionalExpression(node)) {
            condition(node.condition);
        } else if (isNegation(node)) {
            add('remove-negation', node.getStart(sf), node.operand.getStart(sf), '');
        } else if (ts.isReturnStatement(node) && node.expression) {
            const e = node.expression;
            if (e.kind === K.TrueKeyword) add('return-value', e.getStart(sf), e.getEnd(), 'false');
            else if (e.kind === K.FalseKeyword) add('return-value', e.getStart(sf), e.getEnd(), 'true');
            else if (e.kind !== K.NullKeyword && !(ts.isIdentifier(e) && e.text === 'undefined') && !ts.isVoidExpression(e)) add('return-value', e.getStart(sf), e.getEnd(), 'undefined');
            // The literal is handled here: do not flip it a second time below.
            if (e.kind === K.TrueKeyword || e.kind === K.FalseKeyword) return;
        } else if (node.kind === K.TrueKeyword || node.kind === K.FalseKeyword) {
            add('boolean-literal', node.getStart(sf), node.getEnd(), node.kind === K.TrueKeyword ? 'false' : 'true');
        } else if (ts.isExpressionStatement(node)) {
            const call = ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression;
            if (ts.isCallExpression(call) && call.expression.kind !== K.SuperKeyword && !UNOBSERVABLE_CALL.test(call.expression.getText(sf))) {
                add('remove-call', node.getStart(sf), node.getEnd(), ';');
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/** The text with one mutant applied. */
export function applyMutant(text, m) {
    return text.slice(0, m.start) + m.replacement + text.slice(m.end);
}

/** The test files next to a source file: `x.test.js` and `x.<anything>.test.js` (also .mjs). */
export function siblingTests(pkgDir, file) {
    const dir = path.dirname(file);
    const base = path.basename(file).replace(SOURCE, '');
    let names;
    try { names = fs.readdirSync(path.join(pkgDir, dir)); } catch { return []; }
    return names
        .filter((n) => n.startsWith(`${base}.`) && /\.test\.m?js$/.test(n))
        .map((n) => (dir === '.' ? n : `${dir}/${n}`))
        .sort();
}

/**
 * The tests that run for a source file: the ones next to it, then the ones the
 * map names for it (each once).
 * @param {string} pkgDir
 * @param {string} file
 * @param {Record<string, string[]>} [testMap]
 */
export function testsFor(pkgDir, file, testMap = {}) {
    return [...new Set([...siblingTests(pkgDir, file), ...(testMap[file] ?? [])])];
}

/**
 * Paths the ratchet file names that are not on disk: group entries, and the
 * sources and tests of the test map.
 * @param {string} pkgDir
 * @param {{ groups: Record<string, string[]>, tests?: Record<string, string[]> }} config
 * @returns {string[]}
 */
export function missingPaths(pkgDir, config) {
    const named = [
        ...Object.values(config.groups).flat(),
        ...Object.entries(config.tests ?? {}).flatMap(([source, tests]) => [source, ...tests]),
    ];
    return [...new Set(named)].filter((p) => !fs.existsSync(path.join(pkgDir, p))).sort();
}

/** The source files of a group entry (a folder, walked, or one file), package-relative. */
export function sourceFiles(pkgDir, entry) {
    const abs = path.join(pkgDir, entry);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isFile()) return [entry];
    const out = [];
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = `${entry}/${d.name}`;
        if (d.isDirectory()) { if (d.name !== 'node_modules') out.push(...sourceFiles(pkgDir, rel)); }
        else if (SOURCE.test(d.name) && !TEST.test(d.name) && !/\.d\.[cm]?ts$/.test(d.name)) out.push(rel);
    }
    return out.sort();
}

/**
 * Pick `quota` mutants round-robin over the files, at most `perFile` each.
 * @param {{ file: string, mutants: any[] }[]} files
 * @param {number} quota
 * @param {number} perFile
 * @param {() => number} random
 */
export function sample(files, quota, perFile, random) {
    const pools = shuffled(files, random).map((f) => ({ file: f.file, left: shuffled(f.mutants, random).slice(0, perFile) }));
    const out = [];
    while (out.length < quota && pools.some((p) => p.left.length > 0)) {
        for (const p of pools) {
            if (out.length >= quota) break;
            const m = p.left.shift();
            if (m) out.push({ file: p.file, ...m });
        }
    }
    return out;
}

/** A stable name for a mutant: where and what. */
export const idOf = (m) => `${m.file}:${m.start}:${m.op}`;

/** The floor a measured kill rate supports. */
export const floorFor = (rate) => Math.max(0, Math.floor(rate) - 5);

/**
 * Kill rate per group and overall, from finished mutants.
 * @param {{ group: string, verdict: string }[]} results
 */
export function rates(results) {
    const row = (list) => {
        const killed = list.filter((r) => r.verdict === 'killed' || r.verdict === 'timeout').length;
        return { mutants: list.length, killed, survived: list.length - killed, rate: list.length === 0 ? null : (killed / list.length) * 100 };
    };
    const groups = [...new Set(results.map((r) => r.group))].map((group) => ({ group, ...row(results.filter((r) => r.group === group)) }));
    return { groups, total: row(results) };
}

/** Megabytes from an environment variable; 0 switches the cap off. */
const mbFromEnv = (name, fallback) => {
    const n = Number(process.env[name] ?? fallback);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Resident memory of a process in MB (Linux /proc), or null where that cannot be read. */
function rssMb(pid) {
    try {
        const pages = Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]);
        return (pages * 4096) / (1024 * 1024);
    } catch { return null; }
}

/**
 * Run one test file; resolves with how it ended. The child leads its own
 * process group so a wedged grandchild goes down with it.
 *
 * A mutant can turn a loop into one that never ends or a buffer into one that
 * never stops growing, so the child is bounded three ways: the time-out, a
 * V8 heap cap (MUTATION_CHILD_HEAP_MB, default 2048) and a watch on its
 * resident memory (MUTATION_CHILD_MAX_RSS_MB, default 4096; buffers live
 * outside the heap). 0 switches a cap off. Hitting any of them is a kill.
 * The file runs inside the `node --test` process (as the package's own runner
 * does) so those bounds apply to the tests themselves, except for a file that
 * calls process.exit(), which would take the summary down with it.
 * @param {string} pkgDir
 * @param {string} test
 * @param {number} timeoutMs 0 = none
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, timedOut: boolean, ms: number }>}
 */
export function runTest(pkgDir, test, timeoutMs, { signal } = {}) {
    return new Promise((resolve) => {
        const preload = path.join(pkgDir, 'testUtils', 'registerFeatures.js');
        const heapMb = mbFromEnv('MUTATION_CHILD_HEAP_MB', 2048);
        const maxRssMb = mbFromEnv('MUTATION_CHILD_MAX_RSS_MB', 4096);
        const inProcess = !/\bprocess\.exit\(/.test(fs.readFileSync(path.join(pkgDir, test), 'utf8')); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a constant pattern over a test file this script reads itself
        const args = [
            ...(heapMb > 0 ? [`--max-old-space-size=${heapMb}`] : []),
            ...(fs.existsSync(preload) ? ['--require', preload] : []),
            '--test', ...(inProcess ? ['--experimental-test-isolation=none'] : []), test,
        ];
        const t0 = Date.now();
        // Not NODE_TEST_CONTEXT: when this script runs under `node --test` itself, a child that
        // inherits it reports to the parent runner and exits 0 on a failing test.
        /** @type {NodeJS.ProcessEnv} */
        const env = { NODE_ENV: 'test', ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, args, { cwd: pkgDir, env, stdio: 'ignore', detached: true });
        let timedOut = false;
        const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
        const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs) : null;
        const watch = maxRssMb > 0 ? setInterval(() => { if ((rssMb(child.pid) ?? 0) > maxRssMb) { timedOut = true; kill(); } }, 250) : null;
        signal?.addEventListener('abort', kill, { once: true });
        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            if (watch) clearInterval(watch);
            resolve({ ok: code === 0 && !timedOut, timedOut, ms: Date.now() - t0 });
        });
    });
}

/**
 * Run a file's tests, a few at a time; stops at the first one that fails.
 * @returns {Promise<{ ok: boolean, timedOut: boolean, ms: Record<string, number> }>}
 */
async function runTests(pkgDir, tests, timeoutFor) {
    const abort = new AbortController();
    const queue = [...tests];
    const ms = {};
    let ok = true;
    let timedOut = false;
    const worker = async () => {
        for (let t = queue.shift(); t && ok; t = queue.shift()) {
            const r = await runTest(pkgDir, t, timeoutFor(t), { signal: abort.signal });
            ms[t] = r.ms;
            if (!r.ok && ok) { ok = false; timedOut = r.timedOut; abort.abort(); }
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, tests.length) }, worker));
    return { ok, timedOut, ms };
}

/** Originals of the files being mutated: put back whatever happens. */
const originals = new Map();
function restoreAll() {
    for (const [abs, bytes] of originals) fs.writeFileSync(abs, bytes);
}

/**
 * Where the original of the file being mutated is kept while a mutant is in
 * the tree. A `finally` cannot run when the process is killed outright (the
 * memory guard, a power cut); the journal lets the next start put the file back.
 */
export function journalDir(pkgDir) {
    return path.join(os.tmpdir(), `mutation-sample-${crypto.createHash('sha256').update(pkgDir).digest('hex').slice(0, 16)}`);
}

/** Record that `abs` is about to be mutated, with its original bytes. */
function journalWrite(pkgDir, abs, bytes) {
    const dir = journalDir(pkgDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'original'), bytes);
    // The pointer last: it only exists once the bytes it points at are on disk.
    fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify({ file: abs }));
}

function journalClear(pkgDir) {
    fs.rmSync(journalDir(pkgDir), { recursive: true, force: true });
}

/**
 * Put back a file an earlier, killed run left mutated.
 * @param {string} pkgDir
 * @returns {string | null} the restored file, or null when there was nothing to do
 */
export function recover(pkgDir) {
    const dir = journalDir(pkgDir);
    const pointer = path.join(dir, 'journal.json');
    if (!fs.existsSync(pointer)) return null;
    const { file } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    fs.writeFileSync(file, fs.readFileSync(path.join(dir, 'original')));
    journalClear(pkgDir);
    return file;
}

/**
 * Run mutants, one at a time, each against the tests next to its file and the ones the map names for it.
 * @param {string} pkgDir
 * @param {{ group: string, file: string, op: string, start: number, end: number, replacement: string, line: number, original: string }[]} mutants
 * @param {{ minTimeoutMs?: number, onResult?: (r: any) => void, testMap?: Record<string, string[]> }} [opts]
 */
export async function runMutants(pkgDir, mutants, { minTimeoutMs = 20000, onResult = () => {}, testMap = {} } = {}) {
    const results = [];
    const byFile = new Map();
    for (const m of mutants) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
    for (const [file, list] of byFile) {
        const abs = path.join(pkgDir, file);
        const bytes = fs.readFileSync(abs);
        const text = bytes.toString('utf8');
        const tests = testsFor(pkgDir, file, testMap);
        // The unchanged file first: its tests must pass, and their time sets the mutants' time-out.
        const base = await runTests(pkgDir, tests, () => 0);
        if (!base.ok) {
            for (const m of list) { const r = { ...m, verdict: 'baseline-red' }; results.push(r); onResult(r); }
            continue;
        }
        const timeoutFor = (t) => (minTimeoutMs > 0 ? Math.max(minTimeoutMs, (base.ms[t] ?? 0) * 4) : 0);
        originals.set(abs, bytes);
        journalWrite(pkgDir, abs, bytes);
        try {
            for (const m of list) {
                if (text.slice(m.start, m.end) !== m.original) { const r = { ...m, verdict: 'stale' }; results.push(r); onResult(r); continue; }
                fs.writeFileSync(abs, applyMutant(text, m));
                let run;
                try { run = await runTests(pkgDir, tests, timeoutFor); } finally { fs.writeFileSync(abs, bytes); }
                const r = { ...m, verdict: run.ok ? 'survived' : run.timedOut ? 'timeout' : 'killed' };
                results.push(r);
                onResult(r);
            }
        } finally {
            fs.writeFileSync(abs, bytes);
            if (!fs.readFileSync(abs).equals(bytes)) throw new Error(`mutation-sample: ${file} was not restored`);
            originals.delete(abs);
            journalClear(pkgDir);
        }
    }
    return results;
}

/**
 * The sample a config describes: per group an equal share of `count`.
 * @param {any} ts
 * @param {string} pkgDir
 * @param {{ groups: Record<string, string[]>, count?: number, seed?: number, perFile?: number }} config
 * @param {{ only?: string | null }} [opts]
 */
export function buildSample(ts, pkgDir, config, { only = null } = {}) {
    const random = rng(config.seed ?? DEFAULTS.seed);
    const names = Object.keys(config.groups).filter((g) => !only || g === only);
    const quota = Math.ceil((config.count ?? DEFAULTS.count) / Math.max(1, names.length));
    const out = [];
    const skipped = [];
    for (const group of names) {
        const files = [];
        for (const file of [...new Set(config.groups[group].flatMap((e) => sourceFiles(pkgDir, e)))]) {
            if (siblingTests(pkgDir, file).length === 0) { skipped.push({ group, file }); continue; }
            const mutants = mutantsOf(ts, fs.readFileSync(path.join(pkgDir, file), 'utf8'), file);
            if (mutants.length > 0) files.push({ file, mutants });
        }
        for (const m of sample(files, quota, config.perFile ?? DEFAULTS.perFile, random)) out.push({ group, ...m });
    }
    return { mutants: out, skipped };
}

const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };

async function main(args) {
    const valued = ['--json', '--replay', '--count', '--seed', '--per-file', '--only'];
    const pkg = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
    if (!pkg) {
        console.error('usage: node scripts/mutation-sample.mjs <package> [--gate | --update | --list | --restore] [--json <file>] [--replay <file>] [--count n] [--seed n] [--per-file n] [--only <group>]');
        process.exit(2);
    }
    const pkgDir = path.join(ROOT, pkg);
    const ratchetFile = path.join(pkgDir, '.mutation-ratchet.json');
    if (!fs.existsSync(ratchetFile)) {
        console.error(`mutation-sample: ${path.relative(ROOT, ratchetFile)} not found — it names the groups to sample ({ "groups": { "auth": ["auth"] } }).`);
        process.exit(2);
    }
    const recovered = recover(pkgDir);
    if (recovered) console.log(`mutation-sample: an earlier run was killed with a mutant in ${path.relative(ROOT, recovered)}; the original is back.`);
    if (args.includes('--restore')) return;
    const ratchet = JSON.parse(fs.readFileSync(ratchetFile, 'utf8'));
    const config = {
        groups: ratchet.groups,
        tests: ratchet.tests ?? {},
        count: Number(flag(args, '--count') ?? ratchet.count ?? DEFAULTS.count),
        seed: Number(flag(args, '--seed') ?? ratchet.seed ?? DEFAULTS.seed),
        perFile: Number(flag(args, '--per-file') ?? ratchet.perFile ?? DEFAULTS.perFile),
    };
    const missing = missingPaths(pkgDir, config);
    if (missing.length > 0) {
        console.error(`mutation-sample: ${path.relative(ROOT, ratchetFile)} names ${missing.length} path(s) that are not there (moved or renamed?): ${missing.join(', ')}`);
        process.exit(2);
    }
    const replay = flag(args, '--replay');
    let mutants;
    if (replay) {
        mutants = JSON.parse(fs.readFileSync(path.resolve(replay), 'utf8')).results.filter((r) => r.verdict === 'survived').map(({ verdict: _v, ...m }) => m);
    } else {
        const built = buildSample(loadTs(), pkgDir, config, { only: flag(args, '--only') });
        mutants = built.mutants;
        console.log(`${mutants.length} mutants over ${new Set(mutants.map((m) => m.file)).size} files (${built.skipped.length} files in the groups have no test next to them and are not sampled)`);
    }
    if (args.includes('--list')) {
        for (const m of mutants) console.log(`${m.group}  ${m.file}:${m.line}  ${m.op}  ${JSON.stringify(m.original.slice(0, 60))} -> ${JSON.stringify(m.replacement.slice(0, 60))}`);
        return;
    }

    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restoreAll(); process.exit(130); });
    process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(1); });

    const jsonOut = flag(args, '--json');
    // Written after every mutant: a run that is stopped halfway keeps what it found.
    const partial = [];
    const writeJson = (list) => { if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify({ config, results: list }, null, 1)}\n`); };
    const results = await runMutants(pkgDir, mutants, {
        minTimeoutMs: Number(process.env.MUTATION_MIN_TIMEOUT_MS ?? 20000),
        testMap: config.tests,
        onResult: (r) => { partial.push(r); writeJson(partial); console.log(`[${partial.length}/${mutants.length}] ${r.verdict.padEnd(12)} ${r.file}:${r.line}  ${r.op}`); },
    });
    writeJson(results);

    const counted = results.filter((r) => ['killed', 'timeout', 'survived'].includes(r.verdict));
    const { groups, total } = rates(counted);
    console.log('');
    const survivors = counted.filter((r) => r.verdict === 'survived');
    if (survivors.length > 0) {
        console.log('Survivors (no test next to the file noticed the change):');
        for (const m of survivors) console.log(`  ${m.file}:${m.line}  ${m.op}  ${JSON.stringify(m.original.slice(0, 80))} -> ${JSON.stringify(m.replacement.slice(0, 80))}`);
        console.log('');
    }
    const uncounted = results.length - counted.length;
    if (uncounted > 0) console.log(`${uncounted} mutant(s) not counted: ${[...new Set(results.filter((r) => !counted.includes(r)).map((r) => `${r.file} (${r.verdict})`))].join(', ')}\n`);
    for (const g of groups) console.log(`${g.group.padEnd(12)} ${String(g.killed).padStart(4)} of ${String(g.mutants).padStart(4)} killed  ${(g.rate ?? 0).toFixed(1).padStart(5)}%`);
    console.log(`${'total'.padEnd(12)} ${String(total.killed).padStart(4)} of ${String(total.mutants).padStart(4)} killed  ${(total.rate ?? 0).toFixed(1).padStart(5)}%`);
    if (total.rate === null || replay) return;

    const update = args.includes('--update');
    if (update) {
        const next = { ...ratchet, _generated: new Date().toISOString().slice(0, 10), floor: Math.max(ratchet.floor ?? 0, floorFor(total.rate)) };
        fs.writeFileSync(ratchetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Floor written to ${path.relative(ROOT, ratchetFile)}: ${next.floor}% (measured ${total.rate.toFixed(1)}%)`);
    } else if (args.includes('--gate') && typeof ratchet.floor === 'number') {
        if (total.rate < ratchet.floor) {
            console.error(`❌ ${pkg}: mutation kill rate ${total.rate.toFixed(1)}% is under the floor of ${ratchet.floor}% — add the test case each survivor above is missing, rather than lowering the floor`);
            process.exit(1);
        }
        console.log(`✅ ${pkg}: mutation kill rate ${total.rate.toFixed(1)}%, floor ${ratchet.floor}%`);
    }
}

if (isEntryPoint(import.meta.url)) await main(process.argv.slice(2));
