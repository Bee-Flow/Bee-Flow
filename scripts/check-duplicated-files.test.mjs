import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPairs, PAIRS } from './check-duplicated-files.mjs';

function sandbox(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dupfiles-'));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

const PAIR = [{ a: 'x/a.txt', b: 'y/b.txt' }];

test('identical bytes pass', () => {
    assert.deepEqual(checkPairs(sandbox({ 'x/a.txt': 'same\n', 'y/b.txt': 'same\n' }), PAIR), []);
});

test('a one-byte difference fails and names both files', () => {
    const problems = checkPairs(sandbox({ 'x/a.txt': 'same\n', 'y/b.txt': 'same \n' }), PAIR);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /x\/a\.txt and y\/b\.txt differ/);
});

test('line endings count as a difference', () => {
    assert.equal(checkPairs(sandbox({ 'x/a.txt': 'a\nb\n', 'y/b.txt': 'a\r\nb\r\n' }), PAIR).length, 1);
});

test('a missing file fails on either side, never skips', () => {
    assert.match(checkPairs(sandbox({ 'y/b.txt': 'x' }), PAIR)[0], /x\/a\.txt: cannot be read/);
    assert.match(checkPairs(sandbox({ 'x/a.txt': 'x' }), PAIR)[0], /y\/b\.txt: cannot be read/);
});

test('every pair reports separately', () => {
    const pairs = [...PAIR, { a: 'x/c.txt', b: 'y/d.txt' }];
    const root = sandbox({ 'x/a.txt': '1', 'y/b.txt': '2', 'x/c.txt': '3', 'y/d.txt': '4' });
    assert.equal(checkPairs(root, pairs).length, 2);
});

test('the real repository pairs are byte-identical', () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    assert.deepEqual(checkPairs(root, PAIRS), []);
});
