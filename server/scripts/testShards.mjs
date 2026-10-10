/**
 * Pure helpers behind `run-tests.mjs --shard i/n`: which test file runs in
 * which shard, and in what order inside a shard. No I/O, so it is unit tested
 * (testShards.test.mjs) and the CI guard can call the very same functions.
 *
 * Rules, each there so that a file can never silently run in no shard:
 *   - Every input file lands in exactly ONE shard (a partition, by construction).
 *   - A file with a recorded duration (scripts/test-durations.json) is placed by
 *     greedy longest-first balancing onto the least loaded shard.
 *   - A file WITHOUT a recorded duration (new since the file was generated) is
 *     placed by a hash of its path, so it never depends on the durations file and
 *     is never dropped. It is counted at the median duration while balancing.
 *   - Inside a shard the queue is longest-first, so the stragglers start early.
 */
import { createHash } from 'node:crypto';

export function parseShard(text) {
    const m = /^(\d+)\/(\d+)$/.exec(String(text ?? ''));
    if (!m) throw new Error(`--shard expects "i/n" (for example 2/3), got "${text}"`);
    const index = Number(m[1]);
    const count = Number(m[2]);
    if (count < 1 || index < 1 || index > count) throw new Error(`--shard ${text}: i must be between 1 and n`);
    return { index, count };
}

export function hashShard(file, count) {
    return createHash('sha1').update(file).digest().readUInt32BE(0) % count;
}

function median(values) {
    if (values.length === 0) return 1;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

const known = (durations, f) => Number.isFinite(durations?.[f]) && durations[f] > 0;

/** @returns {string[][]} `count` arrays that together hold every file exactly once. */
export function assignShards(files, durations, count) {
    const shards = Array.from({ length: count }, () => []);
    const loads = new Array(count).fill(0);
    const fallback = median(files.filter((f) => known(durations, f)).map((f) => durations[f]));
    const withTime = files.filter((f) => known(durations, f));
    const without = files.filter((f) => !known(durations, f));

    for (const f of without) {
        const s = hashShard(f, count);
        shards[s].push(f);
        loads[s] += fallback;
    }
    withTime.sort((a, b) => durations[b] - durations[a] || (a < b ? -1 : 1));
    for (const f of withTime) {
        let s = 0;
        for (let i = 1; i < count; i++) if (loads[i] < loads[s]) s = i;
        shards[s].push(f);
        loads[s] += durations[f];
    }
    return shards;
}

/** Longest first; files without a recorded duration count as the median. */
export function orderLongestFirst(files, durations) {
    const fallback = median(files.filter((f) => known(durations, f)).map((f) => durations[f]));
    const d = (f) => (known(durations, f) ? durations[f] : fallback);
    return [...files].sort((a, b) => d(b) - d(a) || (a < b ? -1 : 1));
}

/**
 * The CI guard: do the shard lists together equal the full list, as SETS?
 * (A count would pass with one file missing and one run twice.)
 * @returns {string[]} problems, empty when the shards are exactly a partition of `all`.
 */
export function compareShardLists(all, lists) {
    const problems = [];
    const allSet = new Set(all);
    const seen = new Map();
    lists.forEach((list, i) => {
        for (const f of list) {
            if (seen.has(f)) problems.push(`${f} runs in shard ${seen.get(f) + 1} and shard ${i + 1}`);
            else seen.set(f, i);
            if (!allSet.has(f)) problems.push(`${f} ran in shard ${i + 1} but is not a test file (or is excluded)`);
        }
    });
    for (const f of all) if (!seen.has(f)) problems.push(`${f} runs in NO shard`);
    return problems;
}
