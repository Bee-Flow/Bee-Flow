#!/usr/bin/env node
// @typecheck strict
/**
 * Adds the per-shard duration files CI uploads (`run-tests.mjs
 * --write-durations`, artifact server-shard-durations-N) up into one
 * scripts/test-durations.json, so the shard balance rests on real runner
 * times. A file in more than one input keeps the longest time.
 *
 * Usage: node scripts/merge-durations.mjs <out.json> <shard.json>...
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * @param {{ durations?: Record<string, number> }[]} inputs
 * @returns {Record<string, number>}
 */
export function mergeDurations(inputs) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const { durations } of inputs) {
        for (const [file, ms] of Object.entries(durations ?? {})) {
            if (Number.isFinite(ms) && ms > (out[file] ?? 0)) out[file] = ms;
        }
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const COMMENT = 'Wall ms per test file from a real run; only used to balance the CI shards (scripts/testShards.mjs). Regenerate from GitHub, where the PGlite-heavy files weigh differently than on a fast laptop: gh run download <ci.yml run id> -p "server-shard-durations-*" -D /tmp/d && node scripts/merge-durations.mjs scripts/test-durations.json /tmp/d/*/shard-durations.json. Locally: node scripts/run-tests.mjs --write-durations scripts/test-durations.json. A file missing here still runs (hash shard).';

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const [out, ...inputs] = process.argv.slice(2);
    if (!out || inputs.length === 0) {
        console.error('usage: node scripts/merge-durations.mjs <out.json> <shard.json>...');
        process.exit(2);
    }
    const durations = mergeDurations(inputs.map((f) => JSON.parse(readFileSync(f, 'utf8'))));
    writeFileSync(out, `${JSON.stringify({ _comment: COMMENT, durations }, null, 1)}\n`);
    console.log(`merge-durations: ${Object.keys(durations).length} files from ${inputs.length} shard(s) -> ${out}`);
}
