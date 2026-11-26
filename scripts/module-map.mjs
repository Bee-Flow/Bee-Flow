#!/usr/bin/env node
/**
 * The ownership map: which first-party module owns which file of the server (scripts/module-map.json).
 *
 * Every file has a TREE PATH, its path relative to its root: `server/` for the core, and
 * `modules/<id>/<moduleDir>/` for a module (see server/moduleRoots.cjs). A file keeps its tree
 * path when it moves, so the map is written over tree paths and stays valid across moves.
 *
 * Format rules (scripts/module-map.json):
 *   - `modules.<id>.<package>` is a list of globs over tree paths (`*` within a segment, `**`
 *     any number of segments, `?` one character, `{a,b}` alternatives).
 *   - A `!glob` in a module's list takes files out of that module's own globs (so a directory
 *     can go to one module while a file in it goes to another); it gives them to nobody.
 *   - `core.<package>` lists globs that stay core although a module glob matches them; they win.
 *   - A file may match the globs of ONE module only: two is an error (ownerOf throws, --check
 *     names the file and both modules).
 *   - A file that matches nothing is core.
 *   - A colocated file follows its source: x.test.js, x.<what>.test.js, x.testkit.js,
 *     x.<what>.golden.json, x.<what>.fixture.js and x.d.ts next to x.js / x.mts / x.cjs (or next
 *     to a directory x/ with an index file) belong to the owner of x, unless a glob names the
 *     colocated file itself (matches it and not x). The longest existing stem wins:
 *     a.b.test.js follows a.b.js when that exists, else a.js.
 *   - Non-code files (prompts, json, assets, i18n namespace files) are owned like code.
 *   - A file that already sits in `modules/<id>/` is owned by <id>; --check fails when the
 *     globs say otherwise.
 *   - `requires` (hard, no cycle) and `uses` (soft) name other module ids.
 *
 * Loaded with require() by server/modules/roots/rootSet.cjs in core mode
 * (`loadModuleMap().ownerOf('server', treePath)`): node:* only, no top-level await, synchronous.
 *
 *   node scripts/module-map.mjs --check           every file one owner, every glob used, ids and requires sound
 *   node scripts/module-map.mjs --owner <path>    who owns this file (a tree path, or server/<path>)
 *   node scripts/module-map.mjs --list <id|core>  the files of a module, or of the core
 *   node scripts/module-map.mjs --edges [--from core|<id>] [--to core|<id>] [--json] [--tests]
 *   node scripts/module-map.mjs --summary [--tests]  per module: files, tests, core->module edges,
 *                                                    module->core files, module->module edges
 * Edges come from scripts/module-map-edges.mjs (run-time only, type-only references excluded);
 * test files are left out unless --tests.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importEdges } from './module-map-edges.mjs';
import { isEntryPoint } from './entry-point.mjs';

export { importEdges, scanSource } from './module-map-edges.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLOCATED = [/^(.+)\.test\.[cm]?[jt]s$/, /^(.+)\.testkit\.[cm]?[jt]s$/, /^(.+)\.golden\.json$/, /^(.+)\.fixture\.[cm]?[jt]s$/, /^(.+)\.d\.[cm]?ts$/];
const SOURCE_EXT = ['.js', '.mts', '.cjs', '.mjs', '.cts', '.ts', '.json'];

/**
 * A glob over tree paths as a regular expression.
 * @param {string} glob
 */
export function globToRegExp(glob) {
    let re = '';
    let depth = 0;
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            const slash = glob[i + 2] === '/';
            re += slash ? '(?:.*/)?' : '.*';
            i += slash ? 2 : 1;
        } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else if (c === '{') { re += '(?:'; depth++; }
        else if (c === '}' && depth > 0) { re += ')'; depth--; }
        else if (c === ',' && depth > 0) re += '|';
        else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

/** Is a tree path a colocated test, fixture, golden or declaration file? */
export const isColocated = (treePath) => COLOCATED.some((re) => re.test(path.posix.basename(treePath)));

/**
 * The possible sources of a colocated file, the longest stem first, the same extension first.
 * @param {string} treePath
 */
