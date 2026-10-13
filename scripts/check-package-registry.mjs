#!/usr/bin/env node
/**
 * Every package directory is in scripts/packages.json, and has a Dependabot entry.
 *
 * Dependabot only updates what .github/dependabot.yml names, and a new package
 * (a component, a satellite, a sidecar) is easy to add without touching it:
 * hub-module-sdk, server/pwt-runner, e2e and eight components/* had no entry
 * for months, so nothing raised a PR for their dependencies. scripts/packages.json
 * is the list a person has to edit when a package appears; this check is what
 * makes them. It asserts, parse-only (nothing is installed, nothing fetched):
 *
 *   P1  every directory with a package.json or a requirements*.txt in git is in
 *       the registry, with the ecosystem it is built with (npm | pip), and every
 *       registry entry still has such a file
 *   P2  the registry entry is well formed: a known role, a lockfile type that
 *       matches what is in git (npm = package-lock.json, pip = requirements.txt,
 *       none = neither), no duplicates
 *   P3  a package with `dependabot: weekly|monthly` is covered by a Dependabot
 *       entry of the same ecosystem, on that interval, with a `groups:` block
 *       (ungrouped, one PR per dependency is how alerts end up ignored)
 *   P4  a package with `dependabot: none` has a reason and is NOT covered (a
 *       registry that says "none" for a package that has an entry is stale)
 *   P5  every npm/pip Dependabot entry directory matches a registry package (an
 *       entry for a directory that no longer exists would silently do nothing)
 *
 * The docker and github-actions entries are not packages and are not read.
 *
 * .github/dependabot.yml is read by a narrow line scanner, not a YAML parser:
 * no YAML package exists in this monorepo and none is to be added (the same
 * stance as check-required-checks.mjs). Entries are `  - package-ecosystem:`
 * at two spaces, their keys at four; `directory`, `directories` (inline list or
 * block list; `*` matches one path segment), `schedule` (inline or block) and
 * `groups` are read. Anything the scanner cannot classify is a failure.
 *
 * Usage: node scripts/check-package-registry.mjs   (npm run lint:package-registry)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ECOSYSTEMS = ['npm', 'pip'];
export const LOCKFILES = ['npm', 'pip', 'none'];
export const CADENCES = ['weekly', 'monthly', 'none'];

/** A dependabot.yml the scanner refuses to guess about. */
export class Unparseable extends Error {}

const normDir = (d) => {
    const s = String(d).replace(/^\/+|\/+$/g, '');
    return s === '' ? '.' : s;
};

/** `{ dir -> Set<ecosystem> }` for the manifests in a list of repo-relative paths. */
export function manifestDirs(files) {
    const dirs = new Map();
    for (const file of files) {
        const parts = file.split('/');
        if (parts.includes('node_modules')) continue;
        const base = parts[parts.length - 1];
        const eco = base === 'package.json' ? 'npm' : /^requirements[^/]*\.txt$/.test(base) ? 'pip' : null;
        if (!eco) continue;
        const dir = parts.length === 1 ? '.' : parts.slice(0, -1).join('/');
        if (!dirs.has(dir)) dirs.set(dir, new Set());
        dirs.get(dir).add(eco);
    }
    return dirs;
}

