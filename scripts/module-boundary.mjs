#!/usr/bin/env node
/**
 * The module boundary ratchet: what the core still needs from the first-party modules may only go down, and a module may only use the modules it declares.
 *
 * Reads the ownership map (scripts/module-map.json through scripts/module-map.mjs) over the
 * server tree, test files left out, and checks four rules:
 *
 *   1. core -> module import edges, per module: the run-time edges from a core-owned file into a
 *      file owned by module X (module-map-edges.mjs: type-only references are not edges) may not
 *      exceed `coreEdges.X` in server/.module-boundary-ratchet.json (absent = 0).
 *   2. core lookups by name, per module: a call `featureModule('<name>')` with a string literal
 *      in a core-owned file whose name (the path relative to server/) resolves to a module-owned
 *      file is a dependency too; budget `coreLookups.X`. optionalFeatureModule() is not counted:
 *      it is how the core asks for a module that may be absent. integrationClient() and
 *      runnerPort() names are not tree paths and are not counted either.
 *   3. module -> module edges are declared: an edge from a file of module A into a file of
 *      module B needs B in A's `requires` or `uses`. No budget. `requires` has no cycle.
 *   4. location: once modules/<id>/server exists (rootsOf('server') in scripts/lib/roots.mjs
 *      lists it), no file the map gives to <id> is left under server/, and every file under
 *      modules/<id>/server is owned by <id>. No budget.
 *
 *   node scripts/module-boundary.mjs            the gate
 *   node scripts/module-boundary.mjs --list     every counted edge and lookup, by module, as file:line
 *   node scripts/module-boundary.mjs --update   lower each budget to the measurement, drop the zeros
 *
 * `--update` never raises a budget; without a budget file it writes the measurement (the seed).
 * Raising a budget is a deliberate edit that belongs in a commit message with a reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { createRoots } from './lib/roots.mjs';
import { isColocated, loadModuleMap, requiresCycle } from './module-map.mjs';
import { CODE_FILE, TYPE_FILE, maskSource, resolveSpecifier } from './module-map-edges.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUDGET_REL = 'server/.module-boundary-ratchet.json';
const PKG = 'server';
/** The budgeted sections of the budget file, and how a line about them reads. */
export const SECTIONS = Object.freeze({
    coreEdges: 'core -> module import edges',
    coreLookups: 'core featureModule() lookups of module files',
});

/** @typedef {{ from: string, to: string, line: number, owner: string }} Hit  owner: the module the target belongs to */
/** @typedef {{ coreEdges: Record<string, Hit[]>, coreLookups: Record<string, Hit[]>, undeclared: string[], cycle: string[] | null, location: string[] }} Analysis */
/** @typedef {{ coreEdges?: Record<string, number>, coreLookups?: Record<string, number> }} Budget */

/**
 * @param {Hit[]} hits
 * @returns {Record<string, Hit[]>} by owner, owners sorted
 */
function byOwner(hits) {
    /** @type {Record<string, Hit[]>} */
    const out = {};
    for (const h of [...hits].sort((a, b) => a.owner.localeCompare(b.owner) || a.from.localeCompare(b.from) || a.line - b.line)) (out[h.owner] ??= []).push(h);
    return out;
}

/**
 * The literal `featureModule('<name>')` calls of one source (not optionalFeatureModule, not in a comment).
 * @param {string} src
 * @returns {{ name: string, line: number }[]}
 */
