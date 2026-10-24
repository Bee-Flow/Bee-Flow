#!/usr/bin/env node
/**
 * impact: given changed files, the minimal set of tests to run and the exact
 * commands, so an agent on a shared laptop neither guesses nor runs a whole suite.
 *
 *   node scripts/impact.mjs <changed files...> [--git] [--json] [--run] [--why] [--depth N]
 *
 *   --git      changed files = `git diff --name-only origin/main...HEAD`, the working
 *              tree against HEAD and untracked files
 *   --json     machine-readable result (for agents)
 *   --run      run the commands one after another and summarise pass/fail (exit 1 on a failure)
 *   --why      list every selected test with the reason it was selected
 *   --depth N  how many import hops from a changed file to look for tests (default 4)
 *
 * How a test is selected (the reason is kept per test):
 *   self      the changed file is itself a test
 *   sibling   `x.test.*` / `x.<what>.test.*` next to the changed `x.*`
 *   import    the test imports the changed file, directly or through up to --depth
 *             hops of the internal import graph (static, require() and import()
 *             anywhere in the file, jest/vitest mock paths; type-only imports do not
 *             count, same as scripts/scc-ratchet.mjs, whose parser this reuses).
 *             The graph spans server, agent-hub, mobile, desktop and scripts together, so
 *             an agent-hub test that imports a server/ file is found too.
 *   text      the test reads files as text (readFileSync, ...) and names the changed file
 *             (its path, or its basename in quotes), or it loads agent-hub source through
 *             mobile's shared/testing/webModule.ts (the lockstep tests)
 *   mirror    scripts/shared-mirror.manifest.json: a change to a source also selects the
 *             tests of its generated copies (and the other way round)
 * `--run` gives the server tests the throwaway NODE_ENV/SESSION_SECRET/MASTER_ENCRYPTION_KEY that
 * server/scripts/run-tests.mjs uses; in your own shell set them if a test asks.
 * Server tests in server/scripts/test-exclusions.json are never selected.
 *
 * Limits, on purpose: runtime-built import specifiers and tests that scan a whole
 * directory are not seen. A hit list that hit the depth cap says so; raise --depth or
 * run the package suite.
 *
 * Zero dependencies: node:* plus scripts/scc-ratchet.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { importsOf, readAliases, stripComments } from './scc-ratchet.mjs';
import { isEntryPoint } from './entry-point.mjs';

const HEAVY = '/home/tom/.claude/bin/heavy';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /\.(?:[cm]?js|jsx|ts|tsx|mts|cts)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DECL = /\.d\.[cm]?ts$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.git', '.next', 'out']);
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
// Where each package's code lives (relative to the repo root).
const PACKAGES = [
    { name: 'server', dir: 'server', scan: 'server' },
    { name: 'agent-hub', dir: 'agent-hub', scan: 'agent-hub/src' },
    { name: 'mobile', dir: 'mobile', scan: 'mobile/src' },
    { name: 'desktop', dir: 'desktop', scan: 'desktop/src' },
    { name: 'scripts', dir: 'scripts', scan: 'scripts' },
];
const GENERIC_BASENAMES = /^(?:index\.[a-z]+|package(?:-lock)?\.json|tsconfig[\w.]*\.json|README\.md|\.gitignore|Dockerfile)$/;
// A test that reads files as text (or loads web source through mobile's webModule).
const TEXT_READER = /\b(?:readFileSync|readFile|readdirSync|readdir|createReadStream)\b|\bwebModule\b|\bloadWebModule\b|\bwebFileExists\b|\bloadWebFunctions\b/;
const MOCK_CALL = /(?<![\w$])(?:vi|jest)\.(?:mock|doMock|unmock|requireActual|importActual|requireMock)\(\s*(['"])([^'"\n]+)\1/g;

const posix = (p) => p.split(path.sep).join('/');

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */

function collect(root, dir, into) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return into;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const rel = posix(path.join(dir, entry.name));
        if (entry.isDirectory()) collect(root, rel, into);
        else if (entry.isFile() && CODE.test(entry.name) && !DECL.test(entry.name)) into.push(rel);
    }
    return into;
}

export function packageOf(rel) {
    // Longest scan prefix wins; `scripts/` must not swallow `server/scripts/`.
    return PACKAGES.find((p) => rel === p.scan || rel.startsWith(`${p.scan}/`))?.name ?? null;
}

