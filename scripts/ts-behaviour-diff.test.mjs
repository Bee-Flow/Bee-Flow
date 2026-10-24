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

test('--only keeps the named files and directories, by new or old path', async () => {
    const { filterOnly, parseOnly } = await import('./ts-behaviour-diff.mjs');
    const files = [
        { status: 'M', oldPath: 'agent-hub/src/a/B.tsx', path: 'agent-hub/src/a/B.tsx' },
        { status: 'R', oldPath: 'agent-hub/src/c/D.jsx', path: 'agent-hub/src/c/D.tsx' },
        { status: 'M', oldPath: 'server/core/x.js', path: 'server/core/x.js' },
    ];
    assert.equal(filterOnly(files, null), files);
    assert.deepEqual(filterOnly(files, ['agent-hub/src/a/B.tsx']).map((f) => f.path), ['agent-hub/src/a/B.tsx']);
    assert.deepEqual(filterOnly(files, ['agent-hub/src/c/D.jsx']).map((f) => f.path), ['agent-hub/src/c/D.tsx'], 'old path of a rename');
    assert.deepEqual(filterOnly(files, ['server/']).map((f) => f.path), ['server/core/x.js']);
    assert.deepEqual(filterOnly(files, ['serve']).map((f) => f.path), [], 'a prefix of a name is not a directory');
    // parse: repo-relative, directory marker, list file
    const only = parseOnly('agent-hub/src/a/B.tsx,server/');
    assert.deepEqual(only, ['agent-hub/src/a/B.tsx', 'server/']);
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')), 'l.txt');
    fs.writeFileSync(list, '# c\nagent-hub/src/c/D.tsx\n');
    assert.deepEqual(parseOnly(`@${list},server/x.js`), ['agent-hub/src/c/D.tsx', 'server/x.js']);
});

test('CLI: --base defaults to HEAD and --only limits the files compared', async () => {
    const { spawnSync } = await import('node:child_process');
    const path = await import('node:path');
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'ts-behaviour-diff.mjs');
    // --only naming a file with no change: nothing compared, exit 0, no --base given
    const r = spawnSync(process.execPath, [script, '--only', 'does/not/exist.ts', '--quiet'], { encoding: 'utf8' });
    if (/esbuild/i.test(r.stderr) && r.status === 2) return; // esbuild not installed here
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^0 changed source file\(s\)/m);
});
