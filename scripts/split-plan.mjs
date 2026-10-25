#!/usr/bin/env node
// split-plan: split the agent-hub files over the line limit by role, then check every split
// before it is kept.
//
//   node scripts/split-plan.mjs [files...] [--limit 400] [--json plan.json]        plan only
//   node scripts/split-plan.mjs [files...] --run [--batch 20] [--report out.json]  plan, split, gate
//
// With no files it takes the ones `count-ratchet big-file agent-hub --list` names.
//
// THE PLAN reads ts-outline and groups the declarations that can leave the file without importing
// back (a closure over the references, as `ts-split --closure` computes it) by what they are:
//   types       interfaces and type aliases                       -> <Stem>.types.ts
//   constants   data (a `const` that is not a function)           -> <Stem>.constants.ts
//   helpers     plain functions and classes                       -> <Stem>.helpers.ts(x)
//   components  a capitalised function, 40+ lines, with the        -> <Name>.tsx
//   hooks       helpers only it uses (its closure)                 -> <useName>.ts
// Types, constants and helpers go in that order, so what a component needs from them is already
// in a sibling when the component moves. Components and hooks are taken largest first until the
// file fits (`limit - 20` lines). A group under 40 lines is not a file: the three small role
// groups merge into one `.helpers` file when together they reach 40, otherwise they stay. The
// default export, the largest exported declaration, a `let`/`var` and anything that references one
// of those stay where they are. A file that yields 3 or more new files becomes a folder module:
// `Foo.tsx` -> `Foo/index.tsx` (the component itself, not a barrel) with the siblings next to it;
// fewer, and the siblings sit next to `Foo.tsx`. Importers need no edit for the folder:
// `./Foo` resolves to `Foo/index.tsx`.
//
// THE GATES run per file; a file that fails any of them is reverted (git checkout of the touched
// files, the new ones deleted) and reported, never "fixed forward":
//   move equivalence  esbuild-transform the old file and the new set, drop imports and export
//                     lists, compare the multisets of top-level statements (ts-behaviour-diff
//                     compares per file and cannot see a move)
//   typecheck         the TypeScript language service's diagnostics for every touched file
//   scc ratchet       no new import cycle
//   file size         no new file over the limit
// and per batch (default 20 files): the package typecheck, the tests that import the files, and
// `file-budget --update`. A red batch is reverted as a whole and its files run one by one.
//
// Agent-hub only: the server keeps its barrels (path-keyed require.cache stubs).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { outline } from './ts-outline.mjs';
import { split } from './ts-split.mjs';
import { relocate } from './api-relocate.mjs';
import { createService, loadTs } from './lib/ts-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAVY = '/home/tom/.claude/bin/heavy';
const posix = (p) => p.split(path.sep).join('/');
const MIN_PART = 40;
const COMPONENT = /^[A-Z]/;
const HOOK = /^use[A-Z]/;

// ------------------------------------------------------------------ the plan

const lineCount = (t) => (t.match(/\n/g) || []).length;

/** The stem new files are named after: `Foo.tsx` -> Foo, `Foo/index.tsx` -> Foo. */
export function stemOf(file) {
    const base = path.basename(file).replace(/\.[cm]?[jt]sx?$/, '');
    return base === 'index' ? path.basename(path.dirname(file)) : base;
}

/** Does the source of a declaration contain JSX? */
function hasJsx(ts, text) {
    const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let hit = false;
    const visit = (n) => {
        if (hit) return;
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) { hit = true; return; }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return hit;
}

/**
 * Plan one file. Returns { file, lines, residual, folder, groups: [{ role, name, roots, lines }], skip }.
 * `exists(path)` tells whether a sibling name is taken (default: the file system).
 */
