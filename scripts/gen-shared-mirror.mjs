#!/usr/bin/env node
/**
 * gen-shared-mirror — copy the isomorphic expression engine from the server
 * to agent-hub, byte for byte.
 *
 *   node scripts/gen-shared-mirror.mjs           # (re)write the mirror
 *   node scripts/gen-shared-mirror.mjs --check   # exit 1 if it differs; writes nothing
 *
 * Source: server/shared/expr/ — the canonical copy; the automation runtime
 *         loads it through server/automation/expr.js.
 * Output: agent-hub/src/shared/expr/ — the same files for App Studio, through
 *         the `@shared` alias in agent-hub/vite.config.js. The agent-hub image
 *         builds with context ./agent-hub and cannot see server/, so the
 *         client needs its own in-tree copy.
 *
 * The mirror is every file under the source directory except tests
 * (*.test.*, *.spec.*): today corpus.mjs, engine.mjs, functions.mjs and
 * index.mjs. Tests are outside the mirror on BOTH sides: a server test is
 * never copied, and a test in the agent-hub directory is never reported as
 * extra or removed. Write mode removes any other file in the mirror that the
 * source no longer has, so a rename on the server leaves no stale copy.
 *
 * The two used to be "kept byte-identical" by hand. Edits landed on the
 * server copy only, and the vitest sync test
 * (agent-hub/src/components/admin/Studio/AppStudio/state/sharedExpr.sync.test.js)
 * failed a quarter of an hour into CI. That test stays as the CI backstop;
 * this script's --check is `npm run lint:shared-mirror`, which
 * `npm run check:fast` runs in seconds, and the first step of ci.yml's
 * Frontend checks job. The mirror is also in the ignore list
 * of .jscpd.json: it is generated, not duplication anyone writes.
 *
 * Zero dependencies: node:* only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REL_SOURCE = 'server/shared/expr';
const REL_TARGET = 'agent-hub/src/shared/expr';

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
 * `extra` the mirror's non-test files the source does not have.
 */
export function compareTrees(sourceDir, targetDir) {
    const want = listMirrorFiles(sourceDir);
    const have = new Set(listMirrorFiles(targetDir));
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

function main() {
    const check = process.argv.includes('--check');
    const sourceDir = path.join(ROOT, REL_SOURCE);
    const targetDir = path.join(ROOT, REL_TARGET);
    const { files, differ, missing, extra } = compareTrees(sourceDir, targetDir);
    if (files.length === 0) throw new Error(`${REL_SOURCE}/ has no files to mirror — is this the repo root?`);
    const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
    const clean = differ.length === 0 && missing.length === 0 && extra.length === 0;

    if (check) {
        if (clean) {
            console.log(`gen-shared-mirror: ${REL_TARGET}/ matches ${REL_SOURCE}/ (${count}).`);
            return 0;
        }
        console.error(`gen-shared-mirror: ${REL_TARGET}/ is out of date with ${REL_SOURCE}/:`);
        for (const { file, line } of differ) console.error(`  differs: ${REL_TARGET}/${file} (first difference at line ${line})`);
        for (const file of missing) console.error(`  missing: ${REL_TARGET}/${file}`);
        for (const file of extra) console.error(`  extra:   ${REL_TARGET}/${file} (not in ${REL_SOURCE}/)`);
        console.error(`It is a generated copy — do not edit it by hand. Change ${REL_SOURCE}/,\n`
            + 'then run `npm run gen:shared` (node scripts/gen-shared-mirror.mjs) and commit both.');
        return 1;
    }

    if (clean) {
        console.log(`gen-shared-mirror: ${REL_TARGET}/ already up to date (${count}).`);
        return 0;
    }
    for (const file of [...missing, ...differ.map((d) => d.file)].sort()) {
        const to = path.join(targetDir, file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, fs.readFileSync(path.join(sourceDir, file)));
        console.log(`gen-shared-mirror: wrote ${REL_TARGET}/${file}`);
    }
    for (const file of extra) {
        fs.rmSync(path.join(targetDir, file));
        console.log(`gen-shared-mirror: removed ${REL_TARGET}/${file} (not in ${REL_SOURCE}/)`);
    }
    console.log(`gen-shared-mirror: ${REL_TARGET}/ now matches ${REL_SOURCE}/ (${count}).`);
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
