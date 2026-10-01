#!/usr/bin/env node
/**
 * gen-shared-mirror — copy the isomorphic shared modules from the server to
 * the clients, byte for byte.
 *
 *   node scripts/gen-shared-mirror.mjs           # (re)write every mirror
 *   node scripts/gen-shared-mirror.mjs --check   # exit 1 if any differs; writes nothing
 *
 * Sources live under server/shared/ — the canonical copies; the server loads
 * them through CommonJS facades (automation/expr.js, automation/bind.js).
 * The clients cannot import them from there: the agent-hub image builds with
 * context ./agent-hub and cannot see server/, and Metro cannot import from
 * outside mobile/. So each client gets its own in-tree copy, listed in
 * MIRRORS below:
 *   - server/shared/expr    → agent-hub/src/shared/expr (App Studio and the
 *                             builder, through the `@shared` alias in
 *                             agent-hub/vite.config.js)
 *   - server/shared/expr    → mobile/src/shared/expr/vendor (the flow editor;
 *                             without the corpus, which the phone reads from
 *                             agent-hub, and beside mobile's own index.d.mts)
 *   - server/shared/mapping → agent-hub/src/shared/mapping (binding previews)
 *   - server/shared/mapping → mobile/src/shared/mapping/vendor
 *
 * A mirror is every file under its source directory except tests
 * (*.test.*, *.spec.*) and the names in its `exclude`. Tests are outside the
 * mirror on BOTH sides: a server test is never copied, and a test in a mirror
 * directory is never reported as extra or removed; neither is a name in the
 * mirror's `keep` (a file the client owns there). Write mode removes any other
 * file in the mirror that the source no longer has, so a rename on the server
 * leaves no stale copy.
 *
 * The copies used to be "kept byte-identical" by hand. Edits landed on the
 * server copy only, and the vitest sync test
 * (agent-hub/src/components/admin/Studio/AppStudio/state/sharedExpr.sync.test.js)
 * failed a quarter of an hour into CI. That test, and mobile's
 * exprVendor.lockstep.test.ts and mappingVendor.lockstep.test.ts, stay as
 * the CI backstops; this script's --check is `npm run lint:shared-mirror`,
 * which `npm run check:fast` runs in seconds, and the first step of ci.yml's
 * Frontend checks job. The mirrors are also in the ignore list of .jscpd.json
 * (mobile's under its vendor/ rule): they are generated, not duplication
 * anyone writes.
 *
 * Zero dependencies: node:* only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every generated copy: `source` and `target` are repo-relative directories.
 * `exclude`: source files this mirror leaves out. `keep`: files in the target
 * that the client owns, never reported as extra and never removed.
 */
export const MIRRORS = [
    { source: 'server/shared/expr', target: 'agent-hub/src/shared/expr' },
    { source: 'server/shared/expr', target: 'mobile/src/shared/expr/vendor', exclude: ['corpus.mjs'], keep: ['index.d.mts'] },
    { source: 'server/shared/mapping', target: 'agent-hub/src/shared/mapping' },
    { source: 'server/shared/mapping', target: 'mobile/src/shared/mapping/vendor' },
];

/** Test files stay where they are: never copied, never counted as extra. */
export function isTest(name) {
    return /\.(test|spec)\.[^.]+$/.test(name);
}