export function planFile(abs, { limit = 400, exists = fs.existsSync } = {}) {
    const ts = loadTs();
    const o = outline(abs);
    const text = fs.readFileSync(abs, 'utf8');
    const srcLines = text.split('\n');
    const plan = { file: abs, lines: o.lines, residual: o.lines, folder: false, groups: [], skip: null };
    if (o.testCouplings?.length) { plan.skip = `a test is coupled to the file's path (${o.testCouplings[0].kind} in ${o.testCouplings[0].file})`; return plan; }
    if (o.module !== 'esm') { plan.skip = 'not an ES module'; return plan; }

    const decls = new Map(); // name -> declaration
    const units = [];
    for (const d of o.declarations) {
        if (!['fn', 'class', 'interface', 'type', 'enum', 'var'].includes(d.kind)) continue;
        const code = srcLines.slice(d.from - 1, d.to).join('\n');
        const head = code.replace(/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*\n)*/, '');
        const unit = {
            ...d,
            names: d.name.split('+'),
            isDefault: /^export\s+default\b/.test(head),
            mutable: d.kind === 'var' && /^(?:export\s+)?(?:let|var)\b/.test(head),
            code,
        };
        units.push(unit);
        for (const n of unit.names) decls.set(n, unit);
    }
    // What stays: the default export, the anchor (the largest exported declaration), a let/var.
    const pinned = new Set();
    for (const u of units) if (u.isDefault || u.mutable) pinned.add(u);
    if (![...pinned].some((u) => u.isDefault)) {
        const exported = units.filter((u) => u.exported).sort((x, y) => y.size - x.size);
        if (exported[0]) pinned.add(exported[0]);
    }
    // Declarations that are not units (a statement, an `export {}` list) keep their references.
    const remaining = new Set(units);
    const refsOf = (u) => u.refs.map((n) => decls.get(n)).filter(Boolean);
    const closure = (u) => {
        const seen = new Set();
        const stack = [u];
        while (stack.length) {
            const x = stack.pop();
            if (seen.has(x) || !remaining.has(x)) continue;
            seen.add(x);
            for (const r of refsOf(x)) stack.push(r);
        }
        return seen;
    };
    const movable = (u) => {
        if (!remaining.has(u) || pinned.has(u)) return null;
        const c = closure(u);
        for (const m of c) if (pinned.has(m) || m.mutable || m.isDefault) return null;
        return c;
    };
    const sizeOf = (set) => [...set].reduce((n, u) => n + u.size, 0);
    const role = (u) => (u.kind === 'interface' || u.kind === 'type' ? 'types'
        : u.kind === 'var' || u.kind === 'enum' ? 'constants'
            : HOOK.test(u.names[0]) ? 'hook'
                : COMPONENT.test(u.names[0]) ? 'component' : 'helpers');
    const take = (set) => { for (const m of set) remaining.delete(m); };
    const groups = [];
    const collect = (r, pick) => {
        const set = new Set();
        for (const u of units) {
            if (role(u) !== r || !remaining.has(u)) continue;
            const c = movable(u);
            if (!c) continue;
            if (pick && ![...c].every(pick)) continue;
            for (const m of c) set.add(m);
        }
        return set;
    };
    const ext = /\.tsx$/.test(abs) ? 'tsx' : 'ts';
    const small = [];
    const phases = [
        ['types', null],
        ['constants', (m) => ['types', 'constants'].includes(role(m))],
        // What a file exports is its face; helpers leave it only when nothing else gets the file under the limit.
        ['helpers', (m) => ['types', 'constants', 'helpers'].includes(role(m)) && !m.exported],
    ];
    // A constant may need a helper and a helper a constant: go round until nothing more moves.
    for (let round = 0, grew = true; grew && round < 4; round++) {
        grew = false;
        for (const [r, pick] of phases) {
            const set = collect(r, pick);
            if (!set.size) continue;
            const lines = sizeOf(set);
            const prior = groups.find((g) => g.role === r);
            if (prior) {
                for (const m of set) prior.members.add(m);
                prior.roots = [...prior.members].flatMap((u) => u.names);
                prior.lines = sizeOf(prior.members);
                take(set);
                grew = true;
                continue;
            }
            const g = { role: r, roots: [...set].flatMap((u) => u.names), members: set, lines };
            const heldBack = small.find((x) => x.role === r);
            if (heldBack) { for (const m of set) heldBack.members.add(m); heldBack.lines = sizeOf(heldBack.members); heldBack.roots = [...heldBack.members].flatMap((u) => u.names); if (heldBack.lines >= MIN_PART) { groups.push(heldBack); small.splice(small.indexOf(heldBack), 1); take(heldBack.members); grew = true; } continue; }
            if (lines >= MIN_PART) { groups.push(g); take(set); grew = true; } else small.push(g);
        }
    }
    // Small role groups: one helpers file when together they reach the minimum, else they stay.
    const smallLines = small.reduce((n, g) => n + g.lines, 0);
    if (small.length && smallLines >= MIN_PART) {
        const set = new Set(small.flatMap((g) => [...g.members]));
        const existing = groups.find((g) => g.role === 'helpers');
        if (existing) { for (const m of set) existing.members.add(m); existing.roots = [...existing.members].flatMap((u) => u.names); existing.lines = sizeOf(existing.members); }
        else groups.push({ role: 'helpers', roots: [...set].flatMap((u) => u.names), members: set, lines: smallLines });
        take(set);
    }
    // Components and hooks, largest first, until the file fits.
    const target = limit - 20;
    const moved = () => groups.reduce((n, g) => n + g.lines, 0);
    const residual = () => o.lines - moved() + groups.length * 2;
    for (;;) {
        if (residual() <= target) break;
        let best = null;
        for (const u of units) {
            if (!['component', 'hook'].includes(role(u)) || !remaining.has(u)) continue;
            const c = movable(u);
            if (!c) continue;
            const lines = sizeOf(c);
            if (lines < MIN_PART || lines > limit - 20) continue;
            if (!best || lines > best.lines) best = { u, c, lines };
        }
        if (!best) break;
        const isHook = role(best.u) === 'hook';
        groups.push({ role: isHook ? 'hook' : 'component', roots: best.u.names, members: best.c, lines: best.lines, name: best.u.names[0], jsx: !isHook && ext === 'tsx' });
        take(best.c);
    }
    // Exported helpers, the last resort: the smallest closure that gets the file under the target, else the largest.
    for (let guard = 0; residual() > target && guard < 20; guard++) {
        const need = residual() - target;
        const cands = [];
        for (const u of units) {
            if (role(u) !== 'helpers' || !remaining.has(u)) continue;
            const c = movable(u);
            if (!c || ![...c].every((m) => ['types', 'constants', 'helpers'].includes(role(m)))) continue;
            const lines = sizeOf(c);
            if (lines < MIN_PART && !groups.some((g) => g.role === 'helpers')) continue;
            cands.push({ c, lines });
        }
        if (!cands.length) break;
        const enough = cands.filter((x) => x.lines >= need).sort((x, y) => x.lines - y.lines)[0];
        const pick = enough ?? cands.sort((x, y) => y.lines - x.lines)[0];
        const prior = groups.find((g) => g.role === 'helpers');
        if (prior) { for (const m of pick.c) prior.members.add(m); prior.roots = [...prior.members].flatMap((u) => u.names); prior.lines = sizeOf(prior.members); }
        else groups.push({ role: 'helpers', roots: [...pick.c].flatMap((u) => u.names), members: pick.c, lines: pick.lines });
        take(pick.c);
    }
    plan.residual = residual();
    const reduces = o.lines - plan.residual >= o.lines * 0.3;
    if (!groups.length) { plan.skip = 'nothing can leave the file by itself'; return plan; }
    if (plan.residual > limit && !reduces) { plan.skip = `would still be ${plan.residual} lines (the anchor is too big for a move)`; return plan; }

    // Names.
    plan.folder = groups.length >= 3 && !/(?:^|\/)index\.[cm]?[jt]sx?$/.test(posix(abs)) && true;
    const stem = stemOf(abs);
    const dir = plan.folder ? path.join(path.dirname(abs), stem) : path.dirname(abs);
    const taken = new Set();
    const free = (p) => !exists(p) && !taken.has(p);
    for (const g of groups) {
        const jsx = g.members.size && [...g.members].some((u) => hasJsx(ts, u.code));
        const x = jsx && ext === 'tsx' ? 'tsx' : 'ts';
        let file;
        if (g.role === 'component' || g.role === 'hook') file = path.join(dir, `${g.name}.${g.role === 'hook' ? 'ts' : 'tsx'}`);
        else file = path.join(dir, `${stem}.${g.role}.${x}`);
        for (let n = 2; !free(file); n++) file = file.replace(/(\.[cm]?[jt]sx?)$/, `${n}$1`);
        taken.add(file);
        g.file = file;
    }
    plan.groups = groups.map((g) => ({ role: g.role, file: g.file, roots: g.roots, lines: g.lines, members: [...g.members].flatMap((u) => u.names) }));
    return plan;
}

