// @typecheck strict
/**
 * scripts/run-postgres-tests.mjs: the run refuses to start when it would test
 * nothing or the wrong database, and it runs the files one at a time.
 *
 * Run: node --test scripts/run-postgres-tests.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FILES, selectFiles, refusal, nodeArgs, fileArg } from './run-postgres-tests.mjs';
import { resolveTreePath } from '../../scripts/lib/roots.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(SERVER_DIR, 'scripts', 'run-postgres-tests.mjs');
/** In any root of the server tree: a listed file may have moved to a module. */
const onDisk = (/** @type {string} */ f) => resolveTreePath('server', f) !== null;

test('every listed file exists, once', () => {
    assert.deepStrictEqual(FILES.filter((f) => !onDisk(f)), []);
    assert.strictEqual(new Set(FILES).size, FILES.length);
});

test('a filter narrows the list by path fragment; none keeps it whole', () => {
    assert.deepStrictEqual(selectFiles([]), FILES);
    assert.deepStrictEqual(selectFiles(['claim']), ['stores/automationStore.claim.test.js']);
    assert.deepStrictEqual(selectFiles(['nothing-like-this']), []);
});

test('it refuses without a database URL, without a match, and on a stale entry', () => {
    const url = { CORE_DATABASE_URL: 'postgresql://u@127.0.0.1:5432/db' };
    assert.match(String(refusal({}, FILES, onDisk)), /CORE_DATABASE_URL is not set/);
    assert.strictEqual(refusal(url, [], onDisk), 'no file matches');
    assert.match(String(refusal(url, ['stores/gone.test.js'], () => false)), /not on disk: stores\/gone\.test\.js/);
    assert.strictEqual(refusal(url, FILES, onDisk), null);
});

test('the files share one database, so they run one at a time', () => {
    const args = nodeArgs(['a.test.js', 'b.test.js'], 5000);
    assert.ok(args.includes('--test-concurrency=1'));
    assert.ok(args.includes('--test-timeout=5000'));
    assert.deepStrictEqual(args.slice(-2), ['a.test.js', 'b.test.js']);
    assert.ok(!nodeArgs(['a.test.js'], 0).some((a) => a.startsWith('--test-timeout')));
    assert.ok(!args.includes('--test-force-exit'), 'results are never cut off (see run-tests.mjs)');
});

test('a file in server/ is passed by its tree path, a moved one by its absolute path', () => {
    const moved = path.join(path.dirname(SERVER_DIR), 'modules', 'x', 'server', 'stores', 'a.test.js');
    assert.strictEqual(fileArg('stores/a.test.js', () => path.join(SERVER_DIR, 'stores', 'a.test.js')), 'stores/a.test.js');
    assert.strictEqual(fileArg('stores/a.test.js', () => moved), moved);
    assert.strictEqual(fileArg('stores/gone.test.js', () => null), 'stores/gone.test.js');
    assert.strictEqual(fileArg(FILES[0]), FILES[0], 'today every listed file is in server/');
});

test('started without CORE_DATABASE_URL it exits 1 and runs nothing', () => {
    const env = { ...process.env };
    delete env.CORE_DATABASE_URL;
    const res = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /CORE_DATABASE_URL is not set/);
    assert.strictEqual(res.stdout, '');
});