export function scanLookups(src) {
    if (!src.includes('featureModule')) return [];
    const { code, strings } = maskSource(src);
    const out = [];
    for (const m of code.matchAll(/(?<![\w$])featureModule\s*\(\s*['"]/g)) {
        const lit = strings.get(m.index + m[0].length - 1);
        if (!lit || !/^\s*\)/.test(code.slice(lit.end))) continue;
        out.push({ name: lit.value, line: src.slice(0, m.index).split('\n').length });
    }
    return out;
}

/**
 * Rule 2: the lookups from core-owned files into module-owned files.
 * @param {{ treePath: string, abs: string, owner: string | null }[]} files the package's files, with owners
 * @returns {Hit[]}
 */
export function coreLookups(files) {
    const paths = new Set(files.map((f) => f.treePath));
    const ownerByPath = new Map(files.map((f) => [f.treePath, f.owner]));
    const hits = [];
    for (const f of files) {
        if (f.owner !== null || isColocated(f.treePath) || !CODE_FILE.test(f.treePath) || TYPE_FILE.test(f.treePath)) continue;
        let src;
        try { src = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
        for (const { name, line } of scanLookups(src)) {
            const to = resolveSpecifier('index.js', `./${name}`, paths);
            const owner = to ? ownerByPath.get(to) : null;
            if (owner) hits.push({ from: f.treePath, to, line, owner });
        }
    }
    return hits;
}

/**
 * Rule 3: module -> module edges whose target module is in neither `requires` nor `uses`.
 * @param {{ from: string, to: string, line: number, fromOwner: string | null, toOwner: string | null }[]} edges
 * @param {Record<string, { requires?: string[], uses?: string[] }>} modules
 * @returns {string[]}
 */
export function undeclaredEdges(edges, modules) {
    const out = [];
    for (const e of edges) {
        if (e.fromOwner === null || e.toOwner === null || e.fromOwner === e.toOwner) continue;
        const mod = modules[e.fromOwner] || {};
        if ((mod.requires || []).includes(e.toOwner) || (mod.uses || []).includes(e.toOwner)) continue;
        out.push(`${e.from}:${e.line} -> ${e.to}  (${e.fromOwner} -> ${e.toOwner}: add "${e.toOwner}" to ${e.fromOwner}.requires or .uses in scripts/module-map.json, or cut the import)`);
    }
    return out;
}

/**
 * Rule 4: files on the wrong side of a module directory that exists.
 * @param {{ treePath: string, root: string | null, mapped: string | null }[]} files
 * @param {Set<string>} withRoot the ids that have a modules/<id>/server
 * @returns {string[]}
 */
export function locationProblems(files, withRoot) {
    const out = [];
    for (const f of files) {
        if (f.root === null && f.mapped !== null && withRoot.has(f.mapped)) {
            out.push(`server/${f.treePath}: owned by ${f.mapped}, which has modules/${f.mapped}/server; move it there (git mv, same tree path)`);
        } else if (f.root !== null && f.mapped !== f.root) {
            out.push(`modules/${f.root}/server/${f.treePath}: the map gives it to ${f.mapped ?? 'core'}; move it back or change the globs`);
        }
    }
    return out;
}

/**
 * Measure all four rules over one checkout.
 * @param {string} [repoRoot]
 * @returns {Analysis}
 */
export function analyze(repoRoot = DEFAULT_ROOT) {
    const map = loadModuleMap(repoRoot);
    const files = map.files(PKG);
    const edges = map.edges(PKG);
    const toCore = edges.filter((e) => e.fromOwner === null && e.toOwner !== null).map((e) => ({ from: e.from, to: e.to, line: e.line, owner: /** @type {string} */ (e.toOwner) }));
    const withRoot = new Set(createRoots({ repoRoot }).rootsOf(PKG).map((r) => r.id).filter((id) => id !== null));
    return {
        coreEdges: byOwner(toCore),
        coreLookups: byOwner(coreLookups(files)),
        undeclared: undeclaredEdges(edges, map.raw.modules || {}),
        cycle: requiresCycle(map.raw.modules || {}),
        location: locationProblems(files, withRoot),
    };
}

/**
 * @param {Analysis} analysis
 * @returns {{ coreEdges: Record<string, number>, coreLookups: Record<string, number> }} the counts, zeros left out
 */
export function counts(analysis) {
    const out = { coreEdges: {}, coreLookups: {} };
    for (const section of Object.keys(SECTIONS)) {
        for (const [id, hits] of Object.entries(analysis[section])) if (hits.length) out[section][id] = hits.length;
    }
    return out;
}

/**
 * The budget --update writes: per module the lower of budget and measurement, zeros dropped.
 * With no budget yet, the measurement.
 * @param {Budget | null} existing
 * @param {ReturnType<typeof counts>} measured
 */
export function nextBudget(existing, measured) {
    const out = {
        _comment: `Highest number of ${SECTIONS.coreEdges} (coreEdges) and ${SECTIONS.coreLookups} (coreLookups) per module that server/ may still carry; a module not listed has budget 0. Lower it with \`node scripts/module-boundary.mjs --update\` after cutting a dependency; raising one is a deliberate edit that belongs in a commit message with a reason.`,
        _generated: new Date().toISOString().slice(0, 10),
        coreEdges: {},
        coreLookups: {},
    };
    for (const section of Object.keys(SECTIONS)) {
        const ids = new Set([...Object.keys(existing?.[section] || {}), ...Object.keys(measured[section])]);
        for (const id of [...ids].sort()) {
            const now = measured[section][id] || 0;
            const n = existing ? Math.min(now, existing[section]?.[id] ?? 0) : now;
            if (n > 0) out[section][id] = n;
        }
    }
    return out;
}

const sum = (record) => Object.values(record).reduce((s, n) => s + n, 0);
const hitLine = (h) => `    ${h.from}:${h.line} -> ${h.to}`;

/**
 * The failures of the budgeted rules, each with every hit of that module.
 * @param {Analysis} analysis
 * @param {Budget} budget
 * @returns {string[]}
 */
export function overBudget(analysis, budget) {
    const out = [];
    for (const [section, what] of Object.entries(SECTIONS)) {
        for (const [id, hits] of Object.entries(analysis[section])) {
            const allowed = budget[section]?.[id] ?? 0;
            if (hits.length <= allowed) continue;
            out.push(`${PKG}: ${hits.length} ${what} into ${id}, budget is ${allowed} (${hits.length - allowed} over). The budget is a number, so these are all of them; the new one is among them:`, ...hits.map(hitLine));
        }
    }
    return out;
}

/** @param {Analysis} analysis */
function printList(analysis) {
    for (const [section, what] of Object.entries(SECTIONS)) {
        for (const [id, hits] of Object.entries(analysis[section])) {
            console.log(`${id}: ${hits.length} ${what}`);
            for (const h of hits) console.log(hitLine(h));
        }
    }
    for (const line of analysis.undeclared) console.log(`undeclared: ${line}`);
    for (const line of analysis.location) console.log(`location: ${line}`);
    console.log('');
}

/**
 * @param {string} file
 * @returns {Budget | null}
 */
function readBudget(file) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * @param {Analysis} analysis
 * @param {Budget} budget
 * @returns {number} the exit code
 */
function report(analysis, budget) {
    const failures = [...overBudget(analysis, budget)];
    if (analysis.undeclared.length) failures.push(`${PKG}: ${analysis.undeclared.length} module -> module import edge(s) not declared in scripts/module-map.json:`, ...analysis.undeclared.map((l) => `    ${l}`));
    if (analysis.cycle) failures.push(`scripts/module-map.json: requires has a cycle: ${analysis.cycle.join(' -> ')}`);
    if (analysis.location.length) failures.push(`${PKG}: ${analysis.location.length} file(s) on the wrong side of a module directory:`, ...analysis.location.map((l) => `    ${l}`));
    const measured = counts(analysis);
    if (failures.length) {
        console.error(`❌ ${PKG}: ${sum(measured.coreEdges)} ${SECTIONS.coreEdges}, ${sum(measured.coreLookups)} lookups, module boundary broken. Cut the dependency (an optional lookup, a port, or move the piece) rather than raising a budget (\`--list\` shows them all):`);
        for (const line of failures) console.error(line);
        return 1;
    }
    for (const [section, what] of Object.entries(SECTIONS)) {
        const now = sum(measured[section]);
        const allowed = sum(budget[section] || {});
        if (now < allowed) console.log(`✅ ${PKG}: ${now} ${what}, under the budget of ${allowed}. Run \`node scripts/module-boundary.mjs --update\` to lower it.`);
        else console.log(`➖ ${PKG}: ${now} ${what}, at budget`);
    }
    return 0;
}

/**
 * @param {string[]} argv
 * @param {{ repoRoot?: string }} [opts]
 * @returns {number} the exit code
 */
export function main(argv, { repoRoot = DEFAULT_ROOT } = {}) {
    const analysis = analyze(repoRoot);
    const file = path.join(repoRoot, BUDGET_REL);
    const existing = readBudget(file);
    if (argv.includes('--list')) {
        printList(analysis);
        if (!argv.includes('--update') && !existing) return 0;
    }
    if (argv.includes('--update') || !existing) {
        const next = nextBudget(existing, counts(analysis));
        fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${BUDGET_REL}: ${sum(next.coreEdges)} ${SECTIONS.coreEdges}, ${sum(next.coreLookups)} lookups`);
        return 0;
    }
    return report(analysis, existing);
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