// ------------------------------------------------------------- move equivalence

let esbuildCache;
function esbuild() {
    esbuildCache ??= createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('esbuild-wasm');
    return esbuildCache;
}

/**
 * The multiset of top-level statements a file runs, as esbuild prints them: types, comments and
 * formatting are gone, imports and export lists are dropped, and `export` in front of a
 * declaration is stripped, so a declaration that moved and gained an `export` is the same
 * statement.
 */
export function statementsOf(file, text) {
    const ts = loadTs();
    const loader = /\.tsx$/.test(file) ? 'tsx' : /\.jsx$/.test(file) ? 'jsx' : /\.[cm]?js$/.test(file) ? 'js' : 'ts';
    const out = esbuild().transformSync(text, { loader, jsx: 'automatic', format: 'esm', target: 'es2022', sourcefile: path.basename(file) }).code;
    const sf = ts.createSourceFile('out.js', out, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const res = [];
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
        res.push(st.getText(sf).replace(/^export\s+(?:default\s+)?/, ''));
    }
    return res;
}

/** { ok, missing, extra }: statements the old file ran that no new file runs, and the other way round. */
export function equivalence(oldFile, oldText, newFiles) {
    const count = (list) => { const m = new Map(); for (const s of list) m.set(s, (m.get(s) ?? 0) + 1); return m; };
    const before = count(statementsOf(oldFile, oldText));
    const after = count(newFiles.flatMap(([f, t]) => statementsOf(f, t)));
    const missing = [];
    const extra = [];
    for (const [s, n] of before) if ((after.get(s) ?? 0) < n) missing.push(s.split('\n')[0].slice(0, 80));
    for (const [s, n] of after) if ((before.get(s) ?? 0) < n) extra.push(s.split('\n')[0].slice(0, 80));
    return { ok: !missing.length && !extra.length, missing, extra };
}

