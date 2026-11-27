/**
 * repo-text: the walk yields the matching files and never enters a skipped directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TEXT_EXT, walkFiles } from './repo-text.mjs';

test('walks matching files, skipping node_modules, .git and .claude at any depth', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-text-'));
    for (const f of ['a.md', 'b.png', 'x/c.json', 'x/node_modules/d.js', '.git/e.txt', 'y/.claude/f.md']) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), '');
    }
    const got = walkFiles(dir, (n) => TEXT_EXT.test(n)).map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();
    assert.deepEqual(got, ['a.md', 'x/c.json']);
});
