import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { changesSince, defaultBase, isGuarded, main, parseNameStatus, violations } from './check-compat-corpus.mjs';

const CORPUS = 'server/appStudio/compat/corpus';
const FROZEN = 'server/appStudio/compat/frozen';

test('isGuarded: corpus inputs and frozen files, nothing else', () => {
    assert.equal(isGuarded(`${CORPUS}/a.json`), true);
    assert.equal(isGuarded(`${FROZEN}/a.json`), true);
    for (const f of ['server/appStudio/compat/README.md', 'server/appStudio/compat/corpus.mts', 'server/appStudio/templates/x.js']) {
        assert.equal(isGuarded(f), false, f);
    }
});

test('parseNameStatus + violations: only adding a guarded file is allowed', () => {
    const out = ['A', `${CORPUS}/new.json`, 'M', `${FROZEN}/old.json`, 'D', `${CORPUS}/gone.json`, 'T', `${CORPUS}/link.json`, 'M', 'server/other.js', ''].join('\0');
    const changes = parseNameStatus(out);
    assert.equal(changes.length, 5);
    assert.deepEqual(violations(changes).map((c) => `${c.status} ${c.file}`), [
        `M ${FROZEN}/old.json`, `D ${CORPUS}/gone.json`, `T ${CORPUS}/link.json`,
    ]);
});

/** A throwaway repo with one corpus input and its frozen file on `main`. */
function repo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'compat-corpus-'));
    const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.com');
    run('config', 'user.name', 't');
    mkdirSync(path.join(dir, CORPUS), { recursive: true });
    mkdirSync(path.join(dir, FROZEN), { recursive: true });
    writeFileSync(path.join(dir, CORPUS, 'old.json'), '{"definition":{}}\n');
    writeFileSync(path.join(dir, FROZEN, 'old.json'), '{"corpus":"old"}\n');
    run('add', '.');
    run('commit', '-q', '-m', 'base');
    return { dir, run, base: run('rev-parse', 'HEAD').trim() };
}

const quiet = () => {
    const lines = [];
    return { lines, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } };
};

test('on a repo: added files pass, also when edited again before the merge', () => {
    const { dir, run, base } = repo();
    try {
        writeFileSync(path.join(dir, CORPUS, 'new.json'), '{"definition":{"a":1}}\n');
        run('add', '.');
        run('commit', '-q', '-m', 'add');
        writeFileSync(path.join(dir, CORPUS, 'new.json'), '{"definition":{"a":2}}\n');
        writeFileSync(path.join(dir, FROZEN, 'new.json'), '{"corpus":"new"}\n');
        const q = quiet();
        assert.equal(main(['--base', base], dir, q.log), 0, q.lines.join('\n'));
        assert.match(q.lines.join('\n'), /no existing corpus file changed/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('on a repo: a committed modification fails and is named', () => {
    const { dir, run, base } = repo();
    try {
        writeFileSync(path.join(dir, FROZEN, 'old.json'), '{"corpus":"old","x":1}\n');
        run('commit', '-q', '-am', 'refreeze');
        const q = quiet();
        assert.equal(main(['--base', base], dir, q.log), 1);
        assert.match(q.lines.join('\n'), /modified {2}server\/appStudio\/compat\/frozen\/old\.json/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('on a repo: an uncommitted edit, a deletion and a rename all fail', () => {
    for (const change of ['edit', 'delete', 'rename']) {
        const { dir, base } = repo();
        try {
            const file = path.join(dir, CORPUS, 'old.json');
            if (change === 'edit') writeFileSync(file, '{"definition":{"b":1}}\n');
            if (change === 'delete') unlinkSync(file);
            if (change === 'rename') renameSync(file, path.join(dir, CORPUS, 'renamed.json'));
            assert.deepEqual(violations(changesSince(base, dir)).map((c) => c.status), change === 'edit' ? ['M'] : ['D'], change);
            assert.equal(main(['--base', base], dir, quiet().log), 1, change);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('without --base and without origin/main the gate skips; a bare --base is a usage error', () => {
    const { dir } = repo();
    try {
        assert.equal(defaultBase(dir), null);
        const q = quiet();
        assert.equal(main([], dir, q.log), 0);
        assert.match(q.lines.join('\n'), /SKIP/);
        assert.equal(main(['--base'], dir, quiet().log), 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