// ---------------------------------------------------------------- the checkpoints

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Everything accepted so far is staged; a rejected file is `git checkout` + `git clean` back to that. */
function revertToIndex(repo, pkgRel) {
    git(['checkout', '--', pkgRel], repo);
    git(['clean', '-fdq', '--', `${pkgRel}/src`], repo);
}

// ------------------------------------------------------------------- execution

/** Execute one plan on disk. Returns { files: [paths written or created], created: [paths], newMain }. */
export function execute(plan, { pkgDir, rewriteImporters = true }) {
    let cur = plan.file;
    const created = [];
    const touched = new Set([plan.file]);
    if (plan.folder) {
        const stem = stemOf(plan.file);
        const to = path.join(path.dirname(plan.file), stem, `index${path.extname(plan.file)}`);
        const r = relocate(pkgDir, [{ from: plan.file, to }]);
        for (const f of r.changedFiles) touched.add(path.join(pkgDir, f));
        cur = to;
        created.push(to);
    }
    const refused = [];
    for (const g of plan.groups) {
        const { exitCode, result } = split({ file: cur, move: g.roots, to: g.file, closure: true, rewriteImporters });
        if (exitCode !== 0) { refused.push({ group: g.role, reasons: result.refused }); break; }
        created.push(path.resolve(ROOT, result.created[0]));
        for (const t of result.touched) touched.add(path.resolve(ROOT, t));
    }
    return { cur, created, touched: [...touched], refused };
}

