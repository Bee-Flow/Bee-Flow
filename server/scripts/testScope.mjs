// @typecheck strict
/**
 * Which test files a run of scripts/run-tests.mjs takes, and how its children get the
 * module-roots resolver. Pure functions; run-tests.mjs supplies the walk and the owners.
 *
 * Test files are collected over every root of the server tree (server/ and each
 * modules/<id>/server, scripts/lib/roots.mjs) and named by their TREE PATH, the path
 * relative to their root: the keys of test-durations.json and test-exclusions.json are tree
 * paths and stay valid when a file moves to a module.
 *
 *   --scope full                 every test file (the default)
 *   --scope core                 the files the ownership map gives to the core
 *   --scope <id>[,<id>...]       the files of those modules
 *   --files <tree path>,...      exactly these files (each must exist and not be excluded)
 *   --hide-modules all|<ids>     BEEFLOW_HIDE_MODULES for the children: core mode
 *
 * Scope and hiding are separate switches: "the core alone, perfect" is
 * `--scope core --hide-modules all`.
 */

import path from 'node:path';

/** @typedef {{ treePath: string, abs: string, moduleId: string | null }} TreeFile */
/** @typedef {{ kind: 'full' } | { kind: 'core' } | { kind: 'modules', ids: string[] }} Scope */
/** @typedef {{ file: string, bucket: string, reason: string }} Exclusion */
/** @typedef {(treePath: string, moduleId?: string | null) => string | null} OwnerOf */

/** Runner options that take a value; none of them reaches `node --test`. */
export const VALUE_FLAGS = Object.freeze([
    '--shard', '--files-out', '--coverage-json', '--write-durations', '--durations',
    '--scope', '--files', '--hide-modules',
]);

/**
 * The value after a runner option.
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | null} null when the option is absent
 */
export function flagValueOf(argv, name) {
    const i = argv.indexOf(name);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
}

/**
 * The exclusion list as `--list-excluded` prints it, by bucket.
 * @param {Exclusion[]} exclusions
 * @param {string[]} buckets
 */
export function exclusionTable(exclusions, buckets) {
    const width = Math.max(...exclusions.map((e) => e.file.length));
    const lines = [];
    for (const bucket of buckets) {
        const rows = exclusions.filter((e) => e.bucket === bucket);
        if (rows.length === 0) continue;
        lines.push(`\n${bucket} (${rows.length}):`, ...rows.map((e) => `  ${e.file.padEnd(width)}  ${e.reason}`));
    }
    lines.push(`\n${exclusions.length} file(s) excluded. Remove entries as they are fixed — this list should only get shorter.`);
    return lines.join('\n');
}

/** @param {string} name a file name */
export const isTestFile = (name) => name.endsWith('.test.js') || name.endsWith('.test.mjs');

/**
 * The walk filter: journeys/ at the top of a root is not part of `npm test`
 * (scripts/run-journeys.mjs runs it, in a CI job of its own).
 * @param {string} treePath
 */
export const walkFilter = (treePath) => treePath !== 'journeys';

/**
 * The test files of a walk, by tree path; the first root that has a tree path wins.
 * @param {Iterable<TreeFile>} files
 * @returns {Map<string, TreeFile>} sorted by tree path
 */
