/**
 * The secret scanners' file lists: scripts/scan-secrets.sh and
 * scripts/check-no-test-secrets.sh, in their default mode and in the
 * --changed / --staged modes the commit hooks use.
 *
 * What these guard against is a scan that reads the wrong files and says
 * "clean": the Claude Code hook runs before `git add x && git commit`, so a
 * scan of the index or of tracked files never sees x; a directory walk reads
 * other sessions' worktrees under .claude/worktrees/ and blocks this one.
 *
 * Each case builds a throwaway git repository under os.tmpdir() with the real
 * scripts and .gitleaks.toml copied in, and drives them with bash. The
 * token is assembled at run time so this file holds nothing secret-shaped.
 * Every case runs with whatever is installed; where gitleaks is on PATH they
 * run a second time without it, so the regex fallback is covered as well.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const hasBash = !spawnSync('bash', ['-c', 'exit 0']).error;
const skip = hasBash ? false : 'bash is not available';

// A classic GitHub token shape: gitleaks' github-pat rule and the fallback's
// github_pat_classic both match it. The body is spread over the alphabet so
// it clears gitleaks' entropy bar.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BODY = Array.from({ length: 36 }, (_, i) => ALPHABET[(i * 17 + 5) % ALPHABET.length]).join('');
const TOKEN = ['gh', 'p_', BODY].join('');

const FIXTURE = (value) => `process.env.${'MASTER_ENCRYPTION_KEY'} = "${value}";\n`;

// Identity and signing set per call, and no hooks: one in the user's global
// config must not run in the sandbox.
const GIT_ISOLATION = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function git(dir, ...args) {
    const res = spawnSync('git', [...GIT_ISOLATION, ...args], { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout;
}

/** A committed repository with the real scanners and config in it. */
function sandbox(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-secrets-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'src'));
    for (const f of ['scripts/scan-secrets.sh', 'scripts/check-no-test-secrets.sh', '.gitleaks.toml']) {
        fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/worktrees/\n');
    fs.writeFileSync(path.join(dir, 'src/a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(dir, 'src/b.js'), 'module.exports = 2;\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    return dir;
}

const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};

// A PATH with every directory that holds gitleaks swapped for one with links
// to just the tools the scripts use. Null when gitleaks is not installed.
function pathWithoutGitleaks(t) {
    if (process.platform === 'win32') return null;
    const dirs = (process.env.PATH || '').split(path.delimiter);
    const holding = new Set(dirs.filter((d) => d && fs.existsSync(path.join(d, 'gitleaks'))));
    if (holding.size === 0) return null;
    const shims = fs.mkdtempSync(path.join(os.tmpdir(), 'no-gitleaks-'));
    t.after(() => fs.rmSync(shims, { recursive: true, force: true }));
    const tools = ['bash', 'git', 'mktemp', 'rm', 'tr', 'wc', 'tar', 'cat', 'mkdir', 'sed', 'xargs', 'grep', 'head', 'dirname'];
    for (const tool of tools) {
        const home = dirs.find((d) => d && holding.has(d) && fs.existsSync(path.join(d, tool)));
        if (home) fs.symlinkSync(path.join(home, tool), path.join(shims, tool));
    }
    return [shims, ...dirs.filter((d) => !holding.has(d))].join(path.delimiter);
}

const VARIANTS = [{ name: 'as installed', path: () => process.env.PATH }];
if (process.platform !== 'win32') VARIANTS.push({ name: 'without gitleaks', path: pathWithoutGitleaks, optional: true });

function variants(t) {
    return VARIANTS.map((v) => ({ name: v.name, PATH: v.path(t), optional: v.optional })).filter((v) => v.PATH || !v.optional);
}

function scan(dir, env, script, ...args) {
    const res = spawnSync('bash', [path.join('scripts', script), ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: env.PATH },
    });
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

test('--changed finds a token in a new untracked file, which the tree scan never reads', { skip }, (t) => {
    for (const env of variants(t)) {
        const dir = sandbox(t);
        write(dir, 'src/new.js', `module.exports = { url: "${TOKEN}" };\n`);

        const tree = scan(dir, env, 'scan-secrets.sh');
        assert.strictEqual(tree.status, 0, `${env.name}: the tree scan reads tracked files only\n${tree.out}`);

        const changed = scan(dir, env, 'scan-secrets.sh', '--changed');
        assert.strictEqual(changed.status, 1, `${env.name}: --changed must flag it\n${changed.out}`);
        assert.match(changed.out, /src\/new\.js:1/, env.name);
        assert.ok(!changed.out.includes(BODY), `${env.name}: a finding names the file, never the value`);
        if (env.optional) assert.match(changed.out, /regex fallback/, 'the variant without gitleaks runs the fallback');
    }
});

// The fallback's private-key rules start with '-----', which grep used to read
// as an option (exit 2, swallowed): a PEM key passed every fallback mode.
test('a private key is caught, by gitleaks and by the regex fallback', { skip }, (t) => {
    const pem = ['-----BEGIN ', 'RSA PRIV', 'ATE KEY-----'].join('') + `\nMIIEow${BODY}\n` + ['-----END ', 'RSA PRIV', 'ATE KEY-----'].join('') + '\n';
    for (const env of variants(t)) {
        const dir = sandbox(t);
        write(dir, 'src/key.txt', pem);
        const changed = scan(dir, env, 'scan-secrets.sh', '--changed');
        assert.strictEqual(changed.status, 1, `${env.name}: a private key must fail the scan\n${changed.out}`);
        assert.match(changed.out, /src\/key\.txt:1/, env.name);
        assert.ok(!changed.out.includes(BODY), `${env.name}: never the value`);
    }
});

// `| head -8` closed the pipe early; the sed before it died of SIGPIPE and
// pipefail made the script exit 141, which the commit hook reads as "did not
// finish" rather than "found something": the more secrets, the likelier a pass.
test('many findings still exit 1, never 141', { skip }, (t) => {
    const lines = Array.from({ length: 300 }, (_, i) => `export const k${i} = "${TOKEN}";`).join('\n') + '\n';
    for (const env of variants(t)) {
        const dir = sandbox(t);
        write(dir, 'src/many.js', lines);
        for (let run = 0; run < 3; run++) {
            const changed = scan(dir, env, 'scan-secrets.sh', '--changed');
            assert.strictEqual(changed.status, 1, `${env.name}, run ${run + 1}: exit ${changed.status}\n${changed.out.slice(0, 500)}`);
        }
    }
});

// grep read a file named like an option (`-q`) as a flag and printed nothing
// for the whole batch, so every other file's finding vanished with it.
test('a stray file named like a grep option does not hide a finding', { skip }, (t) => {
    for (const env of variants(t)) {
        const dir = sandbox(t);
        write(dir, '-q', 'x\n');
        write(dir, 'src/new.js', `module.exports = { url: "${TOKEN}" };\n`);
        const changed = scan(dir, env, 'scan-secrets.sh', '--changed');
        assert.strictEqual(changed.status, 1, `${env.name}\n${changed.out}`);
        assert.match(changed.out, /src\/new\.js:1/, env.name);
    }
});

test('--changed reads a tracked file changed in the working tree, staged or not', { skip }, (t) => {
    for (const env of variants(t)) {
        const dir = sandbox(t);
        write(dir, 'src/a.js', `const url = "${TOKEN}";\n`);
        assert.strictEqual(scan(dir, env, 'scan-secrets.sh', '--changed').status, 1, env.name);
        git(dir, 'add', 'src/a.js');
        assert.strictEqual(scan(dir, env, 'scan-secrets.sh', '--changed').status, 1, env.name);
    }
});

test('--staged reads the index: a staged token fails, an unstaged one does not', { skip }, (t) => {
    for (const env of variants(t)) {
        const dir = sandbox(t);
        write(dir, 'src/a.js', 'module.exports = 3;\n');
        git(dir, 'add', 'src/a.js');
        write(dir, 'src/b.js', `const url = "${TOKEN}";\n`);
        const unstaged = scan(dir, env, 'scan-secrets.sh', '--staged');
        assert.strictEqual(unstaged.status, 0, `${env.name}: b.js is not staged\n${unstaged.out}`);

        // Staged, then removed from the working tree without restaging: the
        // commit would still record it.
        write(dir, 'src/a.js', `const url = "${TOKEN}";\n`);
        git(dir, 'add', 'src/a.js');
        write(dir, 'src/a.js', 'module.exports = 3;\n');
        const staged = scan(dir, env, 'scan-secrets.sh', '--staged');
        assert.strictEqual(staged.status, 1, `${env.name}: the index holds the token\n${staged.out}`);
        assert.match(staged.out, /src\/a\.js:1/, env.name);
        assert.ok(!staged.out.includes('src/b.js'), `${env.name}: only staged paths are read`);
    }
});

test('an empty change list is a pass, and says so', { skip }, (t) => {
    for (const env of variants(t)) {
        const dir = sandbox(t);
        for (const mode of ['--changed', '--staged']) {
            const res = scan(dir, env, 'scan-secrets.sh', mode);
            assert.strictEqual(res.status, 0, `${env.name} ${mode}\n${res.out}`);
            assert.match(res.out, /nothing to scan/, `${env.name} ${mode}`);
            const fixtures = scan(dir, env, 'check-no-test-secrets.sh', mode);
            assert.strictEqual(fixtures.status, 0, `${env.name} ${mode}\n${fixtures.out}`);
            assert.match(fixtures.out, /nothing to scan/, `${env.name} ${mode}`);
        }
    }
});

test('an unknown mode is a usage error, not a pass', { skip }, (t) => {
    const dir = sandbox(t);
    for (const script of ['scan-secrets.sh', 'check-no-test-secrets.sh']) {
        const res = scan(dir, { PATH: process.env.PATH }, script, '--everything');
        assert.strictEqual(res.status, 2, `${script}\n${res.out}`);
        assert.match(res.out, /usage:/, script);
    }
});

test('check-no-test-secrets ignores other checkouts under .claude/worktrees/ and catches tracked source', { skip }, (t) => {
    const env = { PATH: process.env.PATH };
    const dir = sandbox(t);
    write(dir, '.claude/worktrees/x/server/wip.js', FIXTURE('test-wip'));
    write(dir, 'server/crypto.test.js', FIXTURE('test-ok'));
    git(dir, 'add', 'server/crypto.test.js');
    const clean = scan(dir, env, 'check-no-test-secrets.sh');
    assert.strictEqual(clean.status, 0, `another session's worktree must not block this checkout\n${clean.out}`);

    write(dir, 'server/crypto.js', FIXTURE('test-leak'));
    git(dir, 'add', 'server/crypto.js');
    git(dir, 'commit', '-q', '-m', 'leak');
    const dirty = scan(dir, env, 'check-no-test-secrets.sh');
    assert.strictEqual(dirty.status, 1, dirty.out);
    assert.match(dirty.out, /\.\/server\/crypto\.js:1:/);
    assert.ok(!dirty.out.includes('worktrees'), dirty.out);
    assert.ok(!dirty.out.includes('crypto.test.js'), dirty.out);
});

test('check-no-test-secrets --changed and --staged read the same lists as scan-secrets', { skip }, (t) => {
    const env = { PATH: process.env.PATH };
    const dir = sandbox(t);
    write(dir, 'server/untracked.js', FIXTURE('test-new'));
    const changed = scan(dir, env, 'check-no-test-secrets.sh', '--changed');
    assert.strictEqual(changed.status, 1, changed.out);
    assert.match(changed.out, /\.\/server\/untracked\.js:1:/);
    assert.strictEqual(scan(dir, env, 'check-no-test-secrets.sh', '--staged').status, 0, 'nothing is staged');

    git(dir, 'add', 'server/untracked.js');
    write(dir, 'server/untracked.js', 'module.exports = 0;\n');
    const staged = scan(dir, env, 'check-no-test-secrets.sh', '--staged');
    assert.strictEqual(staged.status, 1, `the index still has it\n${staged.out}`);
    assert.match(staged.out, /\.\/server\/untracked\.js:1:/);
    assert.strictEqual(scan(dir, env, 'check-no-test-secrets.sh', '--changed').status, 0, 'the working tree no longer has it');
});

test('a repository without a first commit: --changed lists every file', { skip }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-secrets-empty-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(REPO, 'scripts/scan-secrets.sh'), path.join(dir, 'scripts/scan-secrets.sh'));
    git(dir, 'init', '-q');
    write(dir, 'src/new.js', `const url = "${TOKEN}";\n`);
    const res = scan(dir, { PATH: process.env.PATH }, 'scan-secrets.sh', '--changed');
    assert.strictEqual(res.status, 1, res.out);
});
