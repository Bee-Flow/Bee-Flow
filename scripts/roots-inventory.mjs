#!/usr/bin/env node
/**
 * Check scripts/roots-inventory.json: every script, runner and config that walks, globs or names a package directory, with whether it knows about module roots.
 *
 * Once files move from server/ to modules/<id>/server and from agent-hub/src to
 * modules/<id>/frontend/src (scripts/lib/roots.mjs), a tool that only knows server/ or
 * agent-hub/src goes red or, worse, silently stops seeing the moved code. The inventory is
 * the list of those tools and the work list for converting them:
 *
 *   { "file", "status": "root-aware" | "not-applicable" | "pending", "what", "reason"?, "group"? }
 *
 *   root-aware       already sees every root (goes through scripts/lib/roots.mjs, or walks
 *                    the whole repository, modules/ included)
 *   not-applicable   names only fixed files or directories that never move (a package.json,
 *                    node_modules, a Dockerfile), or a test with fixture paths only; `reason` required
 *   pending          walks server/ or agent-hub/src, or names files that can move; `group`
 *                    is the batch a later conversion takes it in
 *
 * The gate: (a) every file in the scanned locations whose text names a package directory is
 * listed, so a new script cannot be forgotten; (b) every entry points at a file that exists;
 * (c) the number of pending entries stays within `pendingBudget`, which only goes down.
 *
 *   node scripts/roots-inventory.mjs            the gate
 *   node scripts/roots-inventory.mjs --list     pending entries by group
 *   node scripts/roots-inventory.mjs --update   lower pendingBudget to the measured count
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { createRoots } from './lib/roots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INVENTORY_REL = 'scripts/roots-inventory.json';
export const STATUSES = Object.freeze(['root-aware', 'not-applicable', 'pending']);

/**
 * Scanned recursively for files that name a package directory: scripts/, and in every server
 * root (server/ and each modules/<id>/server) its scripts/ and testUtils/ and the tests at its top.
 */
export const SCANNED_DIRS = Object.freeze(['scripts']);
export const SCANNED_IN_SERVER_ROOTS = Object.freeze(['scripts', 'testUtils']);
/** Config files that are always listed, whatever their text (a `*` matches within one name). */
export const CONFIGS = Object.freeze([
    '.jscpd.json', '.semgrep/*.yml', '.gitleaks.toml',
    'server/.c8rc.json', 'server/.dockerignore', 'server/eslint.config.js', 'server/jsconfig.json',
    'agent-hub/knip.json', 'agent-hub/eslint.config.js', 'agent-hub/tsconfig*.json', 'agent-hub/vite.config.js',
    'mobile/jest.config.js', 'mobile/jest.resolver.js', 'scripts/shared-mirror.manifest.json',
    'docker-compose*.yml', '.github/workflows/*.yml',
]);
const SCANNED_EXT = /\.(?:[cm]?[jt]s|sh|ps1|json|ya?ml|toml)$/;
const SKIP_NAMES = new Set(['node_modules', 'coverage', 'dist', '.git', 'package-lock.json', path.basename(INVENTORY_REL)]);

