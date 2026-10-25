import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addedFiles, main, needsTypes, violations } from './check-new-code-types.mjs';

test('needsTypes: server sources yes; tests, declarations, migrations, i18n and other packages no', () => {
    assert.equal(needsTypes('server/core/x.js'), true);
    assert.equal(needsTypes('server/core/x.mts'), true);
    for (const f of ['server/core/x.test.js', 'server/core/x.testkit.js', 'server/types/a.d.ts', 'server/migrations/a.js', 'server/i18n/defaults/en/a.js', 'agent-hub/src/a.js', 'server/data.json', 'server/node_modules/a/index.js']) {
        assert.equal(needsTypes(f), false, f);
    }
});

test('violations: .mts and strict-marked files pass, a plain or lower-level file fails', () => {
    const texts = {
        'server/a.js': "'use strict';\n",
        'server/b.js': '// @typecheck strict\n',
        'server/c.js': '// @typecheck noImplicitAny\n',
        'server/d.mts': 'export {};\n',
        'server/e.test.js': 'x\n',
    };
    assert.deepEqual(violations(Object.keys(texts), (f) => texts[f]), ['server/a.js', 'server/c.js']);
});

test('on a repo: only files ADDED since the base are checked, committed or not', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'newcode-'));
    try {
        const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
        run('init', '-q', '-b', 'main');
        run('config', 'user.email', 't@example.com');
        run('config', 'user.name', 't');
        mkdirSync(path.join(dir, 'server'));
        writeFileSync(path.join(dir, 'server/old.js'), 'old\n');
        run('add', '.');
        run('commit', '-q', '-m', 'base');
        const base = run('rev-parse', 'HEAD').trim();
        writeFileSync(path.join(dir, 'server/old.js'), 'old changed\n');
        writeFileSync(path.join(dir, 'server/committed.js'), 'no marker\n');
        run('add', '.');
        run('commit', '-q', '-m', 'work');
        writeFileSync(path.join(dir, 'server/loose.js'), '// @typecheck strict\n');
        assert.deepEqual(addedFiles(base, dir).sort(), ['server/committed.js', 'server/loose.js']);
        const errors = [];
        const code = main(['--base', base], dir, { log() {}, error: (m) => errors.push(m) });
        assert.equal(code, 1);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /server\/committed\.js/);
        assert.equal(main([], dir, { log() {}, error() {} }), 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