/** The non-test files under `dir`, as sorted '/'-separated relative paths. */
export function listMirrorFiles(dir, rel = '') {
    const here = path.join(dir, rel);
    if (!fs.existsSync(here)) return [];
    const out = [];
    for (const entry of fs.readdirSync(here, { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listMirrorFiles(dir, child));
        else if (entry.isFile() && !isTest(entry.name)) out.push(child);
    }
    return out.sort();
}

/** 1-based line of the first byte where two buffers part ways. */
function firstDifferentLine(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    let line = 1;
    for (let j = 0; j < i; j++) if (a[j] === 0x0a) line++;
    return line;
}

/**
 * Compare the mirror with its source. `differ` holds { file, line } for each
 * file whose bytes differ; `missing` the source files the mirror lacks;
 * `extra` the mirror's non-test files the source does not have. Names in
 * `exclude` are not part of the mirror; names in `keep` are the mirror's own.
 */
export function compareTrees(sourceDir, targetDir, { exclude = [], keep = [] } = {}) {
    const want = listMirrorFiles(sourceDir).filter((file) => !exclude.includes(file));
    const have = new Set(listMirrorFiles(targetDir).filter((file) => !keep.includes(file)));
    const differ = [];
    const missing = [];
    for (const file of want) {
        if (!have.has(file)) {
            missing.push(file);
            continue;
        }
        const a = fs.readFileSync(path.join(sourceDir, file));
        const b = fs.readFileSync(path.join(targetDir, file));
        if (!a.equals(b)) differ.push({ file, line: firstDifferentLine(a, b) });
    }
    const wanted = new Set(want);
    const extra = [...have].filter((file) => !wanted.has(file));
    return { files: want, differ, missing, extra };
}

const plural = (n) => `${n} file${n === 1 ? '' : 's'}`;

/** --check for one mirror: true when clean; names every difference on stderr. */
function checkMirror({ source, target }, { files, differ, missing, extra }) {
    if (differ.length === 0 && missing.length === 0 && extra.length === 0) {
        console.log(`gen-shared-mirror: ${target}/ matches ${source}/ (${plural(files.length)}).`);
        return true;
    }
    console.error(`gen-shared-mirror: ${target}/ is out of date with ${source}/:`);
    for (const { file, line } of differ) console.error(`  differs: ${target}/${file} (first difference at line ${line})`);
    for (const file of missing) console.error(`  missing: ${target}/${file}`);
    for (const file of extra) console.error(`  extra:   ${target}/${file} (not in ${source}/)`);
    return false;
}

/** Write mode for one mirror: copy what is missing or differs, remove what is extra. */
function writeMirror({ source, target }, sourceDir, targetDir, { files, differ, missing, extra }) {
    if (differ.length === 0 && missing.length === 0 && extra.length === 0) {
        console.log(`gen-shared-mirror: ${target}/ already up to date (${plural(files.length)}).`);
        return;
    }
    for (const file of [...missing, ...differ.map((d) => d.file)].sort()) {
        const to = path.join(targetDir, file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, fs.readFileSync(path.join(sourceDir, file)));
        console.log(`gen-shared-mirror: wrote ${target}/${file}`);
    }
    for (const file of extra) {
        fs.rmSync(path.join(targetDir, file));
        console.log(`gen-shared-mirror: removed ${target}/${file} (not in ${source}/)`);
    }
    console.log(`gen-shared-mirror: ${target}/ now matches ${source}/ (${plural(files.length)}).`);
}

function main() {
    const check = process.argv.includes('--check');
    // Every source is checked for files before anything is written, so a
    // wrong root fails without touching a single mirror.
    const plans = MIRRORS.map((mirror) => {
        const sourceDir = path.join(ROOT, mirror.source);
        const targetDir = path.join(ROOT, mirror.target);
        const result = compareTrees(sourceDir, targetDir, mirror);
        if (result.files.length === 0) throw new Error(`${mirror.source}/ has no files to mirror — is this the repo root?`);
        return { mirror, sourceDir, targetDir, result };
    });

    if (check) {
        let clean = true;
        for (const { mirror, result } of plans) clean = checkMirror(mirror, result) && clean;
        if (clean) return 0;
        console.error('These are generated copies — do not edit them by hand. Change server/shared/,\n'
            + 'then run `npm run gen:shared` (node scripts/gen-shared-mirror.mjs) and commit both.');
        return 1;
    }

    for (const { mirror, sourceDir, targetDir, result } of plans) writeMirror(mirror, sourceDir, targetDir, result);
    return 0;
}

// Run as a command, not imported by a test (see entry-point.mjs).
if (isEntryPoint(import.meta.url)) {
    try {
        process.exitCode = main();
    } catch (e) {
        console.error(`gen-shared-mirror: ${e.message}`);
        process.exitCode = 1;
    }
}
