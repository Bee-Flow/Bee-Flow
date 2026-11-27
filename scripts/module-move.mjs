#!/usr/bin/env node
/**
 * Move the server files of a first-party module from server/ to modules/<id>/server, every file on its own tree path, in one commit that is green by itself.
 *
 *   node scripts/module-move.mjs <id> [--pkg server] [--dry] [--no-commit] [--report <file>]
 *   node scripts/module-move.mjs --all --rehearse [--report <file>]   every module, for measuring
 *
 * No import specifier changes: the resolver (server/moduleRoots.cjs) joins the roots into one
 * tree, so a move is a rename. The steps, in order:
 *
 *   1. preflight: a clean work tree (not with --rehearse), `module-map --check` passes, the files
 *      are those the ownership map gives to <id> that are still under server/ (fewer than 3000
 *      per module), no destination exists, no destination is ignored by git
 *      (`git check-ignore --no-index`), and no manifest (json, yaml, toml) names a directory the
 *      move splits as a value of its own (a split named in prose is reported, not refused).
 *   2. `git mv`, one call per directory (in batches).
 *   3. path-keyed state: the entries of the moved files leave server/eslint-suppressions.json
 *      for modules/<id>/server/eslint-suppressions.json (same keys; ESLint keys by working
 *      directory) and modules/<id>/server/eslint.config.js re-exports the core's. Everything
 *      else keyed by tree path (test durations, exclusions, file budget, ratchets) stays one
 *      file with the same keys. Repository paths of moved files in other text files (workflows,
 *      scripts/*.json, docs, mobile and agent-hub tests; scripts/lib/path-mentions.mjs) are
 *      rewritten to modules/<id>/server/<tree path>. Files inside the tree roots are not, and
 *      the code and prose of scripts/ (fixtures, the generated README table) are only reported.
 *   4. the module root gets its node_modules link (scripts/link-module-node-modules.mjs).
 *   5. gates: the sha256 of every moved file equals its HEAD version, duplicateTreePaths() is
 *      empty, `module-map --check` and the module boundary (rule 4 applies now) pass, and the
 *      generators report no drift (lint:i18n-gen, lint:shared-mirror, lint:scripts-index).
 *   6. commit "Move module <id> to modules/<id>/server" (not with --no-commit or --rehearse).
 *      A failed gate restores the tree (`git reset --hard`, created directories removed) and
 *      exits 1 with the reason. --rehearse never restores and never commits: it leaves the
 *      moved tree for measuring and reports every gate.
 *
 * BEEFLOW_MODULE_ROOTS and BEEFLOW_HIDE_MODULES are ignored: the move is about modules/ of
 * this checkout. Prints a summary; --report writes the whole report as JSON. Exit 2: refused.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { createMentionResolver, rewriteMentions } from './lib/path-mentions.mjs';
import { TEXT_EXT, walkFiles } from './lib/repo-text.mjs';
import { makeLink, plannedLinks } from './link-module-node-modules.mjs';
import { BUDGET_REL, analyze, overBudget } from './module-boundary.mjs';
import { checkMap, loadModuleMap } from './module-map.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_FILES = 3000;
const PKG = 'server';
const SUPPRESSIONS = 'eslint-suppressions.json';
export const ESLINT_CONFIG = "// @typecheck strict\nmodule.exports = require('../../../server/eslint.config.js');\n";
export const DEFAULT_COMMANDS = Object.freeze([['npm', 'run', '-s', 'lint:i18n-gen'], ['npm', 'run', '-s', 'lint:shared-mirror'], ['npm', 'run', '-s', 'lint:scripts-index']]);
/** Manifests: a split directory there stops the move. Elsewhere (prose, code) it is reported. */
const MANIFEST = /\.(?:json|ya?ml|toml)$/;
/** The tree roots: their files keep their bytes (or are tree-path keyed). */
const IN_TREE = /^(?:server\/|modules\/[^/]+\/(?:server|frontend)\/)/;
const BATCH = 200;
/**
 * Repository tooling: its fixtures name server paths that are not the real files, and its
 * README table is generated from its headers. Its mentions are reported (`stale`), never rewritten.
 */
const KEEP_TEXT = /^scripts\/(?!.*\.json$)/;

