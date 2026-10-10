import test from 'node:test';
import assert from 'node:assert/strict';
import { shardFiles, checkServerDeps } from './frontend-shards.mjs';
import { compareShardLists } from '../server/scripts/testShards.mjs';

const all = Array.from({ length: 120 }, (_, i) => `src/d${i % 5}/f${i}.test.${i % 2 ? 'jsx' : 'js'}`);
const serverDeps = [all[3], all[50]];
const durations = Object.fromEntries(all.slice(0, 100).map((f, i) => [f, ((i * 53) % 700) + 20]));

test('shards plus the server-deps list are a partition of all test files', () => {
    const lists = [1, 2, 3].map((i) => shardFiles(all, serverDeps, durations, i, 3));
    assert.deepEqual(compareShardLists(all, [...lists, serverDeps]), []);
});

test('server-deps files never land in a shard; files without a duration still do', () => {
    const lists = [1, 2, 3].map((i) => shardFiles(all, serverDeps, durations, i, 3)).flat();
    for (const f of serverDeps) assert.ok(!lists.includes(f));
    for (const f of all.slice(100)) assert.ok(lists.includes(f), `${f} was dropped`);
});

test('the guard names a file that runs nowhere or twice', () => {
    const lists = [1, 2, 3].map((i) => shardFiles(all, serverDeps, durations, i, 3));
    lists[0] = lists[0].slice(1);
    lists[1] = [...lists[1], lists[2][0]];
    const problems = compareShardLists(all, [...lists, serverDeps]);
    assert.equal(problems.length, 2);
});

test('a shard is longest first', () => {
    const l = shardFiles(all, serverDeps, durations, 1, 3).filter((f) => durations[f]);
    for (let i = 1; i < l.length; i++) assert.ok(durations[l[i - 1]] >= durations[l[i]]);
});

test('checkServerDeps refuses an empty list, a non-test file and a duplicate', () => {
    assert.deepEqual(checkServerDeps(all, serverDeps), []);
    assert.equal(checkServerDeps(all, []).length, 1);
    assert.match(checkServerDeps(all, ['src/nope.test.js'])[0], /not a test file/);
    assert.match(checkServerDeps(all, [all[0], all[0]]).join(), /duplicate/);
});
