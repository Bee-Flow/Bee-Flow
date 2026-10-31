#!/usr/bin/env node
// @typecheck noImplicitAny
/**
 * CI guard behind the "Server tests" aggregate: the file lists the shards wrote
 * (`run-tests.mjs --files-out`) must be exactly the full list of test files
 * minus the documented exclusions, as sets, with every file in one shard.
 * A lost shard, a stale durations file or a bad merge fails here by file name.
 * A durations file that no longer knows more than a tenth of the files only
 * WARNS (a workflow annotation): the shards still ran everything, they just
 * ran it unevenly, and the fix is one regenerated file, not a red PR.
 *
 * Usage: node scripts/check-test-shards.mjs --expect <n> <list.json>...
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareShardLists, unrecorded, UNRECORDED_WARN_SHARE } from './testShards.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = args.indexOf('--expect');
const expected = at >= 0 ? Number(args[at + 1]) : null;
const files = args.filter((a, i) => !a.startsWith('--') && i !== at + 1);
if (!expected || files.length !== expected) {
    console.error(`check-test-shards: expected ${expected} shard lists, got ${files.length}.`);
    process.exit(1);
}
const full = spawnSync(process.execPath, [path.join(SERVER_DIR, 'scripts', 'run-tests.mjs'), '--list'], { cwd: SERVER_DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
if (full.status !== 0) {
    console.error(`check-test-shards: could not list the test files:\n${full.stderr}`);
    process.exit(1);
}
const all = JSON.parse(full.stdout.trim().split('\n').pop());
const lists = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const problems = compareShardLists(all, lists);
if (problems.length > 0) {
    for (const p of problems) console.error(`check-test-shards: ${p}`);
    process.exit(1);
}
console.log(`check-test-shards: ${all.length} test files, split ${lists.map((l) => l.length).join(' + ')}, every one in exactly one shard.`);

const durationsFile = path.join(SERVER_DIR, 'scripts', 'test-durations.json');
const durations = existsSync(durationsFile) ? JSON.parse(readFileSync(durationsFile, 'utf8')).durations ?? {} : {};
const missing = unrecorded(all, durations);
if (missing.length > all.length * UNRECORDED_WARN_SHARE) {
    const msg = `${missing.length} of ${all.length} test files have no recorded duration (scripts/test-durations.json), so they were placed by hash and the shards run unevenly. Regenerate: cd server && node scripts/run-tests.mjs --write-durations scripts/test-durations.json`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning file=server/scripts/test-durations.json::${msg}` : `check-test-shards: WARNING ${msg}`);
}