/** @typedef {{ treePath: string, id: string, from: string, to: string }} Moving  from/to: repository paths */
/** @typedef {{ name: string, ok: boolean, detail: string, problems?: string[] }} Gate */

/** @param {string} msg */
function refuse(msg) { const e = /** @type {any} */ (new Error(msg)); e.refused = true; return e; }

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} [input]
 */
function git(cwd, args, input) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Step 1, without the text scan: the files to move.
 * @param {string} repoRoot
 * @param {string[]} ids
 * @param {{ rehearse?: boolean }} opts
 * @returns {{ moving: Moving[], dest: Map<string, string> }}
 */
export function planMove(repoRoot, ids, opts = {}) {
    if (!opts.rehearse && git(repoRoot, ['status', '--porcelain']).trim()) throw refuse('the work tree is not clean; commit or set aside the changes first');
    const map = loadModuleMap(repoRoot);
    const problems = checkMap(map);
    if (problems.length) throw refuse(`module-map --check fails:\n  ${problems.slice(0, 20).join('\n  ')}`);
    const unknown = ids.filter((id) => !map.modules().includes(id));
    if (unknown.length) throw refuse(`unknown module id(s): ${unknown.join(', ')}`);
    const files = map.files(PKG);
    const moving = files.filter((f) => f.root === null && f.owner !== null && ids.includes(f.owner))
        .map((f) => ({ treePath: f.treePath, id: /** @type {string} */ (f.owner), from: `server/${f.treePath}`, to: `modules/${f.owner}/server/${f.treePath}` }));
    for (const id of ids) {
        const n = moving.filter((m) => m.id === id).length;
        if (n >= MAX_FILES) throw refuse(`${id}: ${n} files, the limit is ${MAX_FILES - 1}; split the module or the move`);
        if (n === 0 && ids.length === 1) throw refuse(`${id}: no file of this module is left under server/`);
    }
    const existing = moving.filter((m) => fs.existsSync(path.join(repoRoot, m.to)));
    if (existing.length) throw refuse(`destination exists: ${existing.slice(0, 10).map((m) => m.to).join(', ')}`);
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: repoRoot, encoding: 'utf8', input: moving.map((m) => m.to).join('\n') }).stdout.trim();
    if (ignored) throw refuse(`git would ignore these destinations (modules/.gitignore): ${ignored.split('\n').slice(0, 20).join(', ')}`);
    const movingByPath = new Map(moving.map((m) => [m.treePath, m.id]));
    const dest = new Map(files.map((f) => [f.treePath, f.root ?? movingByPath.get(f.treePath) ?? 'core']));
    return { moving, dest };
}

/**
 * The text edits of step 3 (literal repository paths), computed without writing.
 * @param {string} repoRoot
 * @param {{ moving: Moving[], dest: Map<string, string> }} plan
 */
export function scanMentions(repoRoot, plan) {
    const resolver = createMentionResolver(plan.dest, new Map(plan.moving.map((m) => [m.treePath, m.id])));
    const edits = [];
    const splits = [];
    const stale = [];
    for (const abs of walkFiles(repoRoot, (n) => TEXT_EXT.test(n) || n.endsWith('.toml'))) {
        const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
        if (IN_TREE.test(rel) || rel.endsWith('package-lock.json')) continue;
        const text = fs.readFileSync(abs, 'utf8');
        const r = rewriteMentions(text, resolver);
        if (r.rewrites.length && KEEP_TEXT.test(rel)) stale.push({ file: rel, mentions: r.rewrites.map((w) => `${w.line}: ${w.from}`) });
        else if (r.rewrites.length) edits.push({ file: rel, text: r.text, rewrites: r.rewrites });
        for (const s of r.splits) splits.push({ file: rel, ...s, blocking: s.standalone && MANIFEST.test(rel) && !rel.startsWith('docs/') });
    }
    return { edits, splits, stale };
}

/**
 * Step 2: `git mv` per source directory, in batches.
 * @param {string} repoRoot
 * @param {Moving[]} moving
 */
function gitMove(repoRoot, moving) {
    /** @type {Map<string, Moving[]>} */
    const byDir = new Map();
    for (const m of moving) {
        const dir = path.posix.dirname(m.to);
        byDir.set(dir, [...(byDir.get(dir) || []), m]);
    }
    for (const [dir, list] of byDir) {
        fs.mkdirSync(path.join(repoRoot, dir), { recursive: true });
        for (let i = 0; i < list.length; i += BATCH) git(repoRoot, ['mv', '--', ...list.slice(i, i + BATCH).map((m) => m.from), `${dir}/`]);
    }
}