export function collectTestFiles(files) {
    /** @type {Map<string, TreeFile>} */
    const byPath = new Map();
    for (const f of files) {
        if (isTestFile(path.posix.basename(f.treePath)) && !byPath.has(f.treePath)) byPath.set(f.treePath, f);
    }
    return new Map([...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * @param {string} value comma separated
 * @returns {string[]}
 */
const listOf = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * @param {string[]} ids
 * @param {string[]} moduleIds the ids of the ownership map
 * @param {string} flag for the message
 * @param {string} words the other values the flag takes, for the message
 */
function checkIds(ids, moduleIds, flag, words) {
    const unknown = ids.filter((id) => !moduleIds.includes(id));
    if (unknown.length > 0) throw new Error(`${flag}: unknown module ${unknown.join(', ')} (known: ${words}, ${moduleIds.join(', ')})`);
}

/**
 * @param {string | null} value the --scope argument; null means full
 * @param {string[]} moduleIds
 * @returns {Scope}
 */
export function parseScope(value, moduleIds) {
    if (value === null || value === 'full') return { kind: 'full' };
    if (value === 'core') return { kind: 'core' };
    const ids = listOf(value);
    if (ids.length === 0) throw new Error('--scope: needs core, full or module ids');
    checkIds(ids, moduleIds, '--scope', 'core, full');
    return { kind: 'modules', ids };
}

/**
 * @param {string} value the --hide-modules argument
 * @param {string[]} moduleIds
 * @returns {string} the value of BEEFLOW_HIDE_MODULES
 */
export function parseHide(value, moduleIds) {
    const ids = listOf(value);
    if (ids.length === 0) throw new Error('--hide-modules: needs all or module ids');
    if (ids.includes('all')) return 'all';
    checkIds(ids, moduleIds, '--hide-modules', 'all');
    return ids.join(',');
}

/**
 * @param {Scope} scope
 * @param {OwnerOf} ownerOf
 * @returns {(treePath: string, moduleId?: string | null) => boolean}
 */
export function scopeFilter(scope, ownerOf) {
    if (scope.kind === 'full') return () => true;
    if (scope.kind === 'core') return (p, moduleId) => ownerOf(p, moduleId) === null;
    const ids = new Set(scope.ids);
    return (p, moduleId) => ids.has(ownerOf(p, moduleId) ?? '');
}

/**
 * Excluded files that no longer exist, among the exclusions of the scope: an excluded file of
 * a module outside the run's scope is that module's business (it may well not be present).
 * @param {Exclusion[]} exclusions
 * @param {(treePath: string) => boolean} exists in any root
 * @param {(treePath: string) => boolean} inScope
 */
export function staleExclusions(exclusions, exists, inScope) {
    return exclusions.filter((e) => !exists(e.file) && inScope(e.file));
}

/**
 * The files a --files list names, checked against the run's collection.
 * @param {string} value comma separated tree paths
 * @param {{ known: Set<string>, excluded: Set<string>, inScope: (treePath: string) => boolean }} ctx
 * @returns {string[]}
 */
export function pickFiles(value, ctx) {
    const files = [...new Set(listOf(value).map((f) => f.replace(/^\.\//, '')))];
    if (files.length === 0) throw new Error('--files: needs at least one tree path');
    const problems = [];
    for (const f of files) {
        if (ctx.excluded.has(f)) problems.push(`${f} is excluded (scripts/test-exclusions.json)`);
        else if (!ctx.known.has(f)) problems.push(`${f} is not a test file of any root`);
        else if (!ctx.inScope(f)) problems.push(`${f} is outside the chosen --scope`);
    }
    if (problems.length > 0) throw new Error(`--files: ${problems.join('; ')}`);
    return files.sort();
}

/**
 * NODE_OPTIONS with the resolver preloaded, appended to what is there; a path with a space,
 * a quote or a backslash is quoted the way Node parses NODE_OPTIONS.
 * @param {string | undefined} existing
 * @param {string} preload absolute path of server/moduleRoots.cjs
 */
export function withPreload(existing, preload) {
    const quoted = /[\s"\\]/.test(preload) ? `"${preload.replace(/["\\]/g, '\\$&')}"` : preload;
    const flag = `--require=${quoted}`;
    const before = (existing || '').trim();
    if (before.includes(flag)) return before;
    return before ? `${before} ${flag}` : flag;
}

/**
 * The environment of every child: the resolver through NODE_OPTIONS (so worker threads and
 * a test's own children get it too) and, when asked, core mode.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ preload: string | null, hide: string | null }} opts
 * @returns {NodeJS.ProcessEnv}
 */
export function resolverEnv(env, { preload, hide }) {
    const out = { ...env };
    if (preload) out.NODE_OPTIONS = withPreload(env.NODE_OPTIONS, preload);
    if (hide) out.BEEFLOW_HIDE_MODULES = hide;
    return out;
}