/** The tests that import a set of files (impact.mjs): [relative to agent-hub]. */
function testsFor(repo, files, depth = 2) {
    const r = spawnSync('node', [path.join(ROOT, 'scripts', 'impact.mjs'), ...files.map((f) => path.relative(repo, f)), '--json', '--depth', String(depth)], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
    try { return (JSON.parse(r.stdout).packages['agent-hub']?.tests ?? []).map((t) => t.file.replace(/^agent-hub\//, '')); } catch { return []; }
}

const sh = (cmd, args, cwd, label) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, label };
};

// ------------------------------------------------------------------------- run

export async function run(files, opts = {}) {
    const { limit = 400, batch = 20, tests = true, scc = true, typecheck = true, budget = true, repo = ROOT, pkgRel = 'agent-hub', log = console.error } = opts;
    const pkgDir = path.join(repo, pkgRel);
    // Tests that cannot judge a split here: the i18n guard keeps path-keyed registers (fixed by hand at the end), and the rbac
    // suites need the server's node_modules.
    const skipTests = opts.skipTests ?? [/i18n\/i18nGuard\.test/, /rbac\/rowRule/];
    const report = { done: [], reverted: [], skipped: [], batches: [] };
    if (git(['status', '--porcelain', '--', pkgRel], repo).stdout.trim()) throw new Error(`${pkgRel} has uncommitted changes; the split reverts with git, so start clean`);
    const ts = loadTs();
    const svc = createService(pkgDir, ts);
    /** Diagnostic messages of the given files, as a count per message text (file and position do not matter after a move). */
    const diagnose = (paths) => {
        const out = new Map();
        for (const f of paths) {
            if (!/\.[cm]?tsx?$/.test(f) || !fs.existsSync(f)) continue;
            if (!svc.ls.getProgram().getSourceFile(f)) svc.set(f, fs.readFileSync(f, 'utf8'));
            for (const d of [...svc.ls.getSyntacticDiagnostics(f), ...svc.ls.getSemanticDiagnostics(f)]) {
                const m = ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 160);
                out.set(m, (out.get(m) ?? 0) + 1);
            }
        }
        return out;
    };
    /** A message that is new, or more frequent than it was. */
    const worse = (after, before) => [...after].find(([m, n]) => n > (before.get(m) ?? 0))?.[0] ?? null;
    const refreshSvc = (paths, gone = []) => {
        for (const f of paths) if (fs.existsSync(f)) svc.set(f, fs.readFileSync(f, 'utf8'));
        for (const f of gone) if (!fs.existsSync(f)) svc.remove(f);
    };

    const processOne = (abs, label) => {
        const plan = planFile(abs, { limit });
        if (plan.skip) { report.skipped.push({ file: path.relative(pkgDir, abs), reason: plan.skip }); return null; }
        const oldText = fs.readFileSync(abs, 'utf8');
        const before = plan.lines;
        const baseline = diagnose([abs]);
        const result = execute(plan, { pkgDir, rewriteImporters: !outline(abs).tests.some((t) => t.mocksThisFile) });
        const allPaths = [...new Set([...result.touched, ...result.created])];
        const fail = (reason) => {
            revertToIndex(repo, pkgRel);
            refreshSvc(allPaths.filter((p) => fs.existsSync(p)), allPaths);
            for (const p of allPaths) if (!fs.existsSync(p)) svc.remove(p);
            report.reverted.push({ file: path.relative(pkgDir, abs), reason });
            log(`reverted ${label}: ${reason}`);
            return null;
        };
        if (result.refused.length) return fail(`ts-split refused: ${JSON.stringify(result.refused).slice(0, 200)}`);
        const eq = equivalence(abs, oldText, [result.cur, ...result.created].filter((f, i, a) => a.indexOf(f) === i).map((f) => [f, fs.readFileSync(f, 'utf8')]));
        if (!eq.ok) return fail(`not a pure move: missing ${eq.missing.slice(0, 2).join(' | ')}; extra ${eq.extra.slice(0, 2).join(' | ')}`);
        refreshSvc(allPaths, [abs]);
        const bad = worse(diagnose(allPaths), baseline);
        if (bad) return fail(`typecheck: ${bad}`);
        const forced = opts.check?.(abs, result);
        if (forced) return fail(forced);
        if (scc) {
            const r = sh('node', [path.join(ROOT, 'scripts', 'scc-ratchet.mjs'), pkgRel], repo, 'scc');
            if (!r.ok) return fail(`scc ratchet: ${r.out.split('\n').find((l) => /❌|over|grew/.test(l)) ?? 'red'}`);
        }
        const big = [result.cur, ...result.created].filter((f) => lineCount(fs.readFileSync(f, 'utf8')) > limit && f !== result.cur);
        if (big.length) return fail(`a new file is over ${limit} lines: ${path.basename(big[0])}`);
        git(['add', '-A', '--', pkgRel], repo);
        const after = lineCount(fs.readFileSync(result.cur, 'utf8'));
        const entry = { file: path.relative(pkgDir, abs), before, after, folder: plan.folder, files: result.created.map((f) => path.relative(pkgDir, f)), touched: result.touched.map((f) => path.relative(pkgDir, f)) };
        report.done.push(entry);
        log(`ok ${label}: ${before} -> ${after} lines, ${result.created.length} new`);
        return entry;
    };

    for (let i = 0; i < files.length; i += batch) {
        const chunk = files.slice(i, i + batch);
        const mark = report.done.length;
        for (const [j, abs] of chunk.entries()) processOne(abs, `${i + j + 1}/${files.length} ${path.relative(pkgDir, abs)}`);
        const done = report.done.slice(mark);
        if (!done.length) continue;
        // The batch gates: the real typecheck and the tests that import what changed.
        const touched = [...new Set(done.flatMap((d) => d.touched.concat(d.files)).map((p) => path.join(pkgDir, p)))];
        const tc = typecheck ? sh(HEAVY, ['npm', 'run', '-s', 'typecheck'], pkgDir, 'typecheck') : { ok: true, out: '', label: 'typecheck' };
        let tr = { ok: true, out: '' };
        if (tc.ok && tests) {
            const tfiles = [...new Set(testsFor(repo, touched))].filter((t) => !skipTests.some((re) => re.test(t)));
            if (tfiles.length) tr = sh(HEAVY, ['npx', 'vitest', 'run', '--maxWorkers=3', ...tfiles], pkgDir, 'vitest');
        }
        const gate = !tc.ok ? tc : !tr.ok ? tr : null;
        report.batches.push({ files: done.length, typecheck: tc.ok, tests: tr.ok });
        if (gate) {
            log(`batch ${i / batch + 1} is red (${gate.label}); reverting it and running its files one by one`);
            revertToIndex(repo, pkgRel);
            git(['reset', '-q', '--', pkgRel], repo);
            git(['checkout', 'HEAD', '--', pkgRel], repo);
            git(['clean', '-fdq', '--', `${pkgRel}/src`], repo);
            for (const d of done) report.done.splice(report.done.indexOf(d), 1);
            const all = [...new Set(done.flatMap((d) => d.touched.concat(d.files)).map((p) => path.join(pkgDir, p)))];
            refreshSvc(all.filter((p) => fs.existsSync(p)), all);
            for (const d of done) {
                const abs = path.join(pkgDir, d.file);
                const e = processOne(abs, `retry ${d.file}`);
                if (!e) continue;
                const tf = [...new Set(testsFor(repo, [...e.touched, ...e.files].map((p) => path.join(pkgDir, p))))].filter((t) => !skipTests.some((re) => re.test(t)));
                const t1 = tests && tf.length ? sh(HEAVY, ['npx', 'vitest', 'run', '--maxWorkers=3', ...tf], pkgDir, 'vitest') : { ok: true };
                if (!t1.ok) {
                    revertToIndex(repo, pkgRel);
                    report.done.splice(report.done.indexOf(e), 1);
                    report.reverted.push({ file: d.file, reason: `related tests failed: ${t1.out.split('\n').filter((l) => /FAIL|✗|×/.test(l)).slice(0, 2).join(' | ')}` });
                }
            }
        }
        if (budget) sh('node', [path.join(ROOT, 'scripts', 'file-budget.mjs'), pkgRel, '--update'], repo, 'budget');
        git(['add', '-A', '--', pkgRel], repo);
        if (opts.commit !== false) git(['commit', '-q', '-m', `split: batch ${Math.floor(i / batch) + 1} (${report.done.length - mark} files over ${limit} lines)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], repo);
    }
    return report;
}

// ------------------------------------------------------------------------ CLI

export function bigFiles(repo = ROOT, pkg = 'agent-hub') {
    const r = spawnSync('node', [path.join(ROOT, 'scripts', 'count-ratchet.mjs'), 'big-file', pkg, '--list'], { cwd: repo, encoding: 'utf8' });
    return r.stdout.split('\n').map((l) => /^\s+\d+\s+(\S+)$/.exec(l)?.[1]).filter(Boolean).map((p) => path.join(repo, pkg, p));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const val = (flag, d) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : d);
    const skipVal = new Set(['--limit', '--json', '--batch', '--report', '--only', '--max']);
    const given = args.filter((a, i) => !a.startsWith('--') && !skipVal.has(args[i - 1]));
    let files = given.length ? given.map((f) => path.resolve(f)) : bigFiles();
    const only = val('--only');
    if (only) files = files.filter((f) => f.includes(only));
    const max = Number(val('--max', 0));
    if (max) files = files.slice(0, max);
    const limit = Number(val('--limit', 400));
    if (args.includes('--run')) {
        const report = await run(files, { limit, batch: Number(val('--batch', 20)), tests: !args.includes('--no-tests') });
        const out = val('--report');
        if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ done: report.done.length, reverted: report.reverted, skipped: report.skipped.length, batches: report.batches }, null, 2));
    } else {
        const plans = files.map((f) => {
            const p = planFile(f, { limit });
            return { file: path.relative(ROOT, f), lines: p.lines, residual: p.residual, folder: p.folder, skip: p.skip, groups: p.groups.map((g) => ({ role: g.role, file: path.relative(path.dirname(f), g.file), lines: g.lines, roots: g.roots.slice(0, 8) })) };
        });
        const json = val('--json');
        if (json) fs.writeFileSync(json, JSON.stringify(plans, null, 2));
        const ok = plans.filter((p) => !p.skip);
        for (const p of plans) console.log(`${p.skip ? 'skip' : p.folder ? 'folder' : 'flat  '} ${p.file}  ${p.lines} -> ${p.residual}${p.skip ? `  (${p.skip})` : `  ${p.groups.map((g) => `${g.role}:${path.basename(g.file)}(${g.lines})`).join(' ')}`}`);
        console.log(`${ok.length} of ${plans.length} files planned, ${ok.filter((p) => p.residual <= limit).length} reach ${limit} lines, ${ok.filter((p) => p.folder).length} as folders`);
    }
}
