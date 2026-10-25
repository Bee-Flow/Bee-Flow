#!/usr/bin/env node
// Remove type casts one by one and keep every removal the type check accepts.
//
//   node scripts/ts-cast-loop.mjs agent-hub [--files src/a.ts,src/b.tsx] [--pattern "as unknown as"]
//          [--report report.json] [--group 1] [--include-tests] [--dry] [--tsc <path/to/tsc>] [--lock-dir dir]
//   node scripts/ts-cast-loop.mjs --wait-lock <dir>     block until no loop holds <dir>'s lock
//
// <package> is a directory with a tsconfig.json (agent-hub). Patterns (comma
// separated, default "as unknown as,as any"):
//   "as unknown as"   `x as unknown as T`  ->  `x`
//   "as any"          `x as any`           ->  `x`
//   "<any>"           `<any>x`             ->  `x`
// `(x as any).y` becomes `x.y` when x is an identifier, member chain or call.
// Casts nested inside a removed cast's operand are found by running it again.
//
// How it runs: one baseline `tsc --noEmit` (tsc 7, agent-hub's `typecheck`), then
// per group of files (--group, default 1 file) all casts of the group are removed
// at once and tsc runs once. No new error (compared by file, code and message,
// not line) keeps them all. A new error bisects the group's casts: halves are
// tried again, down to a single cast, which is reverted and reported with its
// error. Few runs when most casts go, about log2(n) per stubborn cast.
//
// The files really change on disk while it runs (tsc needs them there) and every
// original is restored on exit, Ctrl-C included, for what is reverted (and for
// everything with --dry). Run it directly, NOT under heavy: every tsc run is wrapped in
// /home/tom/.claude/bin/heavy by the tool itself (a nested heavy would wait for a second slot) when
// that exists (TS_CAST_LOOP_NO_HEAVY=1 skips it).
//
// DO NOT EDIT ANY FILE OF THE PACKAGE WHILE IT RUNS (not only the ones it lists): every
// planned file is rewritten from its original text on each attempt and restored at the end,
// so an edit made in between is overwritten or reverted, and tsc sees a half-changed tree.
// Other sessions wait for it instead of guessing with `pgrep -f`: while it runs there is a
// lock file `ts-cast-loop.lock` ({ pid, startedAt, package, files }) in the report's
// directory (--report), else in --lock-dir, else in the OS temp directory. The lock is
// removed on exit and on Ctrl-C / SIGTERM; one whose pid is dead is stale and is replaced.
// A second loop with the same lock directory refuses to start (exit 3).
// `--wait-lock <dir>` exits 0 as soon as there is no live lock there (or after
// `--timeout <seconds>`, default 3600, with exit 1); `isLocked(dir)` does the same in code.
//
// Prints (and with --report writes) JSON: kept and reverted casts with file, line,
// the cast text and for a revert the first new error, plus the tsc run count.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTsc } from './ts-convert-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAVY = '/home/tom/.claude/bin/heavy';
const DEFAULT_PATTERNS = ['as unknown as', 'as any'];

const isTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\//.test(f);

function loadTs(pkg) {
    for (const base of [pkg, path.join(ROOT, 'agent-hub')]) {
        try { return createRequire(path.join(base, 'package.json'))('typescript'); } catch { /* next */ }
    }
    throw new Error('typescript not found (npm ci in agent-hub)');
}

export function findTsc(pkg) {
    for (const base of [pkg, path.join(ROOT, 'agent-hub')]) {
        for (const m of ['typescript-7', 'typescript']) {
            const p = path.join(base, 'node_modules', m, 'bin', 'tsc');
            if (fs.existsSync(p)) return p;
        }
    }
    throw new Error('no tsc found; pass --tsc');
}

const simple = (ts, e) => ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || e.kind === ts.SyntaxKind.ThisKeyword;

