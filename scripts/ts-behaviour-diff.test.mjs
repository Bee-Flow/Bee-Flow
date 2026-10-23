import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFiles, newSince } from './ts-behaviour-diff.mjs';

test('modified and renamed source files count; added, deleted, tests and other files do not', () => {
    const out = changedFiles([
        'M\tagent-hub/src/a/B.tsx',
        'R095\tagent-hub/src/c/D.jsx\tagent-hub/src/c/D.tsx',
        'M\tagent-hub/src/c/D.test.tsx',
        'A\tagent-hub/src/new.ts',
        'D\tagent-hub/src/old.js',
        'M\tserver/core/x.js',
        'M\tserver/core/x.test.js',
        'M\tdocs/readme.md',
        'M\tagent-hub/.eslint-budget.json',
    ].join('\n'));
    assert.deepEqual(out, [
        { status: 'M', oldPath: 'agent-hub/src/a/B.tsx', path: 'agent-hub/src/a/B.tsx' },
        { status: 'R', oldPath: 'agent-hub/src/c/D.jsx', path: 'agent-hub/src/c/D.tsx' },
        { status: 'M', oldPath: 'server/core/x.js', path: 'server/core/x.js' },
    ]);
});

test('a difference already in the baseline is reviewed; a line that came back is new', () => {
    const baseline = [{ path: 'a.tsx', removed: ['if (!x) return;'], added: [] }];
    const report = [
        { path: 'a.tsx', removed: ['if (!x) return;'], added: ['if (!x) return null;'] }, // the guard the reviewer removed is back, in a new form
        { path: 'b.tsx', removed: [], added: ['const y = x?.z;'] }, // a file not in the baseline
        { path: 'c.tsx', removed: [], added: [] },
    ];
    const marked = newSince(report, baseline);
    assert.equal(marked[0].isNew, true); assert.deepEqual(marked[0].newAdded, ['if (!x) return null;']); assert.deepEqual(marked[0].newRemoved, []);
    assert.equal(marked[1].isNew, true);
    assert.equal(marked[2].isNew, true); // never seen before, even if empty
    // the same report against itself: nothing new
    assert.ok(newSince(report, report).every((r) => !r.isNew));
    // no baseline: everything is new
    assert.ok(newSince(report, null).every((r) => r.isNew));
});
