#!/usr/bin/env node
/**
 * Version drift ratchet — the same dependency on different majors in two npm packages.
 *
 * This monorepo has a dozen npm packages and no shared resolver, so a library
 * ends up on one major in the server and another in a satellite (eslint 10
 * next to 9, typescript 6 next to 5, nodemailer 10 next to 6). Most of it is
 * deliberate and held back by a reason in .github/dependabot.yml, and none of
 * it is a problem on its own. What this gate stops is the number growing by
 * accident: a new package, or a bump in one package, that opens a gap with the
 * others nobody decided on.
 *
 *   count   dependencies (dependencies, devDependencies, optionalDependencies)
 *           that appear in 2+ npm packages of scripts/packages.json with
 *           different MAJOR versions. The major is the one of the declared
 *           range (^13.6.3, ~5.9.2, 4.0.12, >=2 <4 all read as a number); a
 *           spec that names no version (npm:, file:, git, workspace:, *,
 *           latest) is not compared. A name with three majors counts once.
 *   budget  .version-drift-ratchet.json at the repo root, the contract of
 *           scripts/count-ratchet.mjs: the check fails when the count goes up,
 *           `--update` only ever lowers the budget, a missing file is written
 *           from the first measurement.
 *   lockstep  groups of dependencies that must be IDENTICAL between two
 *           packages, whatever the budget says: the editor's collaboration code
 *           is bundled from agent-hub into the server (server/package.json
 *           build:editor-collab) and both must run the same yjs, y-protocols
 *           and lib0. Playwright has its own lockstep check
 *           (scripts/check-playwright-lockstep.mjs) and is not listed here.
 *
 * Node base images in the Dockerfiles are deliberately not compared: they move
 * by digest only (.github/dependabot.yml, the base-images entry).
 *
 * Usage:
 *   node scripts/check-version-drift.mjs            gate
 *   node scripts/check-version-drift.mjs --update   lower the budget
 *   node scripts/check-version-drift.mjs --list     the drifting dependencies and who is on what
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** Dependencies that must be declared identically in each of these packages. */
export const LOCKSTEP = [
    { names: ['yjs', 'y-protocols', 'lib0'], dirs: ['server', 'agent-hub'], why: 'the editor collaboration code is bundled from agent-hub into the server' },
];

const ALT = /^[\^~>=v\s]*(\d+)(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:[-+][\w.+-]+)?(?:\s|$)/;

/** The major of a declared range, or null when the spec names no version. */
export function majorOf(range) {
    if (typeof range !== 'string') return null;
    const majors = [];
    for (const alt of range.split('||')) {
        const m = ALT.exec(alt.trim());
        if (m) majors.push(Number(m[1]));
    }
    return majors.length ? Math.max(...majors) : null;
}

/** `{ name -> { dir -> range } }` over the given `[{ dir, json }]`. */
export function declared(packages) {
    const out = {};
    for (const { dir, json } of packages) {
        for (const section of SECTIONS) {
            for (const [name, range] of Object.entries(json[section] || {})) {
                (out[name] ??= {})[dir] ??= range;
            }
        }
    }
    return out;
}

/** The dependencies on 2+ majors: `[{ name, majors: Map<major, dirs[]> }]`, by name. */
export function drifting(decl) {
    const rows = [];
    for (const [name, byDir] of Object.entries(decl)) {
        const majors = new Map();
        for (const [dir, range] of Object.entries(byDir)) {
            const major = majorOf(range);
            if (major === null) continue;
            if (!majors.has(major)) majors.set(major, []);
            majors.get(major).push(dir);
        }
        if (majors.size >= 2) rows.push({ name, majors });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Lockstep violations, as strings. */
export function lockstepViolations(decl, groups = LOCKSTEP) {
    const out = [];
    for (const { names, dirs, why } of groups) {
        for (const name of names) {
            const ranges = dirs.map((d) => decl[name]?.[d]);
            const missing = dirs.filter((d, i) => ranges[i] === undefined);
            if (missing.length) {
                out.push(`${name} is not declared in ${missing.join(', ')}, but ${dirs.join(' and ')} must carry it identically (${why})`);
            } else if (new Set(ranges).size > 1) {
                out.push(`${name} differs: ${dirs.map((d, i) => `${d} ${ranges[i]}`).join(' vs ')}; bump both in one change (${why})`);
            }
        }
    }
    return out;
}

const describe = (row) => `${row.name}: ${[...row.majors].map(([m, dirs]) => `${m} in ${dirs.join(', ')}`).join('; ')}`;

export function main(argv = process.argv.slice(2), root = ROOT) {
    const update = argv.includes('--update');
    const list = argv.includes('--list');
    const budgetFile = path.join(root, '.version-drift-ratchet.json');
    let packages;
    try {
        const registry = JSON.parse(fs.readFileSync(path.join(root, 'scripts/packages.json'), 'utf8'));
        packages = registry.packages
            .filter((p) => p.ecosystem === 'npm')
            .map((p) => ({ dir: p.dir, json: JSON.parse(fs.readFileSync(path.join(root, p.dir, 'package.json'), 'utf8')) }));
    } catch (e) {
        console.error(`version-drift: ${e.message} (npm run lint:package-registry says what is out of line)`);
        return 2;
    }

    const decl = declared(packages);
    const rows = drifting(decl);
    const count = rows.length;
    const lockstep = lockstepViolations(decl);

    if (list) {
        for (const row of rows) console.log(describe(row));
        console.log('');
    }
    for (const v of lockstep) console.error(`❌ lockstep: ${v}`);

    const what = 'dependencies on different majors in 2+ npm packages';
    const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;
    if (update || !existing) {
        const next = {
            _comment: `Highest number of ${what} that scripts/packages.json may still carry. Lower it with \`node scripts/check-version-drift.mjs --update\` after aligning a dependency; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            count: existing ? Math.min(count, existing.count) : count,
        };
        fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${path.relative(root, budgetFile)}: ${next.count} ${what} (measured ${count})`);
        return lockstep.length ? 1 : 0;
    }

    if (count > existing.count) {
        console.error(
            `❌ ${count} ${what}, budget is ${existing.count}: align the new gap, or give it a reason in .github/dependabot.yml, rather than raising the budget (\`--list\` shows who is on what)`,
        );
        return 1;
    }
    if (count < existing.count) {
        console.log(`✅ ${count} ${what}, under the budget of ${existing.count}. Run \`node scripts/check-version-drift.mjs --update\` to lower it.`);
    } else {
        console.log(`➖ ${count} ${what}, at budget`);
    }
    return lockstep.length ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) process.exit(main());
