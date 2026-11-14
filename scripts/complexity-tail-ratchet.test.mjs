// Unit tests of the complexity tail ratchet: what counts as the tail, and the
// budget verdict (a rise fails, --update only lowers).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { tailOf, verdict, DEFAULT_THRESHOLD } from './complexity-tail-ratchet.mjs';

const PKG = path.join(path.sep, 'repo', 'server');
const msg = (name, n, line = 1) => ({ ruleId: 'complexity', line, message: `${name} has a complexity of ${n}. Maximum allowed is 15.` });

test('the tail is the complexity messages above the threshold, largest first, other rules ignored', () => {
    const results = [
        { filePath: path.join(PKG, 'a.js'), messages: [msg("Function 'small'", 40), msg("Async function 'big'", 41, 7), { ruleId: 'max-depth', line: 2, message: 'Blocks are nested too deeply (5).' }] },
        { filePath: path.join(PKG, 'lib', 'b.js'), messages: [msg("Method 'huge'", 90, 3)] },
    ];
    assert.deepEqual(tailOf(results, PKG, DEFAULT_THRESHOLD), [
        { file: 'lib/b.js', line: 3, complexity: 90, name: "Method 'huge'" },
        { file: 'a.js', line: 7, complexity: 41, name: "Async function 'big'" },
    ]);
    assert.equal(tailOf(results, PKG, 100).length, 0);
});

test('the verdict: over the budget fails, under or at passes, --update and a first run write the lower number', () => {
    assert.deepEqual(verdict(11, { count: 10 }, false), { status: 'fail' });
    assert.deepEqual(verdict(9, { count: 10 }, false), { status: 'under' });
    assert.deepEqual(verdict(10, { count: 10 }, false), { status: 'at' });
    assert.deepEqual(verdict(9, { count: 10 }, true), { status: 'write', next: 9 });
    assert.deepEqual(verdict(12, { count: 10 }, true), { status: 'write', next: 10 }, '--update never raises the budget');
    assert.deepEqual(verdict(12, null, false), { status: 'write', next: 12 });
});