/**
 * Step 3, ESLint: the suppressions of the moved files go to their root; each root re-exports the config.
 * @param {string} repoRoot
 * @param {Moving[]} moving
 * @returns {{ written: string[], moved: Record<string, number> }}
 */
export function splitSuppressions(repoRoot, moving) {
    const coreFile = path.join(repoRoot, 'server', SUPPRESSIONS);
    const written = [];
    /** @type {Record<string, number>} */
    const moved = {};
    const raw = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf8') : null;
    const core = raw ? JSON.parse(raw) : {};
    const ids = [...new Set(moving.map((m) => m.id))];
    for (const id of ids) {
        const own = {};
        for (const m of moving) if (m.id === id && Object.hasOwn(core, m.treePath)) { own[m.treePath] = core[m.treePath]; delete core[m.treePath]; }
        const root = `modules/${id}/server`;
        moved[id] = Object.keys(own).length;
        if (moved[id]) { fs.writeFileSync(path.join(repoRoot, root, SUPPRESSIONS), JSON.stringify(own, null, 2)); written.push(`${root}/${SUPPRESSIONS}`); }
        fs.writeFileSync(path.join(repoRoot, root, 'eslint.config.js'), ESLINT_CONFIG);
        written.push(`${root}/eslint.config.js`);
    }
    if (raw && Object.values(moved).some(Boolean)) {
        fs.writeFileSync(coreFile, JSON.stringify(core, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
        written.push(`server/${SUPPRESSIONS}`);
    }
    return { written, moved };
}

/**
 * Gate: every moved file has the bytes of its HEAD version at server/<tree path>.
 * @param {string} repoRoot
 * @param {Moving[]} moving
 * @returns {Gate}
 */
export function shaGate(repoRoot, moving) {
    const out = execFileSync('git', ['cat-file', '--batch'], { cwd: repoRoot, input: moving.map((m) => `HEAD:${m.from}\n`).join(''), maxBuffer: 1 << 30 });
    const problems = [];
    let at = 0;
    for (const m of moving) {
        const nl = out.indexOf(10, at);
        const head = out.subarray(at, nl).toString('utf8').split(' ');
        at = nl + 1;
        if (head[1] === 'missing') { problems.push(`${m.from}: not in HEAD`); continue; }
        const size = Number(head[2]);
        const before = crypto.createHash('sha256').update(out.subarray(at, at + size)).digest('hex');
        at += size + 1;
        let after = null;
        try { after = crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, m.to))).digest('hex'); } catch { /* reported below */ }
        if (before !== after) problems.push(`${m.to}: ${after ? 'content differs from' : 'missing, was'} HEAD:${m.from}`);
    }
    return { name: 'sha256', ok: !problems.length, detail: `${moving.length - problems.length}/${moving.length} files byte-identical`, problems };
}

/**
 * Gate: every tree path in one root (server/modules/roots/treeCheck.cjs, in a fresh process).
 * @param {string} repoRoot
 * @returns {Gate}
 */