/** The removable casts of `text` for the given patterns: `{ start, end, replacement, pattern, line, text }`, outermost only. */
export function findCasts(ts, fileName, text, patterns = DEFAULT_PATTERNS) {
    const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
    const out = [];
    const want = new Set(patterns);
    const visit = (n) => {
        let hit = null;
        if (ts.isAsExpression(n)) {
            if (want.has('as unknown as') && n.expression.kind === ts.SyntaxKind.AsExpression && n.expression.type.kind === ts.SyntaxKind.UnknownKeyword) hit = { pattern: 'as unknown as', operand: n.expression.expression };
            else if (want.has('as any') && n.type.kind === ts.SyntaxKind.AnyKeyword) hit = { pattern: 'as any', operand: n.expression };
        } else if (ts.isTypeAssertionExpression(n) && want.has('<any>') && n.type.kind === ts.SyntaxKind.AnyKeyword) {
            hit = { pattern: '<any>', operand: n.expression };
        }
        if (hit) {
            let target = n;
            const operandText = hit.operand.getText(sf);
            // (x as any).y -> x.y when x needs no parentheses of its own
            if (n.parent && ts.isParenthesizedExpression(n.parent) && simple(ts, hit.operand)) target = n.parent;
            out.push({ start: target.getStart(sf), end: target.getEnd(), replacement: operandText, pattern: hit.pattern, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

/** Apply a subset of casts to the original text (descending offsets). */
export function applyCasts(text, casts) {
    let out = text;
    for (const c of [...casts].sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.replacement + out.slice(c.end);
    return out;
}

const errorKey = (e) => `${e.file}|${e.code}|${e.message}`;
function countErrors(errs) {
    const m = new Map();
    for (const e of errs) m.set(errorKey(e), (m.get(errorKey(e)) || 0) + 1);
    return m;
}
function newErrors(base, errs) {
    const seen = new Map();
    const out = [];
    for (const e of errs) {
        const k = errorKey(e);
        const n = (seen.get(k) || 0) + 1; seen.set(k, n);
        if (n > (base.get(k) || 0)) out.push(e);
    }
    return out;
}

/** Default tsc runner: `node tsc --noEmit -p <pkg> --pretty false`, through heavy when present. */
export function makeTscRunner(pkg, tscPath) {
    const tsc = tscPath || findTsc(pkg);
    return () => {
        const args = [process.execPath, tsc, '--noEmit', '--pretty', 'false', '-p', pkg];
        const useHeavy = fs.existsSync(HEAVY) && !process.env.TS_CAST_LOOP_NO_HEAVY;
        const cmd = useHeavy ? [HEAVY, ...args] : args;
        const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28, cwd: pkg });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        const errs = parseTsc(out).map((e) => ({ ...e, file: path.relative(pkg, path.resolve(pkg, e.file)).replace(/\\/g, '/') }));
        if (r.status !== 0 && !errs.length) throw new Error(`tsc failed without diagnostics:\n${out.slice(0, 500)}`);
        return errs;
    };
}

/**
 * The loop. `runTsc()` returns the current error list. Files are changed on disk
 * and restored by the returned `restore()` (also wired to exit signals by the CLI).
 */
export function castLoop(ts, pkg, files, { patterns = DEFAULT_PATTERNS, group = 1, runTsc, dry = false, log = (/** @type {string} */ _m) => {} } = /** @type {any} */ ({})) {
    const originals = new Map();
    const restore = () => { for (const [abs, text] of originals) fs.writeFileSync(abs, text); };
    const report = { package: pkg, patterns, runs: 0, kept: [], reverted: [], unchanged: [] };
    const tsc = () => { report.runs++; return runTsc(); };
    const baseErrors = tsc();
    const base = countErrors(baseErrors);
    report.baselineErrors = baseErrors.length;
    const plan = [];
    for (const f of files) {
        const abs = path.resolve(pkg, f);
        const text = fs.readFileSync(abs, 'utf8');
        const casts = findCasts(ts, abs, text, patterns).map((c) => ({ ...c, file: path.relative(pkg, abs).replace(/\\/g, '/'), abs }));
        if (casts.length) { plan.push({ abs, text, casts }); originals.set(abs, text); }
    }
    const write = (entries) => {
        // entries: casts to remove (all files); every planned file is rewritten from its original
        for (const p of plan) fs.writeFileSync(p.abs, applyCasts(p.text, entries.filter((c) => c.abs === p.abs)));
    };
    const keptSoFar = [];
    const attempt = (casts) => {
        write([...keptSoFar, ...casts]);
        const errs = tsc();
        return newErrors(base, errs);
    };
    const settle = (casts) => {
        if (!casts.length) return;
        const fresh = attempt(casts);
        if (!fresh.length) { keptSoFar.push(...casts); log(`kept ${casts.length}`); return; }
        if (casts.length === 1) {
            const c = casts[0];
            report.reverted.push({ file: c.file, line: c.line, pattern: c.pattern, cast: c.text, error: `${fresh[0].file}:${fresh[0].line} TS${String(fresh[0].code).replace(/^TS/, '')}: ${fresh[0].message}`.slice(0, 300) });
            log(`reverted ${c.file}:${c.line}`);
            return;
        }
        const mid = Math.ceil(casts.length / 2);
        settle(casts.slice(0, mid));
        settle(casts.slice(mid));
    };
    const onSignal = (sig) => { restore(); process.kill(process.pid, sig); };
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, onSignal);
    try {
        for (let i = 0; i < plan.length; i += group) {
            const casts = plan.slice(i, i + group).flatMap((p) => p.casts);
            log(`group ${i / group + 1}: ${casts.length} casts in ${plan.slice(i, i + group).map((p) => path.relative(pkg, p.abs)).join(', ')}`);
            settle(casts);
        }
        // Final state: kept removals only.
        write(keptSoFar);
        report.kept = keptSoFar.map((c) => ({ file: c.file, line: c.line, pattern: c.pattern, cast: c.text }));
        if (!dry) {
            // Verify once: the whole kept set must still be clean.
            const errs = tsc();
            report.finalNewErrors = newErrors(base, errs).length;
            if (report.finalNewErrors) report.warning = 'kept removals interact: the final tsc run has new errors; re-run with a smaller --group';
        }
    } catch (e) {
        restore(); // an unexpected failure leaves no half-edited file behind
        throw e;
    } finally {
        for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, onSignal);
        if (dry) restore();
    }
    return { report, restore };
}

export const LOCK_NAME = 'ts-cast-loop.lock';

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The live lock in `dir` ({ pid, startedAt, package, files }) or null (none, unreadable or stale). */
export function isLocked(dir) {
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(dir, LOCK_NAME), 'utf8')); } catch { return null; }
    return Number.isInteger(info.pid) && pidAlive(info.pid) ? info : null;
}

