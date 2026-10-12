#!/usr/bin/env node
/**
 * Which agent-hub test file runs where in CI, and the guard that proves every
 * file runs exactly once. Replaces `vitest --shard`, which splits by file count
 * and left shard 1 ~40% slower than shard 3.
 *
 * Three places run tests:
 *   - shards 1..n, balanced by recorded duration (agent-hub/.test-durations.json);
 *   - the "server deps" job, which runs the few tests that import server source
 *     needing server/node_modules (agent-hub/.server-deps-tests.json). The
 *     shards no longer install server/.
 * A file missing from the durations file is placed by a hash of its path, so a
 * new test is never dropped and never needs this file touched.
 *
 * Usage (run from the repo root; paths are relative to agent-hub/):
 *   --shard i/n --out list.json    the files shard i runs (longest first)
 *   --server-deps --out list.json  the files of the server-deps job
 *   --check --expect k list...     the lists together are EXACTLY vitest's file list
 *   --write-durations report.json  regenerate .test-durations.json from a
 *                                  `vitest run --reporter=json` report
 * The vitest run reads the list through VITEST_FILE_LIST (agent-hub/vite.config.js).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignShards, orderLongestFirst, compareShardLists, parseShard } from '../server/scripts/testShards.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-hub');
const DURATIONS = path.join(HUB, '.test-durations.json');
const SERVER_DEPS = path.join(HUB, '.server-deps-tests.json');

const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);

/** vitest's own idea of the test files (its include/exclude globs), sorted. */
export function listAllTests(env = {}) {
    const r = spawnSync('npx', ['vitest', 'list', '--filesOnly'], { cwd: HUB, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`vitest list failed:\n${r.stderr}`);
    const files = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /\.test\.[jt]sx?$/.test(l));
    if (files.length === 0) throw new Error('vitest list returned no test files');
    return files.sort();
}

export function serverDepsFiles() {
    return readJson(SERVER_DEPS, { files: [] }).files;
}

/** The server-deps list must name real test files, and there must be some. */
export function checkServerDeps(all, serverDeps) {
    const problems = [];
    if (serverDeps.length === 0) problems.push('.server-deps-tests.json lists no files');
    const set = new Set(all);
    for (const f of serverDeps) if (!set.has(f)) problems.push(`${f} is in .server-deps-tests.json but is not a test file`);
    if (new Set(serverDeps).size !== serverDeps.length) problems.push('.server-deps-tests.json has a duplicate entry');
    return problems;
}

export function shardFiles(all, serverDeps, durations, index, count) {
    const skip = new Set(serverDeps);
    const rest = all.filter((f) => !skip.has(f));
    const shard = assignShards(rest, durations, count)[index - 1];
    return orderLongestFirst(shard, durations);
}

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
}

function writeDurations(reportFile) {
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    const durations = {};
    for (const r of report.testResults) {
        // A report merged from CI blobs names files by the runner's checkout
        // (/home/runner/work/.../agent-hub/src/...): keep the part after agent-hub/.
        const ci = r.name.lastIndexOf('/agent-hub/');
        const file = ci >= 0 ? r.name.slice(ci + '/agent-hub/'.length) : path.relative(HUB, r.name);
        const ms = Math.max(1, Math.round(r.endTime - r.startTime));
        durations[file] = ms;
    }
    const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(DURATIONS, JSON.stringify({
        _comment: 'Wall ms per test file from a real CI run; only used to balance the CI shards (scripts/frontend-shards.mjs). Regenerate from GitHub (local times on a many-core machine balance badly): gh run download <ci.yml run id> -p "vitest-blob-*" -D /tmp/b && mkdir /tmp/all && cp /tmp/b/*/*.json /tmp/all/ && cd agent-hub && npx vitest --merge-reports=/tmp/all --reporter=json --outputFile=/tmp/r.json && node ../scripts/frontend-shards.mjs --write-durations /tmp/r.json. A file missing here still runs (hash shard).',
        durations: sorted,
    }, null, 1) + '\n');
    console.log(`frontend-shards: wrote ${Object.keys(sorted).length} durations to ${path.relative(process.cwd(), DURATIONS)}`);
}

function main() {
    const wd = arg('--write-durations');
    if (wd) return writeDurations(wd);

    const all = listAllTests();
    const serverDeps = serverDepsFiles();
    const bad = checkServerDeps(all, serverDeps);
    if (bad.length > 0) {
        for (const p of bad) console.error(`frontend-shards: ${p}`);
        process.exit(1);
    }

    if (process.argv.includes('--check')) {
        const at = process.argv.indexOf('--expect');
        const expected = at >= 0 ? Number(process.argv[at + 1]) : null;
        const rest = process.argv.slice(2);
        const lists = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--expect')
            .map((f) => JSON.parse(readFileSync(f, 'utf8')));
        if (!expected || lists.length !== expected) {
            console.error(`frontend-shards: expected ${expected} lists, got ${lists.length}.`);
            process.exit(1);
        }
        const problems = compareShardLists(all, lists);
        // The server-deps list is the last one by convention; it must be exactly the configured set.
        const last = new Set(lists[lists.length - 1]);
        if (last.size !== serverDeps.length || serverDeps.some((f) => !last.has(f))) problems.push('the last list is not exactly .server-deps-tests.json');
        if (problems.length > 0) {
            for (const p of problems) console.error(`frontend-shards: ${p}`);
            process.exit(1);
        }
        console.log(`frontend-shards: ${all.length} test files, split ${lists.map((l) => l.length).join(' + ')}, every one in exactly one place.`);
        return;
    }

    const out = arg('--out');
    let list;
    if (process.argv.includes('--server-deps')) list = serverDeps;
    else {
        const { index, count } = parseShard(arg('--shard'));
        list = shardFiles(all, serverDeps, readJson(DURATIONS, {}).durations ?? {}, index, count);
    }
    if (list.length === 0) {
        console.error('frontend-shards: this list is empty; refusing to run a job on no files.');
        process.exit(1);
    }
    if (!out) {
        console.error('frontend-shards: --out is required');
        process.exit(1);
    }
    writeFileSync(out, JSON.stringify(list) + '\n');
    // Every entry must be a test file exactly as vitest names it: the shard
    // sequencer (agent-hub/vitest.shardSequencer.mjs) selects by that path, so
    // a name it cannot match would just not run. `vitest list` ignores the
    // sequencer, so check against vitest's full list instead.
    const known = new Set(all);
    const unknown = list.filter((f) => !known.has(f));
    if (unknown.length > 0) {
        for (const f of unknown) console.error(`frontend-shards: ${f} is not a test file vitest knows`);
        process.exit(1);
    }
    console.log(`frontend-shards: ${list.length} files -> ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
