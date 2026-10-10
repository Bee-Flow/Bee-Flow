#!/usr/bin/env node
/**
 * CI guard behind the "Server tests" aggregate: the file lists the shards wrote
 * (`run-tests.mjs --files-out`) must be exactly the full list of test files
 * minus the documented exclusions, as sets, with every file in one shard.
 * A lost shard, a stale durations file or a bad merge fails here by file name.
 *
 * Usage: node scripts/check-test-shards.mjs --expect <n> <list.json>...
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareShardLists } from './testShards.mjs';

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