function sourceCandidates(treePath) {
    const dir = path.posix.dirname(treePath);
    const base = path.posix.basename(treePath);
    const re = COLOCATED.find((r) => r.test(base));
    if (!re) return [];
    const parts = /** @type {RegExpMatchArray} */ (base.match(re))[1].split('.');
    const own = (base.match(/\.[cm]?[jt]s$/) || [''])[0].replace(/^\.d/, '');
    const exts = [...new Set([own, ...SOURCE_EXT])].filter(Boolean);
    const out = [];
    for (let n = parts.length; n >= 1; n--) {
        const stem = parts.slice(0, n).join('.');
        const at = dir === '.' ? stem : `${dir}/${stem}`;
        for (const e of exts) out.push(at + e);
        for (const e of exts) out.push(`${at}/index${e}`);
    }
    return out;
}

/**
 * @param {{ packages?: Record<string, object>, modules?: Record<string, Record<string, any>>, core?: Record<string, string[]> }} raw the parsed module-map.json
 * @param {(pkg: string, treePath: string) => boolean} exists does a tree path exist in any root
 */
export function compileMap(raw, exists) {
    const compiled = {};
    for (const [id, mod] of Object.entries(raw.modules || {})) {
        for (const pkg of Object.keys(raw.packages || {})) {
            for (const glob of mod[pkg] || []) {
                const neg = glob.startsWith('!');
                (compiled[pkg] ??= []).push({ id, glob, neg, re: globToRegExp(neg ? glob.slice(1) : glob) });
            }
        }
    }
    const core = {};
    for (const [pkg, globs] of Object.entries(raw.core || {})) core[pkg] = globs.map((glob) => ({ id: null, glob, neg: false, re: globToRegExp(glob) }));
    /** The globs that claim a path: core ones, and a module's positive ones unless its `!glob` removes the path. */
    const matching = (pkg, p) => {
        const hits = (core[pkg] || []).filter((g) => g.re.test(p));
        const mods = compiled[pkg] || [];
        const removed = new Set(mods.filter((g) => g.neg && g.re.test(p)).map((g) => g.id));
        return hits.concat(mods.filter((g) => !g.neg && !removed.has(g.id) && g.re.test(p)));
    };
    const key = (g) => `${g.id}\0${g.glob}`;

    /** @returns {{ owner: string | null, conflict: string[] | null }} */
    function direct(pkg, p, only) {
        const hits = only || matching(pkg, p);
        if (hits.some((g) => g.id === null)) return { owner: null, conflict: null };
        const ids = [...new Set(hits.map((g) => g.id))];
        return { owner: ids[0] ?? null, conflict: ids.length > 1 ? ids : null };
    }
    /** @returns {{ owner: string | null, conflict: string[] | null }} */
    function resolve(pkg, p) {
        if (!isColocated(p)) return direct(pkg, p);
        const source = sourceCandidates(p).find((c) => c !== p && exists(pkg, c));
        if (!source) return direct(pkg, p);
        const sourceGlobs = new Set(matching(pkg, source).map(key));
        const naming = matching(pkg, p).filter((g) => !sourceGlobs.has(key(g)));
        return naming.length ? direct(pkg, p, naming) : resolve(pkg, source);
    }
    return {
        resolve,
        ownerOf(pkg, treePath) {
            const r = resolve(pkg, treePath);
            if (r.conflict) throw new Error(`module-map: ${pkg}/${treePath} matches the globs of ${r.conflict.join(' and ')}`);
            return r.owner;
        },
        globs: (pkg) => [...(core[pkg] || []), ...(compiled[pkg] || [])],
    };
}

/**
 * The tracked files of a package: the core directory and every modules/<id>/<moduleDir>.
 * @param {string} repoRoot
 * @param {{ coreDir: string, moduleDir: string }} spec
 * @returns {{ treePath: string, abs: string, root: string | null }[]}
 */