/** `server/…`, `'server'`, `agent-hub/…`, `'agent-hub'`: a package directory written as a path. */
const NAMES_PACKAGE = /(?<![\w@.$-])server\/|(?<![\w@.$-])agent-hub(?=[/'"`])|['"`/]agent-hub(?![\w-])|['"`]server['"`]/;
/** `path.join(ROOT, pkg)`: a package directory chosen on the command line. */
const JOINS_PACKAGE = /\b(?:join|resolve)\((?:ROOT|REPO|REPO_ROOT|repoRoot|root),\s*(?:pkg|pkgName|packageName)\b/;
/** Inside server/: a path computed from the file's own place. */
const OWN_PLACE = /__dirname|import\.meta\.(?:url|dirname)/;

/**
 * Does this file walk, glob or name a package directory?
 * @param {string} rel repository path
 * @param {string} text
 * @param {boolean} [inServerRoot] the file lies in a server root: a path computed from its own place counts too
 */
export function namesPackage(rel, text, inServerRoot = false) {
    if (NAMES_PACKAGE.test(text) || JOINS_PACKAGE.test(text)) return true;
    return inServerRoot && /\.[cm]?[jt]s$/.test(rel) && OWN_PLACE.test(text);
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string[]} out
 */
function walk(root, rel, out) {
    let entries = [];
    try {
        entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (SKIP_NAMES.has(e.name)) continue;
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(root, child, out);
        else if (SCANNED_EXT.test(e.name)) out.push(child);
    }
}

/**
 * The files of one CONFIGS pattern that exist.
 * @param {string} root
 * @param {string} pattern
 */
function expandConfig(root, pattern) {
    const dir = path.posix.dirname(pattern);
    const name = path.posix.basename(pattern);
    if (!name.includes('*')) return fs.existsSync(path.join(root, pattern)) ? [pattern] : [];
    const [head, tail] = name.split('*');
    let names = [];
    try {
        names = fs.readdirSync(path.join(root, dir));
    } catch {
        return [];
    }
    return names.filter((n) => n.startsWith(head) && n.endsWith(tail) && n.length >= head.length + tail.length)
        .map((n) => (dir === '.' ? n : `${dir}/${n}`));
}

/**
 * Every repository path the inventory must list: the configs, and the files in the scanned
 * locations (the dirs and the top-level server/*.test.js) that name a package directory.
 * @param {string} [root]
 * @returns {string[]} sorted
 */
export function requiredFiles(root = ROOT) {
    const roots = createRoots({ repoRoot: root });
    const scanned = [];
    for (const dir of SCANNED_DIRS) walk(root, dir, scanned);
    const serverRoots = roots.rootsOf('server').map((r) => roots.toRepoPath(r.dir));
    for (const top of serverRoots) {
        for (const dir of SCANNED_IN_SERVER_ROOTS) walk(root, `${top}/${dir}`, scanned);
        for (const name of fs.readdirSync(path.join(root, top))) if (name.endsWith('.test.js')) scanned.push(`${top}/${name}`);
    }
    const inServerRoot = (/** @type {string} */ rel) => serverRoots.some((top) => rel.startsWith(`${top}/`));
    const required = new Set(CONFIGS.flatMap((p) => expandConfig(root, p)));
    for (const rel of scanned) if (namesPackage(rel, fs.readFileSync(path.join(root, rel), 'utf8'), inServerRoot(rel))) required.add(rel);
    return [...required].sort();
}

/**
 * @typedef {{ file: string, status: string, what: string, reason?: string, group?: string }} Entry
 * @typedef {{ _comment?: string, pendingBudget: number, groups?: Record<string, string>, entries: Entry[] }} Inventory
 */

/** @param {string} [root] @returns {Inventory} */
export function readInventory(root = ROOT) {
    return JSON.parse(fs.readFileSync(path.join(root, INVENTORY_REL), 'utf8'));
}

/**
 * The shape problems of the entries: status, `what`, `reason` for not-applicable, `group`
 * for pending (one of `groups`), sorted, no duplicates.
 * @param {Inventory} inv
 */
export function shapeErrors(inv) {
    const errors = [];
    const groups = inv.groups || {};
    for (const e of inv.entries) {
        if (!STATUSES.includes(e.status)) errors.push(`${e.file}: status "${e.status}" is not one of ${STATUSES.join(', ')}`);
        if (!e.what || !e.what.trim()) errors.push(`${e.file}: "what" is empty`);
        if (e.status === 'not-applicable' && !(e.reason && e.reason.trim())) errors.push(`${e.file}: not-applicable needs a "reason"`);
        if (e.status === 'pending' && !Object.hasOwn(groups, e.group || '')) errors.push(`${e.file}: pending needs a "group" from "groups" (got ${e.group})`);
    }
    const files = inv.entries.map((e) => e.file);
    const dupes = files.filter((f, i) => files.indexOf(f) !== i);
    if (dupes.length) errors.push(`listed twice: ${[...new Set(dupes)].join(', ')}`);
    if (files.join('\n') !== [...files].sort().join('\n')) errors.push('entries are not sorted by file');
    return errors;
}

/**
 * The whole gate.
 * @param {{ root?: string, inventory?: Inventory }} [opts]
 * @returns {{ missing: string[], stale: string[], shape: string[], pending: number, budget: number }}
 */
export function check({ root = ROOT, inventory = readInventory(root) } = {}) {
    const listed = new Set(inventory.entries.map((e) => e.file));
    return {
        missing: requiredFiles(root).filter((f) => !listed.has(f)),
        stale: inventory.entries.map((e) => e.file).filter((f) => !fs.existsSync(path.join(root, f))),
        shape: shapeErrors(inventory),
        pending: inventory.entries.filter((e) => e.status === 'pending').length,
        budget: inventory.pendingBudget,
    };
}

/** @param {Inventory} inv @returns {Map<string, string[]>} group -> pending files */
export function pendingByGroup(inv) {
    const out = new Map(Object.keys(inv.groups || {}).map((g) => [g, []]));
    for (const e of inv.entries) if (e.status === 'pending') out.get(/** @type {string} */ (e.group))?.push(e.file);
    return out;
}

/** @param {ReturnType<typeof check>} r */
function report(r) {
    const lines = [];
    if (r.missing.length) lines.push(`not in ${INVENTORY_REL} (add an entry: root-aware, not-applicable with a reason, or pending with a group):`, ...r.missing.map((f) => `  ${f}`));
    if (r.stale.length) lines.push('entries for files that no longer exist (remove them):', ...r.stale.map((f) => `  ${f}`));
    if (r.shape.length) lines.push(...r.shape);
    if (r.pending > r.budget) lines.push(`${r.pending} pending entries, over the budget of ${r.budget}: convert a tool (scripts/lib/roots.mjs) instead of adding one`);
    return lines;
}

/**
 * Lower pendingBudget to the measured count; never raises it.
 * @param {string} [root]
 * @returns {{ from: number, to: number }}
 */
export function lowerBudget(root = ROOT) {
    const file = path.join(root, INVENTORY_REL);
    const inv = readInventory(root);
    const pending = inv.entries.filter((e) => e.status === 'pending').length;
    if (pending < inv.pendingBudget) {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/("pendingBudget":\s*)\d+/, `$1${pending}`));
    }
    return { from: inv.pendingBudget, to: Math.min(pending, inv.pendingBudget) };
}

/**
 * @param {string[]} argv
 * @param {string} [root]
 * @returns {number} exit code
 */
export function main(argv, root = ROOT) {
    const inv = readInventory(root);
    if (argv.includes('--list')) {
        for (const [group, files] of pendingByGroup(inv)) console.log(`${group} (${files.length}): ${inv.groups?.[group] ?? ''}\n${files.map((f) => `  ${f}`).join('\n')}`);
        return 0;
    }
    const problems = report(check({ root, inventory: inv }));
    if (problems.length) {
        console.error(`roots-inventory:\n${problems.join('\n')}`);
        return 1;
    }
    if (argv.includes('--update')) {
        const { from, to } = lowerBudget(root);
        console.log(from === to ? `roots-inventory: pendingBudget stays ${to}` : `roots-inventory: pendingBudget lowered from ${from} to ${to}`);
        return 0;
    }
    const counts = STATUSES.map((s) => `${inv.entries.filter((e) => e.status === s).length} ${s}`).join(', ');
    console.log(`roots-inventory: ${inv.entries.length} entries (${counts}); pending within the budget of ${inv.pendingBudget}`);
    return 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