function isTestFile(rel) {
    const pkg = packageOf(rel);
    if (pkg === 'desktop' && rel.startsWith('desktop/e2e/')) return false;
    if (TEST_FILE.test(rel)) return true;
    return pkg === 'agent-hub' && /(?:^|\/)__tests__\//.test(rel);
}

function resolver(files, aliasesByPkg) {
    return (fromRel, rawSpec) => {
        const spec = rawSpec.replace(/[?#].*$/, '');
        let base;
        if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
        else {
            const aliases = aliasesByPkg.get(packageOf(fromRel)) ?? [];
            const alias = aliases.find(([prefix]) => spec.startsWith(prefix));
            if (!alias) return null;
            base = path.posix.join(alias[1], spec.slice(alias[0].length));
        }
        const cand = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => `${base}/index${e}`)];
        if (/\.[cm]?jsx?$/.test(base)) {
            const stem = base.replace(/\.[cm]?jsx?$/, '');
            cand.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
        }
        return cand.find((c) => files.has(c)) ?? null;
    };
}

/** Read every file of the five packages once: imports (resolved), reverse edges, text of text-reading tests. */
export function buildGraph(root) {
    const list = [];
    for (const p of PACKAGES) collect(root, p.scan, list);
    // `scripts` scans scripts/ but must not take server/scripts or agent-hub/scripts (different roots, so no overlap).
    const files = new Set(list);
    const aliasesByPkg = new Map();
    for (const p of PACKAGES) {
        try {
            // readAliases returns absolute dirs; make them root-relative posix with a trailing slash.
            aliasesByPkg.set(p.name, readAliases(path.join(root, p.dir)).map(([k, abs]) => [k, `${posix(path.relative(root, abs))}/`]));
        } catch {
            aliasesByPkg.set(p.name, []);
        }
    }
    const resolve = resolver(files, aliasesByPkg);
    const importers = new Map(); // file -> Set of files that import it
    const texts = new Map(); // test file -> source, only for text readers
    for (const rel of list) {
        const src = fs.readFileSync(path.join(root, rel), 'utf8');
        const specs = importsOf(src);
        if (isTestFile(rel)) {
            for (const m of stripComments(src).matchAll(MOCK_CALL)) specs.push(m[2]);
            if (TEXT_READER.test(src)) texts.set(rel, src);
        }
        for (const spec of specs) {
            const target = resolve(rel, spec);
            if (!target || target === rel) continue;
            if (!importers.has(target)) importers.set(target, new Set());
            importers.get(target).add(rel);
        }
    }
    return { root, files, tests: list.filter(isTestFile), importers, texts };
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

function loadExclusions(root) {
    try {
        const { exclusions } = JSON.parse(fs.readFileSync(path.join(root, 'server/scripts/test-exclusions.json'), 'utf8'));
        return new Set(exclusions.map((e) => `server/${e.file}`));
    } catch {
        return new Set();
    }
}

/** Derived changed files from the shared-mirror manifest: source -> targets and target -> sources. */
export function mirrorPeers(root, rel) {
    let entries;
    try {
        entries = JSON.parse(fs.readFileSync(path.join(root, 'scripts/shared-mirror.manifest.json'), 'utf8')).entries ?? [];
    } catch {
        return [];
    }
    const peers = [];
    const map = (from, to, entry) => {
        let sub;
        if (rel === from) sub = '';
        else if (rel.startsWith(`${from}/`)) sub = rel.slice(from.length + 1);
        else return;
        if (sub) {
            if (entry.include && !entry.include.includes(sub)) return;
            if (entry.exclude?.includes(sub)) return;
        }
        const out = sub ? `${to}/${sub}` : to;
        if (!TEST_FILE.test(out) && fs.existsSync(path.join(root, out))) peers.push(out);
    };
    for (const e of entries) {
        map(e.source, e.target, e);
        map(e.target, e.source, e);
    }
    return peers;
}

function siblingsOf(graph, rel) {
    const dir = path.posix.dirname(rel);
    const stem = path.posix.basename(rel).replace(/\.[^.]+$/, '');
    return graph.tests.filter((t) => {
        if (path.posix.dirname(t) !== dir) return false;
        const b = path.posix.basename(t);
        return b.startsWith(`${stem}.test.`) || (b.startsWith(`${stem}.`) && TEST_FILE.test(b));
    });
}

function mentions(text, rel) {
    const base = path.posix.basename(rel);
    const quoted = new RegExp(`['"\`/]${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
    if (text.includes(rel)) return true;
    // Package-relative spelling (`core/http/ssrfGuard.js` for server/core/...).
    const inner = rel.split('/').slice(1).join('/');
    if (inner.includes('/') && text.includes(inner)) return true;
    if (!quoted.test(text)) return false;
    if (GENERIC_BASENAMES.test(base)) {
        const parent = path.posix.basename(path.posix.dirname(rel));
        return text.includes(`${parent}/${base}`) || new RegExp(`['"\`]${parent}['"\`]\\s*,\\s*['"\`]${base}['"\`]`).test(text);
    }
    return true;
}

/**
 * @returns {{changed:string[], derived:string[], tests:Map<string,{reasons:string[]}>, excluded:string[], truncated:{file:string,count:number}[], unmapped:string[]}}
 */
export function select(graph, changedInput, { depth = 4 } = {}) {
    const exclusions = loadExclusions(graph.root);
    const changed = [...new Set(changedInput.map((f) => posix(f)))].filter((f) => fs.existsSync(path.join(graph.root, f)));
    const derived = [];
    for (const f of changed) for (const peer of mirrorPeers(graph.root, f)) if (!changed.includes(peer) && !derived.includes(peer)) derived.push(peer);
    const tests = new Map();
    const excluded = new Set();
    const truncated = [];
    const add = (t, reason) => {
        if (exclusions.has(t)) { excluded.add(t); return; }
        if (!tests.has(t)) tests.set(t, { reasons: [] });
        const r = tests.get(t).reasons;
        if (!r.includes(reason)) r.push(reason);
    };
    const roots = [...changed.map((f) => [f, null]), ...derived.map((f) => [f, `mirror of ${changed.find((c) => mirrorPeers(graph.root, c).includes(f))}`])];
    for (const [file, via] of roots) {
        const tag = (reason) => (via ? `mirror: ${reason} (${via})` : reason);
        if (graph.tests.includes(file)) add(file, tag('self'));
        for (const t of siblingsOf(graph, file)) add(t, tag('sibling'));
        // Reverse import graph, breadth first; a test is a leaf.
        const seen = new Set([file]);
        let frontier = [file];
        for (let d = 1; d <= depth && frontier.length; d++) {
            const next = [];
            for (const f of frontier) {
                for (const imp of graph.importers.get(f) ?? []) {
                    if (seen.has(imp)) continue;
                    seen.add(imp);
                    if (isTestFile(imp)) add(imp, tag(`import depth ${d}`));
                    else next.push(imp);
                }
            }
            frontier = next;
        }
        const left = new Set();
        for (const f of frontier) for (const imp of graph.importers.get(f) ?? []) if (!seen.has(imp) && !isTestFile(imp)) left.add(imp);
        if (left.size) truncated.push({ file, count: left.size });
        for (const [t, text] of graph.texts) if (mentions(text, file)) add(t, tag('text'));
    }
    const unmapped = changed.filter((f) => !packageOf(f) && !roots.some(([r]) => r === f && [...tests.values()].some((v) => v.reasons.some((x) => x.includes('text')))));
    return { changed, derived, tests, excluded: [...excluded].sort(), truncated, unmapped };
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

const SERVER_ENV = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'ci-session-secret-value-at-least-32-chars-long',
    MASTER_ENCRYPTION_KEY: 'ci-master-encryption-key-for-tests-only!!',
};

function testCommand(pkg, files) {
    const rel = (p) => files.map((f) => f.slice(p.length + 1));
    switch (pkg) {
        case 'server':
            return { cwd: 'server', env: SERVER_ENV, argv: [HEAVY, 'node', '--test', '--require', './testUtils/registerFeatures.js', ...rel('server')] };
        case 'agent-hub':
            return { cwd: 'agent-hub', argv: [HEAVY, 'npx', 'vitest', 'run', '--maxWorkers=2', ...rel('agent-hub')] };
        case 'mobile':
            return { cwd: 'mobile', argv: [HEAVY, './node_modules/.bin/jest', '-w', '2', ...rel('mobile')] };
        case 'desktop':
            // desktop/package.json: `node --test "src/**/*.test.ts"`, TypeScript run as is by Node 22.
            return { cwd: 'desktop', argv: [HEAVY, 'node', '--test', ...rel('desktop')] };
        default:
            return { cwd: '.', argv: [HEAVY, 'node', '--test', ...files] };
    }
}

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
export const render = (c) => `${c.cwd === '.' ? '' : `cd ${c.cwd} && `}${c.argv.map(quote).join(' ')}`;

/** Lint / ratchet commands for the scope the changed files touch. `run:false` ones write files and are only printed. */
export function extraCommands(changedAll, packagesTouched, root = DEFAULT_ROOT) {
    const out = [];
    const has = (re) => changedAll.some((f) => re.test(f));
    const code = changedAll.some((f) => CODE.test(f) && packageOf(f));
    if (changedAll.length) out.push({ cwd: '.', argv: ['npm', 'run', '-s', 'check:fast'], run: true, why: 'all fast checks and ratchets (once)' });
    for (const [pkg, dir] of [['agent-hub', 'agent-hub'], ['mobile', 'mobile'], ['desktop', 'desktop']]) {
        if (packagesTouched.has(pkg) && has(new RegExp(`^${dir}/.*\\.(?:ts|tsx|mts)$`))) out.push({ cwd: dir, argv: ['npm', 'run', '-s', 'typecheck'], run: true, why: `${pkg} TypeScript changed` });
    }
    if (has(/^server\/.*\.(?:mts|ts)$|^server\/scripts\/typecheck/)) out.push({ cwd: 'server', argv: ['npm', 'run', '-s', 'typecheck'], run: true, why: 'server TypeScript changed' });
    if (has(/^server\/i18n\/defaults\//)) {
        out.push({ cwd: '.', argv: ['npm', 'run', '-s', 'i18n:gen'], run: false, why: 'regenerate agent-hub/src/i18n/en-defaults.js (writes files), then commit both' });
        out.push({ cwd: '.', argv: ['npm', 'run', '-s', 'lint:i18n-gen'], run: true, why: 'English dictionary changed' });
    }
    const mirrorTouched = changedAll.some((f) => mirrorPeers(root, f).length);
    if (mirrorTouched) {
        out.push({ cwd: '.', argv: ['npm', 'run', '-s', 'gen:shared'], run: false, why: 'regenerate the mirrored copies (writes files), then commit both' });
        out.push({ cwd: '.', argv: ['npm', 'run', '-s', 'lint:shared-mirror'], run: true, why: 'a shared-mirror source or target changed' });
    }
    if (has(/^agent-hub\/src\/editor\//) || has(/^server\/core\/markdown\/editor(?:Serialization|Collab)\.cjs$/)) out.push({ cwd: '.', argv: ['npm', 'run', '-s', 'lint:editor-bundles'], run: true, why: 'editor sources or generated bundles changed' });
    if (has(/^\.github\/workflows\//)) out.push({ cwd: '.', argv: ['npm', 'run', '-s', 'lint:workflows'], run: true, why: 'workflow changed' }, { cwd: '.', argv: ['npm', 'run', '-s', 'lint:checks'], run: true, why: 'workflow changed' });
    if (has(/(?:^|\/)package(?:-lock)?\.json$|requirements[^/]*\.txt$/)) out.push({ cwd: '.', argv: ['npm', 'run', '-s', 'lint:package-registry'], run: true, why: 'dependency manifest changed' }, { cwd: '.', argv: ['npm', 'run', '-s', 'lint:version-drift'], run: true, why: 'dependency manifest changed' });
    if (code && packagesTouched.has('agent-hub')) out.push({ cwd: 'agent-hub', argv: ['npm', 'run', '-s', 'lint'], run: false, why: 'agent-hub lint (eslint over the whole package; slow, CI runs it)' });
    return out;
}

/* ------------------------------------------------------------------ */
/* Top level                                                           */
/* ------------------------------------------------------------------ */

export function analyse(root, changedInput, { depth = 4 } = {}) {
    const graph = buildGraph(root);
    const sel = select(graph, changedInput, { depth });
    const totals = {};
    for (const p of PACKAGES) totals[p.name] = graph.tests.filter((t) => packageOf(t) === p.name).length;
    const byPkg = new Map();
    for (const t of [...sel.tests.keys()].sort()) {
        const pkg = packageOf(t);
        if (!byPkg.has(pkg)) byPkg.set(pkg, []);
        byPkg.get(pkg).push(t);
    }
    const packages = {};
    for (const p of PACKAGES) {
        const files = byPkg.get(p.name);
        if (!files) continue;
        const cmd = testCommand(p.name, files);
        packages[p.name] = {
            count: files.length,
            of: totals[p.name],
            tests: files.map((file) => ({ file, reasons: sel.tests.get(file).reasons })),
            command: render(cmd),
            exec: cmd,
        };
    }
    const all = [...sel.changed, ...sel.derived];
    const extra = extraCommands(all, new Set(all.map(packageOf).filter(Boolean)), root);
    return {
        root,
        depth,
        changed: sel.changed,
        derived: sel.derived,
        packages,
        excluded: sel.excluded,
        truncated: sel.truncated,
        unmapped: sel.unmapped,
        extra: extra.map((e) => ({ ...e, command: render(e) })),
    };
}

function gitChanged(root) {
    const git = (...args) => {
        const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    };
    return [...new Set([
        ...git('diff', '--name-only', 'origin/main...HEAD'),
        ...git('diff', '--name-only', 'HEAD'),
        ...git('ls-files', '--others', '--exclude-standard'),
    ])];
}

function printHuman(r, { why }) {
    const lines = [];
    lines.push(`impact: ${r.changed.length} changed file(s)${r.derived.length ? `, +${r.derived.length} via shared-mirror` : ''}, depth cap ${r.depth}`);
    if (!Object.keys(r.packages).length) lines.push('no tests selected');
    for (const [name, p] of Object.entries(r.packages)) {
        lines.push('', `${name}: ${p.count} of ${p.of} test files${p.count > 0.6 * p.of && p.of > 20 ? '  (most of the suite: consider the package suite, CI-style)' : ''}`);
        if (why) for (const t of p.tests) lines.push(`  ${t.file}  [${t.reasons.join('; ')}]`);
        lines.push(`  ${p.command}`);
    }
    if (r.excluded.length) lines.push('', `skipped (server/scripts/test-exclusions.json): ${r.excluded.join(', ')}`);
    if (r.truncated.length) {
        lines.push('', `depth cap ${r.depth} truncated the search for ${r.truncated.length} file(s); importers left unexplored:`);
        for (const t of r.truncated.slice(0, 10)) lines.push(`  ${t.file}: ${t.count}`);
        lines.push('  raise --depth, or run the package suite');
    }
    if (r.unmapped.length) lines.push('', `no package or text-reading test for: ${r.unmapped.join(', ')}`);
    if (r.extra.length) {
        lines.push('', 'also:');
        for (const e of r.extra) lines.push(`  ${e.command}${e.run ? '' : '   (not run by --run)'}  # ${e.why}`);
    }
    console.log(lines.join('\n'));
}

function runAll(r) {
    const jobs = [
        ...Object.entries(r.packages).map(([name, p]) => ({ name: `tests: ${name}`, exec: p.exec })),
        ...r.extra.filter((e) => e.run).map((e) => ({ name: e.command, exec: e })),
    ];
    const results = [];
    for (const job of jobs) {
        console.log(`\n=== ${job.name}`);
        const [cmd, ...args] = job.exec.argv;
        const res = spawnSync(cmd, args, { cwd: path.join(r.root, job.exec.cwd), stdio: 'inherit', env: { ...process.env, ...job.exec.env } });
        results.push({ name: job.name, status: res.status ?? 1 });
    }
    console.log('\nimpact --run summary');
    for (const x of results) console.log(`  ${x.status === 0 ? 'PASS' : 'FAIL'}  ${x.name}`);
    return results.every((x) => x.status === 0) ? 0 : 1;
}

export function main(argv, root = DEFAULT_ROOT) {
    const flags = new Set();
    const files = [];
    let depth = 4;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--depth') depth = Number(argv[++i]);
        else if (a.startsWith('--')) flags.add(a);
        else files.push(path.isAbsolute(a) ? posix(path.relative(root, a)) : posix(path.normalize(a)));
    }
    if (!Number.isInteger(depth) || depth < 1) { console.error('impact: --depth needs a positive integer'); return 2; }
    const unknown = [...flags].filter((f) => !['--git', '--json', '--run', '--why'].includes(f));
    if (unknown.length) { console.error(`impact: unknown option ${unknown.join(', ')}`); return 2; }
    const changed = flags.has('--git') ? [...files, ...gitChanged(root)] : files;
    if (!changed.length) { console.error('usage: node scripts/impact.mjs <changed files...> [--git] [--json] [--run] [--why] [--depth N]'); return 2; }
    const r = analyse(root, changed, { depth });
    if (flags.has('--json')) {
        const { root: _root, ...rest } = r;
        for (const p of Object.values(rest.packages)) delete p.exec;
        for (const e of rest.extra) delete e.argv;
        console.log(JSON.stringify(rest, null, 2));
    } else printHuman(r, { why: flags.has('--why') });
    return flags.has('--run') ? runAll(r) : 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