export function treeGate(repoRoot) {
    const check = path.join(repoRoot, 'server', 'modules', 'roots', 'treeCheck.cjs');
    const env = { ...process.env };
    delete env.BEEFLOW_MODULE_ROOTS;
    delete env.BEEFLOW_HIDE_MODULES;
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(check)}).duplicateTreePaths()))`], { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) return { name: 'duplicateTreePaths', ok: false, detail: `could not run: ${r.stderr.trim().split('\n')[0]}` };
    const clashes = JSON.parse(r.stdout);
    return { name: 'duplicateTreePaths', ok: !clashes.length, detail: `${clashes.length} tree path(s) in more than one root`, problems: clashes.map((c) => `${c.treePath}: ${c.roots.map((x) => x ?? 'core').join(', ')}`) };
}

/**
 * Gates: the ownership map and the module boundary, over the moved tree.
 * @param {string} repoRoot
 * @returns {Gate[]}
 */
export function mapGates(repoRoot) {
    const problems = checkMap(loadModuleMap(repoRoot));
    const analysis = analyze(repoRoot);
    const budgetFile = path.join(repoRoot, BUDGET_REL);
    const budget = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : {};
    const boundary = [...overBudget(analysis, budget), ...analysis.undeclared, ...(analysis.cycle ? [`requires cycle: ${analysis.cycle.join(' -> ')}`] : []), ...analysis.location];
    return [
        { name: 'module-map --check', ok: !problems.length, detail: `${problems.length} problem(s)`, problems },
        { name: 'module-boundary', ok: !boundary.length, detail: `${boundary.length} problem line(s)`, problems: boundary },
    ];
}

/**
 * Gates: generators in check mode.
 * @param {string} repoRoot
 * @param {ReadonlyArray<ReadonlyArray<string>>} commands
 * @returns {Gate[]}
 */
export function commandGates(repoRoot, commands) {
    return commands.map(([cmd, ...args]) => {
        const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 26 });
        const said = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter(Boolean);
        return { name: [cmd, ...args].join(' '), ok: r.status === 0, detail: r.status === 0 ? 'no drift' : `exit ${r.status}`, problems: r.status === 0 ? [] : said.slice(-15) };
    });
}

/**
 * Put the tree back: tracked files from HEAD, created directories removed.
 * @param {string} repoRoot
 * @param {string[]} created repository paths of directories this run created
 */
export function restore(repoRoot, created) {
    git(repoRoot, ['reset', '--hard', '--quiet', 'HEAD']);
    for (const dir of created) fs.rmSync(path.join(repoRoot, dir), { recursive: true, force: true });
}

/**
 * @param {string} repoRoot
 * @param {string[]} ids
 * @returns {string[]} the outermost of modules, modules/<id> and modules/<id>/server that do not exist yet
 */
function toCreate(repoRoot, ids) {
    if (!fs.existsSync(path.join(repoRoot, 'modules'))) return ['modules'];
    return ids.map((id) => (fs.existsSync(path.join(repoRoot, 'modules', id)) ? `modules/${id}/server` : `modules/${id}`))
        .filter((d) => !fs.existsSync(path.join(repoRoot, d)));
}

/**
 * @param {string} repoRoot
 * @param {string[]} ids
 */
function linkRoots(repoRoot, ids) {
    const mine = ids.map((id) => path.join(repoRoot, 'modules', id) + path.sep);
    return plannedLinks(repoRoot).filter((l) => mine.some((m) => l.link.startsWith(m))).map((l) => `${path.relative(repoRoot, l.link)}: ${makeLink(l)}`);
}

/**
 * @param {Moving[]} moving
 * @param {string[]} ids
 * @returns {Record<string, number>}
 */
const countById = (moving, ids) => Object.fromEntries(ids.map((id) => [id, moving.filter((m) => m.id === id).length]));

/**
 * @param {string} repoRoot
 * @param {string} id
 * @param {{ moving: Moving[], edits: { file: string }[], suppressions: { written: string[], moved: Record<string, number> } }} r
 */
function commit(repoRoot, id, r) {
    git(repoRoot, ['add', '--', ...r.suppressions.written, ...r.edits.map((e) => e.file)]);
    const body = [
        `${r.moving.length} files moved with git mv, every one on its own tree path and byte-identical; no import changes.`,
        `${r.suppressions.moved[id] || 0} eslint suppression entries moved to modules/${id}/server/${SUPPRESSIONS}.`,
        `${r.edits.length} text file(s) with repository paths rewritten${r.edits.length ? `: ${r.edits.map((e) => e.file).join(', ')}` : ''}.`,
    ].join('\n');
    git(repoRoot, ['commit', '--quiet', '-m', `Move module ${id} to modules/${id}/server`, '-m', body]);
    return git(repoRoot, ['rev-parse', '--short', 'HEAD']).trim();
}

/**
 * The whole move. Never throws for a failed gate: the report says what failed.
 * @param {{ repoRoot?: string, ids: string[], dry?: boolean, noCommit?: boolean, rehearse?: boolean, commands?: ReadonlyArray<ReadonlyArray<string>> }} opts
 */
export function moveModules(opts) {
    const repoRoot = opts.repoRoot ?? REPO;
    const { ids, rehearse = false } = opts;
    const plan = planMove(repoRoot, ids, { rehearse });
    const { edits, splits, stale } = scanMentions(repoRoot, plan);
    const report = { ids, files: countById(plan.moving, ids), edits: edits.map((e) => ({ file: e.file, rewrites: e.rewrites })), splits, stale, gates: /** @type {Gate[]} */ ([]), ok: true, commit: null, links: [] };
    const blocking = splits.filter((s) => s.blocking);
    if (blocking.length && !rehearse) throw refuse(`a manifest names a directory this move splits across roots; name the files, or move the rest too:\n  ${blocking.map((s) => `${s.file}:${s.line} ${s.mention} -> ${s.roots.join(', ')}`).join('\n  ')}`);
    if (opts.dry) return { ...report, moving: plan.moving };
    const created = toCreate(repoRoot, ids);
    try {
        gitMove(repoRoot, plan.moving);
        report.suppressions = splitSuppressions(repoRoot, plan.moving);
        for (const e of edits) fs.writeFileSync(path.join(repoRoot, e.file), e.text);
        report.links = linkRoots(repoRoot, ids);
        report.gates = [
            shaGate(repoRoot, plan.moving),
            treeGate(repoRoot),
            ...mapGates(repoRoot),
            ...commandGates(repoRoot, opts.commands ?? DEFAULT_COMMANDS),
            { name: 'manifest splits', ok: !blocking.length, detail: `${blocking.length} manifest mention(s) of a split directory`, problems: blocking.map((s) => `${s.file}:${s.line} ${s.mention} -> ${s.roots.join(', ')}`) },
        ];
    } catch (e) {
        if (!rehearse) restore(repoRoot, created);
        throw e;
    }
    report.ok = report.gates.every((g) => g.ok);
    if (rehearse) return report;
    if (!report.ok) { restore(repoRoot, created); return { ...report, restored: true }; }
    if (!opts.noCommit && ids.length === 1) report.commit = commit(repoRoot, ids[0], { moving: plan.moving, edits, suppressions: report.suppressions });
    return report;
}

/** @param {any} report */
function printReport(report) {
    for (const [id, n] of Object.entries(report.files)) console.log(`${id}: ${n} file(s)`);
    console.log(`text files rewritten: ${report.edits.length}; split-directory mentions: ${report.splits.length}; mentions left in scripts/: ${report.stale.length} file(s)`);
    for (const s of report.stale) console.log(`  check by hand: ${s.file} (${s.mentions.join(', ')})`);
    for (const g of report.gates) {
        console.log(`${g.ok ? 'ok  ' : 'FAIL'} ${g.name}: ${g.detail}`);
        for (const p of (g.ok ? [] : g.problems || []).slice(0, 10)) console.log(`       ${p}`);
    }
    if (report.restored) console.log('restored: the tree is back at HEAD');
    if (report.commit) console.log(`committed ${report.commit}`);
}

/**
 * @param {string[]} argv
 * @returns {number} the exit code
 */
export function main(argv) {
    delete process.env.BEEFLOW_MODULE_ROOTS;
    delete process.env.BEEFLOW_HIDE_MODULES;
    const flag = (name) => argv.includes(name);
    const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
    const pkg = value('--pkg') ?? PKG;
    const positional = argv.filter((a, i) => !a.startsWith('--') && !['--pkg', '--report'].includes(argv[i - 1]));
    try {
        if (pkg !== PKG) throw refuse(`--pkg ${pkg}: only the server package moves with this tool so far`);
        if (flag('--all') && !flag('--rehearse')) throw refuse('--all is for measuring only: add --rehearse');
        const ids = flag('--all') ? loadModuleMap(REPO).modules() : positional;
        if (ids.length !== 1 && !flag('--all')) throw refuse('usage: node scripts/module-move.mjs <id> [--dry] [--no-commit] | --all --rehearse  [--report <file>]');
        const report = moveModules({ ids, dry: flag('--dry'), noCommit: flag('--no-commit'), rehearse: flag('--rehearse') });
        if (value('--report')) fs.writeFileSync(path.resolve(value('--report')), `${JSON.stringify(report, null, 2)}\n`);
        if (flag('--dry')) console.log(`dry run: ${report.moving.length} file(s), ${report.edits.length} text file(s) would be rewritten`);
        printReport(report);
        return report.ok ? 0 : 1;
    } catch (e) {
        if (e.refused) { console.error(`refused: ${e.message}`); return 2; }
        throw e;
    }
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