/** Take the lock in `dir`; throws when a live loop holds it. Returns release(). */
export function acquireLock(dir, info) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOCK_NAME);
    const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...info }, null, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
        try { fs.writeFileSync(file, body, { flag: 'wx' }); break; } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            const held = isLocked(dir);
            if (held) throw Object.assign(new Error(`ts-cast-loop already running (pid ${held.pid} since ${held.startedAt}); wait with --wait-lock ${dir}`), { held });
            fs.rmSync(file, { force: true }); // stale
            if (attempt) throw e;
        }
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* gone */ }
    };
}

/** Resolves true when no live lock is in `dir`, false after `timeoutMs`. */
export async function waitForLock(dir, { timeoutMs = 3600_000, pollMs = 1000 } = {}) {
    const end = Date.now() + timeoutMs;
    while (isLocked(dir)) {
        if (Date.now() >= end) return false;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return true;
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

function listFiles(pkg, patterns, includeTests) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') && (includeTests || !isTest(p))) out.push(p);
        }
    };
    walk(path.join(pkg, 'src'));
    const needles = patterns.map((p) => (p === 'as unknown as' ? 'unknown' : p === '<any>' ? '<any>' : 'as any'));
    return out.filter((f) => { const t = fs.readFileSync(f, 'utf8'); return needles.some((n) => t.includes(n)); }).map((f) => path.relative(pkg, f));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && arg('--wait-lock')) {
    const ok = await waitForLock(path.resolve(arg('--wait-lock')), { timeoutMs: Number(arg('--timeout', 3600)) * 1000 });
    process.exit(ok ? 0 : 1);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const pkgArg = process.argv[2];
    if (!pkgArg || pkgArg.startsWith('--')) {
        console.error('usage: ts-cast-loop.mjs <package dir> [--files a,b] [--pattern "as unknown as,as any"] [--report out.json] [--group n] [--include-tests] [--dry] [--tsc path] [--lock-dir dir] | --wait-lock <dir> [--timeout s]');
        process.exit(2);
    }
    const pkg = path.resolve(fs.existsSync(pkgArg) ? pkgArg : path.join(ROOT, pkgArg));
    const patterns = arg('--pattern') ? arg('--pattern').split(',').map((s) => s.trim()) : DEFAULT_PATTERNS;
    const files = arg('--files') ? arg('--files').split(',').map((s) => s.trim()).filter(Boolean).map((f) => (fs.existsSync(path.resolve(pkg, f)) ? f : path.relative(pkg, path.resolve(f)))) : listFiles(pkg, patterns, process.argv.includes('--include-tests'));
    const ts = loadTs(pkg);
    const lockDir = path.resolve(arg('--lock-dir', arg('--report') ? path.dirname(path.resolve(arg('--report'))) : path.join(os.tmpdir(), 'ts-cast-loop')));
    let release;
    try { release = acquireLock(lockDir, { package: pkg, files, report: arg('--report') ? path.resolve(arg('--report')) : null }); } catch (e) { console.error(e.message); process.exit(3); }
    process.on('exit', release);
    // Registered before castLoop's own handler, which restores the files and re-raises the signal.
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, release);
    const { report, restore } = castLoop(ts, pkg, files, { patterns, group: Number(arg('--group', 1)), runTsc: makeTscRunner(pkg, arg('--tsc')), dry: process.argv.includes('--dry'), log: (m) => console.error(m) });
    void restore;
    if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
}