function trackedFiles(repoRoot, spec) {
    let list;
    try {
        list = execFileSync('git', ['ls-files', '-z', '--', spec.coreDir, 'modules'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
    } catch {
        list = walk(repoRoot, spec.coreDir).concat(walk(repoRoot, 'modules'));
    }
    const out = [];
    for (const rel of list) {
        if (!fs.existsSync(path.join(repoRoot, rel))) continue; // deleted in the work tree
        if (rel.startsWith(`${spec.coreDir}/`)) out.push({ treePath: rel.slice(spec.coreDir.length + 1), abs: path.join(repoRoot, rel), root: null });
        const m = rel.match(/^modules\/([^/]+)\/([^/]+)\/(.+)$/);
        if (m && m[2] === spec.moduleDir) out.push({ treePath: m[3], abs: path.join(repoRoot, rel), root: m[1] });
    }
    return out;
}

function walk(repoRoot, dir) {
    const out = [];
    const visit = (rel) => {
        for (const e of fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const r = `${rel}/${e.name}`;
            if (e.isDirectory()) visit(r); else out.push(r);
        }
    };
    if (fs.existsSync(path.join(repoRoot, dir))) visit(dir);
    return out;
}

/**
 * Load the ownership map.
 * @param {string} [repoRoot] the repository root (default: the one this script is in)
 */
export function loadModuleMap(repoRoot = DEFAULT_ROOT) {
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', 'module-map.json'), 'utf8'));
    const roots = (pkg) => {
        const spec = raw.packages[pkg];
        const dirs = [path.join(repoRoot, spec.coreDir)];
        for (const e of fs.existsSync(path.join(repoRoot, 'modules')) ? fs.readdirSync(path.join(repoRoot, 'modules')) : []) dirs.push(path.join(repoRoot, 'modules', e, spec.moduleDir));
        return dirs;
    };
    const rootCache = {};
    const exists = (pkg, p) => (rootCache[pkg] ??= roots(pkg)).some((d) => fs.existsSync(path.join(d, p)));
    const map = compileMap(raw, exists);
    const fileCache = {};
    return {
        raw,
        ownerOf: (pkg, treePath) => map.ownerOf(pkg, treePath),
        resolve: (pkg, treePath) => map.resolve(pkg, treePath),
        modules: () => Object.keys(raw.modules || {}),
        globsOf: (id, pkg) => (id === 'core' ? raw.core?.[pkg] : raw.modules?.[id]?.[pkg]) || [],
        allGlobs: (pkg) => map.globs(pkg),
        /** @returns {{ treePath: string, abs: string, root: string | null, owner: string | null, conflict: string[] | null, mapped: string | null }[]} */
        files(pkg) {
            return (fileCache[pkg] ??= trackedFiles(repoRoot, raw.packages[pkg]).map((f) => {
                const r = map.resolve(pkg, f.treePath);
                return { ...f, owner: f.root ?? r.owner, conflict: r.conflict, mapped: r.owner };
            }));
        },
        /** Run-time edges between the files of a package, each with both owners. */
        edges(pkg, { tests = false } = {}) {
            const files = this.files(pkg);
            const ownerByPath = new Map(files.map((f) => [f.treePath, f.owner]));
            const scanned = tests ? files : files.filter((f) => !isColocated(f.treePath));
            return importEdges(scanned).filter((e) => ownerByPath.has(e.to)).map((e) => ({ ...e, fromOwner: ownerByPath.get(e.from) ?? null, toOwner: ownerByPath.get(e.to) ?? null }));
        },
    };
}

/**
 * Everything wrong with a map: the lines --check prints.
 * @param {ReturnType<typeof loadModuleMap>} map
 */
export function checkMap(map) {
    const problems = [];
    const ids = new Set(map.modules());
    for (const [id, mod] of Object.entries(map.raw.modules || {})) {
        for (const kind of ['requires', 'uses']) {
            for (const dep of mod[kind] || []) if (!ids.has(dep)) problems.push(`${id}.${kind}: unknown module "${dep}"`);
        }
    }
    const cycle = requiresCycle(map.raw.modules || {});
    if (cycle) problems.push(`requires has a cycle: ${cycle.join(' -> ')}`);
    for (const pkg of Object.keys(map.raw.packages)) {
        const files = map.files(pkg);
        for (const f of files) {
            if (f.conflict) problems.push(`${pkg}/${f.treePath}: owned by two modules (${f.conflict.join(', ')})`);
            else if (f.root && f.mapped !== f.root) problems.push(`${pkg}/${f.treePath}: sits in modules/${f.root} but the map says ${f.mapped ?? 'core'}`);
        }
        for (const g of map.allGlobs(pkg)) {
            if (!files.some((f) => g.re.test(f.treePath))) problems.push(`${pkg}: glob "${g.glob}" of ${g.id ?? 'core'} matches no file`);
        }
    }
    return problems;
}

/**
 * @param {Record<string, { requires?: string[] }>} modules
 * @returns {string[] | null} a cycle in `requires`, or null
 */
export function requiresCycle(modules) {
    const state = new Map();
    const stack = [];
    const visit = (id) => {
        if (state.get(id) === 'done') return null;
        if (state.get(id) === 'open') return [...stack.slice(stack.indexOf(id)), id];
        state.set(id, 'open'); stack.push(id);
        for (const dep of modules[id]?.requires || []) {
            const found = visit(dep);
            if (found) return found;
        }
        stack.pop(); state.set(id, 'done');
        return null;
    };
    for (const id of Object.keys(modules)) {
        const found = visit(id);
        if (found) return found;
    }
    return null;
}

/**
 * The --summary rows.
 * @param {ReturnType<typeof loadModuleMap>} map
 * @param {string} pkg
 * @param {{ tests?: boolean }} [opts]
 */
export function summarize(map, pkg, opts = {}) {
    const files = map.files(pkg);
    const edges = map.edges(pkg, opts);
    const rows = [];
    for (const id of ['core', ...map.modules()]) {
        const own = files.filter((f) => (f.owner ?? 'core') === id);
        const deps = new Set([...(map.raw.modules?.[id]?.requires || []), ...(map.raw.modules?.[id]?.uses || [])]);
        const out = edges.filter((e) => (e.fromOwner ?? 'core') === id && (e.toOwner ?? 'core') !== id);
        rows.push({
            id,
            files: own.length,
            tests: own.filter((f) => isColocated(f.treePath)).length,
            coreIn: id === 'core' ? 0 : edges.filter((e) => e.fromOwner === null && e.toOwner === id).length,
            coreFiles: id === 'core' ? 0 : new Set(out.filter((e) => e.toOwner === null).map((e) => e.to)).size,
            declared: out.filter((e) => e.toOwner !== null && deps.has(e.toOwner)).length,
            undeclared: id === 'core' ? 0 : out.filter((e) => e.toOwner !== null && !deps.has(e.toOwner)).length,
        });
    }
    return rows;
}

function arg(argv, name) {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
}

function printSummary(rows) {
    const head = ['module', 'files', 'tests', 'core->mod', 'mod->core files', 'mod->mod declared', 'undeclared'];
    const lines = [head, ...rows.map((r) => [r.id, r.files, r.tests, r.coreIn, r.coreFiles, r.declared, r.undeclared].map(String))];
    const width = head.map((_, c) => Math.max(...lines.map((l) => l[c].length)));
    for (const l of lines) console.log(l.map((v, c) => (c === 0 ? v.padEnd(width[c]) : v.padStart(width[c]))).join('  '));
    console.log(`total core->module edges: ${rows.reduce((s, r) => s + r.coreIn, 0)}`);
}

function main(argv) {
    const map = loadModuleMap();
    const pkg = arg(argv, '--package') || 'server';
    const tests = argv.includes('--tests');
    if (argv.includes('--check')) {
        const problems = checkMap(map);
        for (const p of problems) console.error(p);
        console.log(problems.length ? `module-map: ${problems.length} problem(s)` : `module-map: ok (${map.files(pkg).length} ${pkg} files, ${map.modules().length} modules)`);
        return problems.length ? 1 : 0;
    }
    const owner = arg(argv, '--owner');
    if (owner) {
        const p = owner.startsWith(`${map.raw.packages[pkg].coreDir}/`) ? owner.slice(map.raw.packages[pkg].coreDir.length + 1) : owner;
        console.log(map.ownerOf(pkg, p) ?? 'core');
        return 0;
    }
    const list = arg(argv, '--list');
    if (list) {
        for (const f of map.files(pkg)) if ((f.owner ?? 'core') === list) console.log(f.treePath);
        return 0;
    }
    if (argv.includes('--edges')) {
        const from = arg(argv, '--from');
        const to = arg(argv, '--to');
        const picked = map.edges(pkg, { tests }).filter((e) => (e.fromOwner ?? 'core') !== (e.toOwner ?? 'core')
            && (!from || (e.fromOwner ?? 'core') === from) && (!to || (e.toOwner ?? 'core') === to));
        if (argv.includes('--json')) console.log(JSON.stringify(picked, null, 2));
        else for (const e of picked) console.log(`${e.from}:${e.line} -> ${e.to}  (${e.fromOwner ?? 'core'} -> ${e.toOwner ?? 'core'}, ${e.lazy ? 'lazy' : 'top-level'})`);
        return 0;
    }
    if (argv.includes('--summary')) {
        printSummary(summarize(map, pkg, { tests }));
        return 0;
    }
    console.error('usage: node scripts/module-map.mjs --check | --owner <path> | --list <id|core> | --edges [--from x] [--to y] [--json] | --summary');
    return 2;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
