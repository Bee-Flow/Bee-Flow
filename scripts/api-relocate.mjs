#!/usr/bin/env node
// api-relocate: move the de-facto API modules that sit outside agent-hub/src/api/
// into it. A module qualifies when it only talks to the server (module-level
// functions around authFetch: no JSX, no hook calls, no component). The move is
// done by the TypeScript language service (`getEditsForFileRename`), so every
// importer, re-export and dynamic import is rewritten the way the editor would;
// the path strings in `vi.mock(...)` / `vi.importActual(...)`, which the service
// cannot see, are rewritten here. Colocated tests move with their module.
//
//   node scripts/api-relocate.mjs --auto [--dry] [--json] [--package agent-hub]
//   node scripts/api-relocate.mjs src/utils/fooApi.ts [more files] [--dry]
//
// Layer rule (the import-zones ratchet): api/ never imports from components/ or
// pages/. A module that does, directly or through another candidate that cannot
// move, is refused and reported; it needs its types moved down first.
// Nothing is written with --dry. Exit code 0 even when files are refused.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, loadTs } from './lib/ts-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//;
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mts)$/;
// A directory name that says nothing about the feature when a file name collides.
const GENERIC_DIRS = new Set(['api', 'data', 'lib', 'hooks', 'utils', 'src', 'components', 'pages', 'state', 'http', 'collab', 'runtime', 'panel', 'local']);
const MOCK_CALL = /\b(?:vi|jest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock|requireActual|requireMock)\s*\(\s*(['"])([^'"\n]+)\1/g;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
const FORBIDDEN_FROM_API = new Set(['components', 'pages']);

const posix = (p) => p.split(path.sep).join('/');
const stripExt = (p) => p.replace(/\.(?:tsx?|jsx?|mts)$/, '');
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camel = (s) => s.replace(/[-_.]+([a-z0-9])/gi, (_, c) => c.toUpperCase());

/** Resolve an import specifier of `fromFile` to an existing source file (absolute), or null. */
export function resolveSpec(spec, fromFile, srcDir) {
    let base;
    if (spec.startsWith('@/')) base = path.join(srcDir, spec.slice(2));
    else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromFile), spec);
    else return null;
    const tries = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts'].map((e) => base + e), ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map((i) => path.join(base, i))];
    return tries.find((f) => CODE_FILE.test(f) && fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
}

/** Is this module a pure API client? (AST: an authFetch call in a plain function, no JSX, no hook call.) */
export function isApiShaped(ts, file, text) {
    if (!/\.ts$/.test(file) || TEST_FILE.test(file)) return false;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let fetches = 0;
    let bad = false;
    const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
    const visit = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
            if (/^use[A-Z]/.test(n.expression.text)) bad = true;
            if (n.expression.text === 'authFetch') {
                let p = n.parent;
                let outer = null;
                while (p) { if (isFn(p)) outer = p; p = p.parent; }
                if (!outer) bad = true; // a module-top call is not an api function
                else {
                    const nm = outer.name?.text ?? (ts.isVariableDeclaration(outer.parent) && ts.isIdentifier(outer.parent.name) ? outer.parent.name.text : '');
                    if (/^(?:[A-Z]|use[A-Z])/.test(nm)) bad = true; // a component or a hook
                    else fetches++;
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return fetches > 0 && !bad;
}

/** Siblings that move with a module: `x.test.ts`, `x.what.test.tsx`. */
function colocatedTests(file) {
    const dir = path.dirname(file);
    const stem = path.basename(stripExt(file));
    return fs.readdirSync(dir).filter((f) => TEST_FILE.test(f) && (f.startsWith(stem + '.test.') || (f.startsWith(stem + '.') && /\.test\.[jt]sx?$/.test(f)))).map((f) => path.join(dir, f));
}

/** Is every top-level statement an import or a type declaration? */
function isTypeOnly(ts, file, text) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    return sf.statements.every((st) => ts.isImportDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)
        || (ts.isExportDeclaration(st) && st.isTypeOnly) || ts.isEmptyStatement(st));
}

/** Can a file that api/ code depends on move down with it? A type file, or a small pure .ts helper. */
function pullable(ts, file, text) {
    if (!/\.ts$/.test(file) || TEST_FILE.test(file)) return false;
    if (isTypeOnly(ts, file, text)) return true;
    const lines = text.split('\n').length;
    return lines <= 120 && !/from\s+['"]react['"]/.test(text) && !/\buse[A-Z]\w*\s*\(/.test(text);
}

/**
 * Plan the moves: { moves: [{from, to}], refused: [{file, reason}] }.
 * `pkgDir` holds src/; `candidates` are absolute source files. A file in components/ or pages/ that a
 * candidate needs is pulled along when it is a type file or a small pure helper (`pull`, default on);
 * otherwise the candidate is refused.
 */
export function plan(ts, pkgDir, candidates, { destDir = 'api', pull = true } = {}) {
    const srcDir = path.join(pkgDir, 'src');
    const apiDir = path.join(srcDir, destDir);
    const refused = [];
    const set = new Map(); // from -> to
    const taken = new Set();
    const used = (p) => taken.has(p) || fs.existsSync(p);
    const assign = (from) => {
        const rel = posix(path.relative(srcDir, from));
        const ext = path.extname(from);
        const base = path.basename(from, ext);
        let to = path.join(apiDir, base + ext);
        if (used(to) || GENERIC_DIRS.has(lowerFirst(base)) || base === 'index') {
            const parts = path.dirname(rel).split('/').filter((d) => !GENERIC_DIRS.has(d));
            const dir = parts[parts.length - 1];
            if (dir) to = path.join(apiDir, lowerFirst(camel(dir)) + upperFirst(base) + ext);
        }
        if (used(to)) return null;
        taken.add(to);
        set.set(from, to);
        return to;
    };
    const rootSet = new Set();
    for (const from of candidates) {
        const rel = posix(path.relative(srcDir, from));
        if (rel.startsWith(destDir + '/')) { refused.push({ file: rel, reason: 'already in api/' }); continue; }
        if (!assign(from)) { refused.push({ file: rel, reason: 'no free destination name in api/' }); continue; }
        rootSet.add(from);
    }
    const forbiddenImports = (from) => {
        const out = [];
        for (const [, , spec] of fs.readFileSync(from, 'utf8').matchAll(IMPORT_SPEC)) {
            const target = resolveSpec(spec, from, srcDir);
            if (!target || set.has(target)) continue;
            if (FORBIDDEN_FROM_API.has(posix(path.relative(srcDir, target)).split('/')[0])) out.push(target);
        }
        return out;
    };
    // Pull the dependencies that may move down, transitively.
    const unpullable = new Set();
    if (pull) {
        for (let changed = true; changed;) {
            changed = false;
            for (const from of [...set.keys()]) {
                for (const dep of forbiddenImports(from)) {
                    if (unpullable.has(dep)) continue;
                    if (pullable(ts, dep, fs.readFileSync(dep, 'utf8')) && assign(dep)) changed = true;
                    else unpullable.add(dep);
                }
            }
        }
    }
    // A module leaves the set when it still imports components/pages, and so does a pulled file
    // nobody left needs.
    for (let changed = true; changed;) {
        changed = false;
        for (const from of [...set.keys()]) {
            const bad = forbiddenImports(from);
            if (bad.length) {
                const rel = posix(path.relative(srcDir, from));
                if (rootSet.has(from)) refused.push({ file: rel, reason: `imports ${posix(path.relative(srcDir, bad[0]))} (api/ may not import ${posix(path.relative(srcDir, bad[0])).split('/')[0]}/) and it cannot move down with it` });
                set.delete(from);
                changed = true;
            }
        }
        const needed = new Set(rootSet);
        for (let grow = true; grow;) {
            grow = false;
            for (const from of [...needed]) {
                if (!set.has(from)) continue;
                for (const [, , spec] of fs.readFileSync(from, 'utf8').matchAll(IMPORT_SPEC)) {
                    const t = resolveSpec(spec, from, srcDir);
                    if (t && set.has(t) && !needed.has(t)) { needed.add(t); grow = true; }
                }
            }
        }
        for (const from of [...set.keys()]) if (!needed.has(from) || (!rootSet.has(from) && !set.has(from))) { set.delete(from); changed = true; }
        // a root that left takes the roots that need it along (their import is no longer satisfiable)
        for (const from of rootSet) {
            if (!set.has(from)) continue;
            for (const [, , spec] of fs.readFileSync(from, 'utf8').matchAll(IMPORT_SPEC)) {
                const t = resolveSpec(spec, from, srcDir);
                if (t && rootSet.has(t) && !set.has(t)) {
                    refused.push({ file: posix(path.relative(srcDir, from)), reason: `needs ${posix(path.relative(srcDir, t))}, which cannot move` });
                    set.delete(from);
                    changed = true;
                    break;
                }
            }
        }
    }
    const moves = [];
    for (const [from, to] of set) {
        moves.push({ from, to });
        for (const t of colocatedTests(from)) {
            const tn = path.basename(t).replace(path.basename(from, path.extname(from)), path.basename(to, path.extname(to)));
            moves.push({ from: t, to: path.join(apiDir, tn), test: true });
        }
    }
    return { moves, refused };
}

/** The specifier text for `target` as seen from `fromFile`, in the style of the old specifier. */
function specFor(oldSpec, target, fromFile, srcDir) {
    const noExt = stripExt(target);
    if (oldSpec.startsWith('@/')) return '@/' + posix(path.relative(srcDir, noExt));
    let rel = posix(path.relative(path.dirname(fromFile), noExt));
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
}

/**
 * Execute the moves with the language service. Returns { changedFiles, mockEdits }.
 * With `write: false` nothing touches the disk.
 */
export function relocate(pkgDir, moves, { write = true } = {}) {
    const ts = loadTs();
    const srcDir = path.join(pkgDir, 'src');
    const moveMap = new Map(moves.map((m) => [m.from, m.to]));
    // Which files mention a moved module (by import or by a mock path)? A language service over the
    // whole package needs about a minute per rename, so it gets only these files and the moved ones.
    const all = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (CODE_FILE.test(e.name)) all.push(p);
        }
    };
    walk(srcDir);
    const touching = new Set(moveMap.keys());
    const mockEdits = [];
    const mockText = new Map();
    for (const f of all) {
        const text = fs.readFileSync(f, 'utf8');
        let hit = false;
        for (const [, , spec] of text.matchAll(IMPORT_SPEC)) {
            const t = resolveSpec(spec, f, srcDir);
            if (t && moveMap.has(t)) { hit = true; break; }
        }
        // a moved file's own relative imports change too
        if (hit || moveMap.has(f)) touching.add(f);
        // Mock strings, which the service cannot see, against the original layout.
        if (!/\b(?:vi|jest)\.\w+\s*\(/.test(text)) continue;
        const newSelf = moveMap.get(f) ?? f;
        let out = text;
        for (const m of [...text.matchAll(MOCK_CALL)].reverse()) {
            const spec = m[2];
            const target = resolveSpec(spec, f, srcDir);
            if (!target) continue;
            const newTarget = moveMap.get(target) ?? target;
            if (newTarget === target && newSelf === f) continue;
            const next = specFor(spec, newTarget, newSelf, srcDir);
            if (next === spec) continue;
            const at = m.index + m[0].lastIndexOf(spec);
            out = out.slice(0, at) + next + out.slice(at + spec.length);
            mockEdits.push({ file: posix(path.relative(srcDir, f)), from: spec, to: next });
        }
        if (out !== text) { mockText.set(f, out); touching.add(f); }
    }
    const svc = createService(pkgDir, ts, { only: [...touching], noResolve: true });
    for (const [f, text] of mockText) svc.set(f, text);
    const fmt = ts.getDefaultFormatCodeSettings();
    const prefs = { allowTextChangesInNewFiles: true };
    for (const { from, to } of moves) {
        svc.applyChanges(svc.ls.getEditsForFileRename(from, to, fmt, prefs));
        const text = svc.read(from);
        svc.remove(from);
        svc.set(to, text);
    }
    const { written } = svc.pending();
    const changedFiles = [...written.keys()].map((f) => posix(path.relative(pkgDir, f))).sort();
    if (write) {
        svc.flush();
        rekeyBudgets(pkgDir, moveMap);
    }
    return { changedFiles, mockEdits };
}

/** Files that key a budget or a timing by source path follow the move. */
export function rekeyBudgets(pkgDir, moveMap) {
    const rename = new Map([...moveMap].map(([a, b]) => ['src/' + posix(path.relative(path.join(pkgDir, 'src'), a)), 'src/' + posix(path.relative(path.join(pkgDir, 'src'), b))]));
    for (const name of ['.file-budget.json', '.test-durations.json']) {
        const file = path.join(pkgDir, name);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        const json = JSON.parse(raw);
        const holder = (name === '.file-budget.json' ? json.files : json.durations) ?? {};
        const entries = Object.entries(holder);
        if (!entries.some(([k]) => rename.has(k))) continue;
        const sorted = entries.every(([k], i) => i === 0 || entries[i - 1][0] <= k);
        const next = entries.map(([k, v]) => [rename.get(k) ?? k, v]);
        if (sorted) next.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
        for (const [k] of entries) delete holder[k];
        for (const [k, v] of next) holder[k] = v;
        const indent = /^\{\n( +)"/.exec(raw)?.[1].length ?? 2;
        fs.writeFileSync(file, JSON.stringify(json, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
    }
}

function listCandidates(ts, pkgDir) {
    const srcDir = path.join(pkgDir, 'src');
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'api') walk(p); } else if (/\.ts$/.test(e.name) && !TEST_FILE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
        }
    };
    walk(srcDir);
    return out.filter((f) => /\bauthFetch\b/.test(fs.readFileSync(f, 'utf8')) && isApiShaped(ts, f, fs.readFileSync(f, 'utf8')));
}

export function main(argv) {
    const flags = new Set(argv.filter((a) => a.startsWith('--')));
    const pkgIdx = argv.indexOf('--package');
    const pkg = pkgIdx >= 0 ? argv[pkgIdx + 1] : 'agent-hub';
    const pkgDir = path.isAbsolute(pkg) ? pkg : path.join(ROOT, pkg);
    const ts = loadTs();
    const rest = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--package');
    const candidates = flags.has('--auto') ? listCandidates(ts, pkgDir) : rest.map((f) => path.resolve(f.startsWith('src/') ? path.join(pkgDir, f) : f));
    const { moves, refused } = plan(ts, pkgDir, candidates);
    const result = relocate(pkgDir, moves, { write: !flags.has('--dry') });
    const summary = {
        moved: moves.map((m) => ({ from: posix(path.relative(pkgDir, m.from)), to: posix(path.relative(pkgDir, m.to)) })),
        refused,
        changedFiles: result.changedFiles.length,
        mockEdits: result.mockEdits.length,
    };
    if (flags.has('--json')) console.log(JSON.stringify(summary, null, 2));
    else {
        for (const m of summary.moved) console.log(`${flags.has('--dry') ? 'would move' : 'moved'} ${m.from} -> ${m.to}`);
        for (const r of refused) console.log(`refused ${r.file}: ${r.reason}`);
        console.log(`${summary.moved.length} files, ${summary.changedFiles} files touched, ${summary.mockEdits} mock paths`);
    }
    return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
