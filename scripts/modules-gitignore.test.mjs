// Proof for modules/.gitignore: every tracked file of server/ and agent-hub/ that
// lives below a directory named data/ stays tracked once it moves to its module
// path (modules/<id>/server/... or modules/<id>/frontend/...). The root .gitignore
// ignores every data/ directory and re-includes the tracked ones by core path, so
// without modules/.gitignore such a file would silently drop out of git on a move.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args, input) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });

/** The would-be module path of a core file, or null when it is not in a mirrored root. */
export function modulePath(file, id = 'x') {
    if (file.startsWith('server/')) return `modules/${id}/server/${file.slice('server/'.length)}`;
    if (file.startsWith('agent-hub/')) return `modules/${id}/frontend/${file.slice('agent-hub/'.length)}`;
    return null;
}

function trackedDataFiles() {
    const out = git(['ls-files', '-z', '--', 'server', 'agent-hub']);
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.split('\0').filter((f) => f && f.split('/').slice(0, -1).includes('data'));
}

test('modulePath maps server/ and agent-hub/ to their module roots', () => {
    assert.equal(modulePath('server/migrations/data/a.json'), 'modules/x/server/migrations/data/a.json');
    assert.equal(modulePath('agent-hub/src/a/data/b.ts'), 'modules/x/frontend/src/a/data/b.ts');
    assert.equal(modulePath('docs/a.md'), null);
});

test('no tracked data/ file of server/ or agent-hub/ is ignored at its module path', () => {
    const files = trackedDataFiles();
    assert.ok(files.length > 0, 'expected tracked files below a data/ directory');
    const res = git(['check-ignore', '--no-index', '-v', '--stdin'], files.map((f) => modulePath(f)).join('\n') + '\n');
    // exit 1 = nothing ignored; 0 = something ignored; anything else is an error
    assert.equal(res.status, 1, `ignored at their module path:\n${res.stdout}${res.stderr}`);
});

test('run-time data and build output under a module root stay ignored', () => {
    const paths = ['modules/x/server/data/upload.bin', 'modules/x/server/node_modules', 'modules/x/frontend/dist/a.js', 'modules/x/frontend/coverage/a.json'];
    const res = git(['check-ignore', '--no-index', '--stdin'], paths.join('\n') + '\n');
    assert.deepEqual(res.stdout.trim().split('\n').sort(), [...paths].sort());
});