const stripComment = (s) => s.replace(/\s+#.*$/, '').trim();
const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');

function inlineList(value, where) {
    const m = /^\[(.*)\]$/.exec(value);
    if (!m) throw new Unparseable(`${where}: expected an inline list, got "${value}"`);
    return m[1]
        .split(',')
        .map((x) => unquote(x.trim()))
        .filter(Boolean);
}

/** The updates of a dependabot.yml: `[{ ecosystem, directories, interval, hasGroups }]`. */
export function parseDependabot(text) {
    const entries = [];
    let cur = null;
    let listKey = null;
    let inSchedule = false;
    let inUpdates = false;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const where = `dependabot.yml:${i + 1}`;
        if (/\t/.test(raw)) throw new Unparseable(`${where}: tab character`);
        if (/^\s*(#.*)?$/.test(raw)) continue;
        if (/^updates:\s*$/.test(raw)) {
            inUpdates = true;
            continue;
        }
        if (/^\S/.test(raw)) {
            inUpdates = false;
            cur = null;
            continue;
        }
        if (!inUpdates) continue;

        const start = /^ {2}- package-ecosystem:\s*(.+)$/.exec(raw);
        if (start) {
            cur = { ecosystem: unquote(stripComment(start[1])), directories: [], interval: null, hasGroups: false };
            entries.push(cur);
            listKey = null;
            inSchedule = false;
            continue;
        }
        if (!cur) throw new Unparseable(`${where}: content before the first "- package-ecosystem:"`);

        const key = /^ {4}([A-Za-z-]+):\s*(.*)$/.exec(raw);
        if (key) {
            const [, name, rest] = key;
            const value = stripComment(rest);
            listKey = null;
            inSchedule = false;
            if (name === 'directory') {
                cur.directories.push(unquote(value));
            } else if (name === 'directories') {
                if (value) cur.directories.push(...inlineList(value, where));
                else listKey = 'directories';
            } else if (name === 'schedule') {
                const m = /interval:\s*([A-Za-z]+)/.exec(value);
                if (value) {
                    if (!m) throw new Unparseable(`${where}: schedule without an interval`);
                    cur.interval = m[1];
                } else inSchedule = true;
            } else if (name === 'groups') {
                cur.hasGroups = true;
            }
            continue;
        }
        const item = /^ {6}- (.+)$/.exec(raw);
        if (item && listKey === 'directories') {
            cur.directories.push(unquote(stripComment(item[1])));
            continue;
        }
        const nested = /^ {6}interval:\s*([A-Za-z]+)/.exec(raw);
        if (nested && inSchedule) {
            cur.interval = nested[1];
            continue;
        }
        // Deeper lines belong to a key we do not read (ignore, groups, labels...).
    }
    for (const e of entries) {
        if (!e.ecosystem) throw new Unparseable('dependabot.yml: an update without a package-ecosystem');
        if (e.directories.length === 0) throw new Unparseable(`dependabot.yml: a ${e.ecosystem} update without directory/directories`);
        if (!e.interval) throw new Unparseable(`dependabot.yml: a ${e.ecosystem} update on ${e.directories.join(', ')} without a schedule interval`);
    }
    return entries;
}

/** Does a Dependabot directory (`/a`, `/a/*`) cover a registry dir? `*` is one segment. */
export function covers(pattern, dir) {
    const p = normDir(pattern).split('/');
    const d = dir.split('/');
    if (p.length !== d.length) return false;
    return p.every((seg, i) => (seg === '*' ? d[i] !== '' : seg === d[i]));
}

const where = (p) => `${p.dir} (${p.ecosystem})`;

/**
 * Every violation, as strings. `files` is the list of repo-relative paths in
 * git; `registry` the parsed packages.json; `entries` the parsed dependabot.yml.
 */
export function check({ files, registry, entries }) {
    const out = [];
    const packages = Array.isArray(registry?.packages) ? registry.packages : null;
    if (!packages) return ['scripts/packages.json: no "packages" array'];
    const roles = Object.keys(registry.roles || {});
    const fileSet = new Set(files);

    const seen = new Set();
    for (const p of packages) {
        const id = `${p.dir}\0${p.ecosystem}`;
        if (typeof p.dir !== 'string' || !p.dir) {
            out.push(`packages.json: an entry without a dir: ${JSON.stringify(p)}`);
            continue;
        }
        if (seen.has(id)) out.push(`packages.json: ${where(p)} is listed twice`);
        seen.add(id);
        if (!ECOSYSTEMS.includes(p.ecosystem)) out.push(`packages.json: ${p.dir} has ecosystem "${p.ecosystem}", expected ${ECOSYSTEMS.join(' | ')}`);
        if (!roles.includes(p.role)) out.push(`packages.json: ${where(p)} has role "${p.role}", expected one of ${roles.join(', ')}`);
        if (!LOCKFILES.includes(p.lockfile)) out.push(`packages.json: ${where(p)} has lockfile "${p.lockfile}", expected ${LOCKFILES.join(' | ')}`);
        if (!CADENCES.includes(p.dependabot)) out.push(`packages.json: ${where(p)} has dependabot "${p.dependabot}", expected ${CADENCES.join(' | ')}`);
    }

    // P1: registry <-> tree
    const dirs = manifestDirs(files);
    for (const [dir, ecos] of dirs) {
        for (const eco of ecos) {
            if (!seen.has(`${dir}\0${eco}`)) out.push(`${dir} has a ${eco} manifest in git but is not in scripts/packages.json: add it (role, lockfile, dependabot)`);
        }
    }
    for (const p of packages) {
        if (ECOSYSTEMS.includes(p.ecosystem) && !dirs.get(p.dir)?.has(p.ecosystem)) {
            out.push(`scripts/packages.json lists ${where(p)} but git has no ${p.ecosystem === 'npm' ? 'package.json' : 'requirements*.txt'} there: remove the entry`);
        }
    }

    // P2: lockfile type
    for (const p of packages) {
        if (!ECOSYSTEMS.includes(p.ecosystem) || !LOCKFILES.includes(p.lockfile)) continue;
        const prefix = p.dir === '.' ? '' : `${p.dir}/`;
        const hasLock = p.ecosystem === 'npm' ? fileSet.has(`${prefix}package-lock.json`) : fileSet.has(`${prefix}requirements.txt`);
        const file = p.ecosystem === 'npm' ? 'package-lock.json' : 'requirements.txt';
        const actual = hasLock ? p.ecosystem : 'none';
        if (p.lockfile !== actual) out.push(`${where(p)}: registry says lockfile "${p.lockfile}" but ${file} is ${hasLock ? '' : 'not '}in git (it is "${actual}")`);
    }

    // P3/P4: Dependabot coverage
    const updates = entries.filter((e) => ECOSYSTEMS.includes(e.ecosystem));
    for (const p of packages) {
        if (!ECOSYSTEMS.includes(p.ecosystem) || !CADENCES.includes(p.dependabot)) continue;
        const cover = updates.filter((e) => e.ecosystem === p.ecosystem && e.directories.some((d) => covers(d, p.dir)));
        if (p.dependabot === 'none') {
            if (!p.reason || !String(p.reason).trim()) out.push(`${where(p)}: dependabot "none" needs a "reason"`);
            if (cover.length) out.push(`${where(p)}: registry says dependabot "none" but .github/dependabot.yml has an entry for it: set its cadence`);
            continue;
        }
        if (cover.length === 0) {
            out.push(`${where(p)} has no ${p.ecosystem} entry in .github/dependabot.yml: add one on "${p.dependabot}" (grouped), or set dependabot "none" with a reason`);
        } else if (cover.length > 1) {
            out.push(`${where(p)} is covered by ${cover.length} ${p.ecosystem} entries in .github/dependabot.yml: Dependabot would open duplicate PRs`);
        } else {
            const [e] = cover;
            if (e.interval !== p.dependabot) out.push(`${where(p)}: registry says ${p.dependabot} but .github/dependabot.yml schedules it ${e.interval}`);
            if (!e.hasGroups) out.push(`${where(p)}: its .github/dependabot.yml entry has no groups: block (one PR per dependency)`);
        }
    }

    // P5: Dependabot -> registry
    for (const e of updates) {
        for (const d of e.directories) {
            if (!packages.some((p) => p.ecosystem === e.ecosystem && covers(d, p.dir))) {
                out.push(`.github/dependabot.yml has a ${e.ecosystem} entry for "${d}" that matches no package in scripts/packages.json: remove it or register the package`);
            }
        }
    }
    return out;
}

/** Tracked files, plus untracked ones git does not ignore, minus deleted ones. */
export function gitFiles(root = ROOT) {
    const res = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) throw new Error(`git ls-files failed: ${res.stderr || res.error}`);
    return res.stdout.split('\n').filter((f) => f && fs.existsSync(path.join(root, f)));
}

export function main(root = ROOT) {
    let violations;
    try {
        const registry = JSON.parse(fs.readFileSync(path.join(root, 'scripts/packages.json'), 'utf8'));
        const entries = parseDependabot(fs.readFileSync(path.join(root, '.github/dependabot.yml'), 'utf8'));
        const files = gitFiles(root);
        violations = check({ files, registry, entries });
        if (violations.length === 0) {
            console.log(`package-registry: ${registry.packages.length} packages, all registered, all with a Dependabot entry or a reason`);
            return 0;
        }
    } catch (e) {
        console.error(`package-registry: ${e.message}`);
        return 2;
    }
    for (const v of violations) console.error(`❌ ${v}`);
    console.error(`package-registry: ${violations.length} problem(s). scripts/packages.json and .github/dependabot.yml have to agree with the tree.`);
    return 1;
}

if (isEntryPoint(import.meta.url)) process.exit(main());
