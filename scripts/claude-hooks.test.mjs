/**
 * The Claude Code hooks in .claude/hooks/ and their helpers in lib/.
 *
 * The hooks fail quietly by design (a broken hook must not wedge a session),
 * which is exactly how they stopped working unnoticed: they looked for the
 * repository at CLAUDE_PROJECT_DIR/Bee-Flow-AI, a folder that exists only in
 * the owner's Windows wrapper layout, so in every cloud session they found no
 * scripts and did nothing. These cases pin what each one does in both layouts
 * and in a worktree, and that a scan or a test run that never finished is
 * reported instead of passing.
 *
 * Throwaway git repositories under os.tmpdir(); the hooks run as Claude Code
 * runs them, a node process with the event as JSON on stdin. No network.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSegments, splitSegments, isGitCommit, isDryRun, findCommits, commitFlags } from '../.claude/hooks/lib/commands.mjs';
import { resolveRepo, repoPath } from '../.claude/hooks/lib/repo.mjs';
import { run, classify } from '../.claude/hooks/lib/proc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOOKS = path.join(REPO, '.claude', 'hooks');

const hasBash = !spawnSync('bash', ['-c', 'exit 0']).error;
const needsBash = hasBash ? false : 'bash is not available';
const posixOnly = process.platform === 'win32' ? 'POSIX process groups and permissions' : false;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN = ['gh', 'p_', Array.from({ length: 36 }, (_, i) => ALPHABET[(i * 17 + 5) % 62]).join('')].join('');

const real = (p) => fs.realpathSync(p);

function tmpdir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function git(dir, ...args) {
    const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout;
}

function write(dir, rel, text, mode) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    if (mode) fs.chmodSync(file, mode);
    return file;
}

/** A committed repository at `dir`, optionally with the real scanners copied in. */
function makeRepo(dir, { scanners = false } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    if (scanners) {
        for (const f of ['scripts/scan-secrets.sh', 'scripts/check-no-test-secrets.sh', '.gitleaks.toml']) {
            write(dir, f, fs.readFileSync(path.join(REPO, f)));
        }
    }
    write(dir, '.gitignore', '.claude/worktrees/\n');
    write(dir, 'src/a.js', 'module.exports = 1;\n');
    git(dir, 'init', '-q');
    fs.mkdirSync(path.join(dir, '.git', 'no-hooks'));
    git(dir, 'config', 'core.hooksPath', '.git/no-hooks');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    return dir;
}

/** Run a hook the way Claude Code does. */
function hook(name, payload, env = {}) {
    const res = spawnSync(process.execPath, [path.join(HOOKS, name)], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
    const text = (res.stdout || '').trim();
    return { status: res.status, stdout: text, stderr: res.stderr || '', json: text ? JSON.parse(text) : null };
}

function hookAsync(name, payload, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(HOOKS, name)], { env: { ...process.env, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => { stdout += b; });
        child.stderr.on('data', (b) => { stderr += b; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(JSON.stringify(payload));
    });
}

const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });

// ── lib/commands.mjs ─────────────────────────────────────────────────────────

test('segments split on && || ; | & and newlines, never inside quotes', () => {
    assert.deepStrictEqual(splitSegments('a && b || c; d | e & f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    assert.deepStrictEqual(splitSegments('git commit -m "a; b && c | d"'), ['git commit -m "a; b && c | d"']);
    assert.deepStrictEqual(splitSegments("echo 'x || y' && ls"), ["echo 'x || y'", 'ls']);
    assert.deepStrictEqual(splitSegments('echo a\\;b; ls'), ['echo a\\;b', 'ls']);
    assert.deepStrictEqual(splitSegments('npm test 2>&1 | tail -3'), ['npm test 2>&1', 'tail -3']);
    assert.deepStrictEqual(splitSegments('ls # git commit\n# git commit\npwd'), ['ls', 'pwd']);
    assert.deepStrictEqual(parseSegments('git commit -m "a b" -q')[0].words, ['git', 'commit', '-m', 'a b', '-q']);
});

test('a heredoc body is input, not commands', () => {
    const cmd = "git commit -F - <<'EOF'\ngit commit --dry-run; git push origin main\nEOF\necho done";
    assert.deepStrictEqual(parseSegments(cmd).map((s) => s.words), [['git', 'commit', '-F', '-'], ['echo', 'done']]);
    const quoted = [
        'git add -A && git commit -m "$(cat <<\'EOF\'',
        'feat(x): the "quoted" part and an unbalanced )',
        '',
        '1) git commit --dry-run; git push origin main',
        'EOF',
        ')"',
    ].join('\n');
    const segs = parseSegments(quoted);
    assert.strictEqual(segs.length, 2);
    assert.deepStrictEqual(segs[1].words.slice(0, 3), ['git', 'commit', '-m']);
    assert.strictEqual(isDryRun(segs[1]), false);
    assert.deepStrictEqual(splitSegments('cat <<< "x"\ngit status'), ['cat <<< "x"', 'git status']);
});

test('isGitCommit: git commit with or without global options, nothing else', () => {
    for (const yes of ['git commit -m x', 'git -C "/some dir" commit', 'git -c user.name=a commit -am z', 'FOO=1 git commit', '/usr/bin/git commit', '"C:/Program Files/Git/cmd/git.exe" commit']) {
        assert.ok(isGitCommit(yes), yes);
    }
    for (const no of ['git merge --no-commit feature', 'git log --grep commit', 'git show HEAD:commit.txt', 'git commit-tree HEAD^{tree}', '# git commit', 'echo git commit', 'gh pr create --body "git commit"']) {
        assert.ok(!isGitCommit(no), no);
    }
});

test('isDryRun: only a real --dry-run flag of that commit', () => {
    assert.ok(isDryRun('git commit --dry-run -m x'));
    assert.ok(isDryRun('git commit -a --dry'), 'git accepts an unambiguous prefix');
    assert.ok(!isDryRun('git commit -m "x git commit --dry-run"'));
    assert.ok(!isDryRun('git commit -m --dry-run'), 'the value of -m');
    assert.ok(!isDryRun('git commit --message=--dry-run'));
    assert.ok(!isDryRun('git commit -am --dry-run'));
    assert.ok(!isDryRun('git commit -- --dry-run'), 'after -- it is a pathspec');
    const [c] = findCommits('git commit -m "msg" && echo --dry-run', { cwd: '/' });
    assert.strictEqual(c.dryRun, false, 'a --dry-run elsewhere on the line changes nothing');
});

test('commitFlags: --no-verify, -n, -a and bundles', () => {
    assert.deepStrictEqual(commitFlags(['-nm', 'x']), { dryRun: false, noVerify: true, all: false });
    assert.deepStrictEqual(commitFlags(['--no-verify']), { dryRun: false, noVerify: true, all: false });
    assert.deepStrictEqual(commitFlags(['-m', '-n']), { dryRun: false, noVerify: false, all: false });
    assert.deepStrictEqual(commitFlags(['-mn']), { dryRun: false, noVerify: false, all: false }, 'n is the message');
    assert.strictEqual(commitFlags(['-am', 'x']).all, true);
    assert.strictEqual(commitFlags(['--all', '-m', 'x']).all, true);
    assert.strictEqual(commitFlags(['-ma']).all, false, 'a is the message');
    assert.strictEqual(commitFlags(['--allow-empty']).all, false);
});

test('findCommits follows cd and -C, and looks inside bash -c', () => {
    const base = path.resolve('/work/repo');
    const [a] = findCommits('cd server && npm test && cd .. && git commit -m ok', { cwd: base });
    assert.strictEqual(a.cwd, base);
    const [b] = findCommits('cd sub && git -C inner commit -m x', { cwd: base });
    assert.strictEqual(b.cwd, path.join(base, 'sub', 'inner'));
    const [c] = findCommits('cd "$DIR" && git commit', { cwd: base });
    assert.strictEqual(c.cwd, null, 'unknowable');
    const [d] = findCommits("bash -c 'git commit -m inner'", { cwd: base });
    assert.strictEqual(d.cwd, base);
    const [e] = findCommits('git -c core.hooksPath=/dev/null commit', { cwd: base });
    assert.strictEqual(e.hooksPathOverride, true);
    assert.deepStrictEqual(findCommits('git status; ls', { cwd: base }), []);
});

test('PowerShell: backtick escapes and here-strings', () => {
    assert.deepStrictEqual(splitSegments('git add x; git commit -m "a `"b`" c"', { powershell: true }), ['git add x', 'git commit -m "a `"b`" c"']);
    const [c] = findCommits('git commit -m @"\nfix; git commit --dry-run\n"@', { powershell: true, cwd: '/' });
    assert.strictEqual(c.dryRun, false);
});

// Each of these made a commit the old whole-string regex scanned and the
// first parser did not see, so the hook let it through unscanned.
const BASH_COMMIT_FORMS = [
    'if ! git diff --cached --quiet; then git commit -m x; fi',
    'if git commit -m x; then git push; fi',
    'for d in a; do git commit -m x; done',
    'while true; do git commit -m x; break; done',
    'until false; do git commit -m x; done',
    'timeout 60 git commit -m x',
    'nice git commit -m x',
    'xargs git commit -m x',
    'out=$(git commit -m x 2>&1)',
    'echo "$(git commit -m x)"',
    'echo `git commit -m x`',
    'cmd /c "git commit -m x"',
];
const PS_COMMIT_FORMS = [
    '$out = git commit -m x 2>&1',
    'try { git commit -m x } catch {}',
    'if ($?) {git commit -m x}',
    'if ($LASTEXITCODE -eq 0) {git commit -m "x"}',
    'pwsh -Command "git commit -m x"',
];

test('findCommits sees past reserved words, wrappers and assignments', () => {
    const base = path.resolve('/work/repo');
    const bashForms = [
        ...BASH_COMMIT_FORMS,
        'timeout -s KILL --kill-after=5 60 git commit -m x',
        'nice -n 10 git commit -m x',
        'nice -10 git commit -m x',
        'xargs -I {} -P 2 git commit -m x',
        'stdbuf -oL -e L git commit -m x',
        'sudo -u bob git commit -m x',
        'env -u HOME FOO=1 git commit -m x',
        'time -p git commit -m x',
        'X+=1 git commit -m x',
        '{git commit -m x}',
    ];
    for (const cmd of bashForms) {
        const found = findCommits(cmd, { cwd: base });
        assert.strictEqual(found.length, 1, cmd);
        assert.strictEqual(found[0].cwd, base, cmd);
    }
    const psForms = [
        ...PS_COMMIT_FORMS,
        '$out=git commit -m x',
        'try { git status } finally { git commit -m x }',
        'if ($x) { git status } else {git commit -m x}',
        'If ($x) { git commit -m x }',
    ];
    for (const cmd of psForms) {
        const found = findCommits(cmd, { cwd: base, powershell: true });
        assert.strictEqual(found.length, 1, cmd);
        assert.strictEqual(found[0].cwd, base, cmd);
    }
    // Only words in front of the command are skipped.
    for (const no of ['echo if git commit', 'git log --grep commit', 'for d in git commit', 'git status; ls']) {
        assert.deepStrictEqual(findCommits(no, { cwd: base }), [], no);
    }
    assert.strictEqual(commitFlags(parseSegments('git commit -m do -a')[0].words.slice(2)).all, true);
});

test('findCommits looks inside $(…) and `…`, quoted or not', () => {
    const base = path.resolve('/work/repo');
    assert.deepStrictEqual(parseSegments('x=$(a $(b)) `c` "$(d)" \'$(e)\'')[0].subs, ['a $(b)', 'c', 'd'], 'the outermost ones; none in single quotes');
    for (const cmd of ['echo "$(echo "$(git commit -m x)")"', 'echo "`git commit -m x`"', 'echo $(ls; git commit -m x)', 'echo "$(git commit --dry-run)"']) {
        assert.strictEqual(findCommits(cmd, { cwd: base }).length, 1, cmd);
    }
    assert.strictEqual(findCommits('Write-Output "$(git commit -m x)"', { cwd: base, powershell: true }).length, 1);
    assert.strictEqual(findCommits('git commit -m "$(git log -1 --format=%s)"', { cwd: base }).length, 1, 'a message from git log is one commit');
    // A substitution runs in a subshell: its cd stays in it.
    const [inner, outer] = findCommits('x=$(cd sub && git commit -m a); git commit -m b', { cwd: base });
    assert.strictEqual(inner.cwd, path.join(base, 'sub'));
    assert.strictEqual(outer.cwd, base);
    const [local] = findCommits('cd sub && local v=$(git commit -m x)', { cwd: base });
    assert.strictEqual(local.cwd, path.join(base, 'sub'), 'it runs where the line is at that point');
});

test('findCommits reads the script of bash -c, pwsh -Command, cmd /c and eval', () => {
    const base = path.resolve('/work/repo');
    const sub = path.join(base, 'sub');
    const cases = [
        ["bash -lc 'git commit -m x'", base],
        ["bash -e -o pipefail -c 'git commit -m x'", base],
        ["sh -c -- 'cd sub; git commit -m x'", sub],
        ['pwsh -Command "git commit -m x"', base],
        ['pwsh -NoProfile -c "Set-Location sub; git commit -m x"', sub],
        ['powershell.exe -NoLogo -Command git commit -m x', base],
        ['cmd /c "git commit -m x"', base],
        ['cmd.exe /s //C "cd sub && git commit -m x"', sub],
        ["eval 'cd sub && git commit -m x'", sub],
    ];
    for (const [cmd, cwd] of cases) {
        const found = findCommits(cmd, { cwd: base });
        assert.strictEqual(found.length, 1, cmd);
        assert.strictEqual(found[0].cwd, cwd, cmd);
    }
    const [ps] = findCommits("bash -c 'cd sub; git commit -m x'", { cwd: base, powershell: true });
    assert.strictEqual(ps.cwd, sub, 'from PowerShell, the bash script is still bash');
    assert.strictEqual(findCommits('iex "git commit -m x"', { cwd: base, powershell: true }).length, 1);
    for (const no of ['bash script.sh', 'bash -c', 'pwsh -File build.ps1', 'cmd /c dir']) {
        assert.deepStrictEqual(findCommits(no, { cwd: base }), [], no);
    }
});

test('findCommits: absurd nesting ends in "nothing found", never a stack overflow', () => {
    // A throw here would crash the commit hook, and Claude Code runs the
    // command after a crashed hook: the commit would go through unscanned.
    // Returning no commit hands the line to the hook's git … commit backstop.
    for (const line of [
        '$('.repeat(20000) + 'git commit -m x',
        'echo "$('.repeat(5000) + 'git commit',
        'bash -c '.repeat(3000) + '"git commit"',
    ]) {
        const started = Date.now();
        assert.doesNotThrow(() => findCommits(line, { cwd: os.tmpdir() }));
        assert.ok(Date.now() - started < 2000, 'and it stays fast');
    }
    // Ordinary nesting is still read.
    assert.strictEqual(findCommits('a=$(b=$(c=$(git commit -m x)))', { cwd: os.tmpdir() }).length, 1);
});

test("findCommits: a subshell's cd ends at its ), and pushd/popd keep a stack", () => {
    const base = path.resolve('/work/repo');
    const at = (...p) => path.join(base, ...p);
    const cwds = (cmd, opts = {}) => findCommits(cmd, { cwd: base, ...opts }).map((c) => c.cwd);
    assert.deepStrictEqual(parseSegments('a (b; (c)) d').map((s) => s.scope), [[], [1], [1, 2], []]);
    assert.deepStrictEqual(
        cwds('(cd .claude/worktrees/side && git commit --allow-empty -m wip) && git add -A && git commit -m main'),
        [at('.claude', 'worktrees', 'side'), base],
    );
    assert.deepStrictEqual(cwds('(cd a); (git commit -m x)'), [base], 'a sibling subshell starts afresh');
    assert.deepStrictEqual(cwds('( (cd a && git commit -m x); git commit -m y ); git commit -m z'), [at('a'), base, base]);
    assert.deepStrictEqual(cwds('cd a && (git commit -m x) && git commit -m y'), [at('a'), at('a')]);
    assert.deepStrictEqual(cwds('{ cd a; }; git commit -m x'), [at('a')], 'a { } group is not a subshell');
    assert.deepStrictEqual(cwds('(cd sub); git commit -m x', { powershell: true }), [at('sub')], "PowerShell's ( ) only groups");
    assert.deepStrictEqual(cwds('pushd sub && git commit -m a && popd && git commit -m b'), [at('sub'), base]);
    assert.deepStrictEqual(
        cwds('Push-Location sub; git commit -m a; Pop-Location; git commit -m b', { powershell: true }),
        [at('sub'), base],
    );
    assert.deepStrictEqual(cwds('pushd a; pushd ../b; popd; git commit -m x'), [at('a')]);
    assert.deepStrictEqual(cwds('pushd a; pushd; git commit -m x'), [base], 'a bare pushd swaps the top two');
    assert.deepStrictEqual(cwds('popd; git commit -m x'), [null], 'a popd past this line is unknown');
    assert.deepStrictEqual(cwds('pushd +1; git commit -m x'), [null]);
    assert.deepStrictEqual(cwds('(pushd a); popd; git commit -m x'), [null], 'the subshell took its stack with it');
});

// ── lib/repo.mjs ─────────────────────────────────────────────────────────────

test('resolveRepo: a file in a worktree resolves to that worktree', (t) => {
    const main = makeRepo(tmpdir(t, 'hooks-main-'));
    git(main, 'worktree', 'add', '-q', '-b', 'side', path.join('.claude', 'worktrees', 'side'));
    const wt = path.join(main, '.claude', 'worktrees', 'side');
    const file = path.join(wt, 'src', 'a.js');
    assert.strictEqual(resolveRepo({ filePath: file, cwd: main, projectDir: main }), real(wt));
    assert.strictEqual(resolveRepo({ cwd: path.join(wt, 'src'), projectDir: main }), real(wt));
    assert.strictEqual(resolveRepo({ filePath: path.join(main, 'src', 'a.js'), cwd: wt, projectDir: main }), real(main));
    assert.strictEqual(repoPath(real(wt), file), 'src/a.js');
    assert.strictEqual(repoPath(real(wt), path.join(main, 'src', 'a.js')), null);
});

test('resolveRepo: the wrapper layout resolves to Bee-Flow-AI/ inside it', (t) => {
    const wrapper = tmpdir(t, 'hooks wrapper ');
    const inner = makeRepo(path.join(wrapper, 'Bee-Flow-AI'));
    assert.strictEqual(resolveRepo({ cwd: wrapper, projectDir: wrapper }), real(inner));
    assert.strictEqual(resolveRepo({ filePath: path.join(inner, 'src', 'new', 'file.js'), cwd: wrapper, projectDir: wrapper }), real(inner));
    assert.strictEqual(resolveRepo({ projectDir: wrapper }), real(inner));
});

test('resolveRepo: a repository around the wrapper is not this project', (t) => {
    const outer = makeRepo(tmpdir(t, 'hooks-outer-'));
    const wrapper = path.join(outer, 'Bee Flow - AI');
    const inner = makeRepo(path.join(wrapper, 'Bee-Flow-AI'));
    assert.strictEqual(resolveRepo({ cwd: wrapper, projectDir: wrapper }), real(inner));
});

test('resolveRepo: the cloud layout, and nothing at all', (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-cloud-'));
    assert.strictEqual(resolveRepo({ cwd: path.join(repo, 'src'), projectDir: repo }), real(repo));
    const nowhere = tmpdir(t, 'hooks-none-');
    const before = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(real(nowhere));
    try {
        assert.strictEqual(resolveRepo({ cwd: nowhere, projectDir: undefined }), null);
        assert.strictEqual(resolveRepo({ cwd: nowhere, projectDir: nowhere }), path.resolve(nowhere));
    } finally {
        if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = before;
    }
});

// ── lib/proc.mjs ─────────────────────────────────────────────────────────────

test('classify: a timeout, a signal or an unexpected exit code is never a pass', () => {
    const slow = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 });
    assert.strictEqual(classify(slow).outcome, 'incomplete');
    assert.strictEqual(classify(slow).reason, 'timed out');
    assert.strictEqual(classify({ status: null, signal: 'SIGKILL' }).outcome, 'incomplete');
    assert.strictEqual(classify({ status: null, signal: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }).outcome, 'incomplete');
    assert.strictEqual(classify({ status: 0, signal: null }).outcome, 'passed');
    assert.strictEqual(classify({ status: 1, signal: null }).outcome, 'failed');
    assert.strictEqual(classify({ status: 1, signal: null }, { failCodes: [1] }).outcome, 'failed');
    assert.strictEqual(classify({ status: 127, signal: null }, { failCodes: [1] }).outcome, 'incomplete');
    assert.strictEqual(classify(null).outcome, 'incomplete');
});

test('run: a timeout kills the grandchildren too, and reports', { skip: posixOnly }, async () => {
    const script = [
        "const { spawn } = require('node:child_process');",
        "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
        'console.log(g.pid);',
        'setTimeout(() => {}, 60000);',
    ].join('\n');
    const started = Date.now();
    const res = await run(process.execPath, ['-e', script], { timeoutMs: 500 });
    assert.ok(Date.now() - started < 10_000, 'it does not wait for the grandchild');
    assert.strictEqual(res.timedOut, true);
    assert.strictEqual(classify(res).outcome, 'incomplete');
    const grandchild = Number(res.stdout.trim());
    assert.ok(grandchild > 0, res.stdout);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(isAlive(grandchild), false, 'the grandchild is gone');
});

// Killed counts as gone even when nobody reaps it: in a container whose PID 1
// does not reap orphans, a killed process stays a zombie (state Z).
function isAlive(pid) {
    try {
        return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()[0] !== 'Z';
    } catch (e) {
        if (e.code !== 'ENOENT' || fs.existsSync('/proc/self/stat')) return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// ── pre-commit-secret-scan.mjs ───────────────────────────────────────────────

test('pre-commit hook: a command that does not commit is left alone', (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    write(repo, 'src/leak.js', `const t = "${TOKEN}";\n`);
    for (const cmd of ['ls -la', 'git status', 'git commit --dry-run -m x', 'git commit --dry-run -m "x" && echo git commit']) {
        const res = hook('pre-commit-secret-scan.mjs', bash(cmd, repo), { CLAUDE_PROJECT_DIR: repo });
        assert.strictEqual(res.status, 0, cmd);
        assert.strictEqual(res.stdout, '', cmd);
    }
});

const denial = (res) => {
    const json = res.stdout.trim() ? JSON.parse(res.stdout) : null;
    return json?.hookSpecificOutput?.permissionDecision === 'deny' ? json.hookSpecificOutput.permissionDecisionReason : null;
};
const UNREADABLE_NOTE = /could not find a `git commit` in this command/;

test('pre-commit hook: every form of commit the old regex caught is scanned, and read as a commit', { skip: needsBash }, async (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    write(repo, 'src/new.js', `const t = "${TOKEN}";\n`);
    const env = { CLAUDE_PROJECT_DIR: repo };
    const runs = [
        ...BASH_COMMIT_FORMS.map((command) => ({ command, payload: bash(command, repo) })),
        ...PS_COMMIT_FORMS.map((command) => ({ command, payload: { tool_name: 'PowerShell', tool_input: { command }, cwd: repo } })),
    ];
    const results = await Promise.all(runs.map(({ payload }) => hookAsync('pre-commit-secret-scan.mjs', payload, env)));
    results.forEach((res, k) => {
        const reason = denial(res);
        assert.ok(reason, `${runs[k].command}: ${res.stdout}${res.stderr}`);
        assert.match(reason, /src\/new\.js/, runs[k].command);
        assert.doesNotMatch(reason, UNREADABLE_NOTE, `${runs[k].command}: found by the parser, not the fallback`);
    });
});

test('pre-commit hook: a line that mentions git … commit in a shape it cannot read is scanned anyway', { skip: needsBash }, async (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    write(repo, 'src/new.js', `const t = "${TOKEN}";\n`);
    const env = { CLAUDE_PROJECT_DIR: repo };
    // Fed to bash on stdin, a shell function, and text that only mentions a
    // commit: the last costs a scan, which blocks only on a real finding.
    const commands = ['cat <<EOF | bash\ngit commit -m x\nEOF', 'function f { git commit -m x; }; f', 'git log --grep commit'];
    const results = await Promise.all(commands.map((c) => hookAsync('pre-commit-secret-scan.mjs', bash(c, repo), env)));
    results.forEach((res, k) => {
        const reason = denial(res);
        assert.ok(reason, `${commands[k]}: ${res.stdout}${res.stderr}`);
        assert.match(reason, UNREADABLE_NOTE, commands[k]);
    });
});

test('pre-commit hook: `git add x && git commit` is blocked on a token in x, which is not staged yet', { skip: needsBash }, (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    write(repo, 'src/new.js', `const t = "${TOKEN}";\n`);
    const res = hook('pre-commit-secret-scan.mjs', bash('git add src/new.js && git commit -m "x git commit --dry-run"', repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout + res.stderr);
    const reason = res.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /src\/new\.js/);
    assert.match(reason, /Remove\/rotate the secret/);
    assert.doesNotMatch(reason, /STAGED copy/, 'the working tree holds it too');
    assert.doesNotMatch(reason, UNREADABLE_NOTE);
    assert.ok(!reason.includes(TOKEN.slice(4)), 'never the value');
});

test('pre-commit hook: staged content the working tree no longer has is scanned too, and the denial says how out', { skip: needsBash }, (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    write(repo, 'src/a.js', `const t = "${TOKEN}";\n`);
    git(repo, 'add', 'src/a.js');
    write(repo, 'src/a.js', 'module.exports = 1;\n');
    const env = { CLAUDE_PROJECT_DIR: repo };
    for (const cmd of ['git commit -m fix', 'git add src/a.js && git commit -m fix']) {
        const res = hook('pre-commit-secret-scan.mjs', bash(cmd, repo), env);
        assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, 'deny', cmd + res.stdout + res.stderr);
        const reason = res.json.hookSpecificOutput.permissionDecisionReason;
        assert.match(reason, /--staged/, cmd);
        assert.match(reason, /STAGED copy of a file \(the index\)/, cmd);
        assert.match(reason, /`git add <file>`, or `git restore --staged <file>`/, cmd);
    }
    // -a records the working-tree copy, which is clean: nothing to find.
    const all = hook('pre-commit-secret-scan.mjs', bash('git commit -am fix', repo), env);
    assert.strictEqual(all.stdout, '', all.stderr);
    // …unless another commit on the line records the index as it is.
    const mixed = hook('pre-commit-secret-scan.mjs', bash('git commit -m first; git commit -am second', repo), env);
    assert.strictEqual(mixed.json?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('pre-commit hook: the wrapper layout scans Bee-Flow-AI/ inside it', { skip: needsBash }, (t) => {
    const wrapper = tmpdir(t, 'hooks wrapper ');
    const inner = makeRepo(path.join(wrapper, 'Bee-Flow-AI'), { scanners: true });
    write(inner, 'src/new.js', `const t = "${TOKEN}";\n`);
    const res = hook('pre-commit-secret-scan.mjs', bash('cd Bee-Flow-AI && git add -A && git commit -m x', wrapper), { CLAUDE_PROJECT_DIR: wrapper });
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout + res.stderr);
    const plain = hook('pre-commit-secret-scan.mjs', bash('git commit -m x', wrapper), { CLAUDE_PROJECT_DIR: wrapper });
    assert.strictEqual(plain.json?.hookSpecificOutput?.permissionDecision, 'deny', 'from the wrapper folder itself too');
});

test('pre-commit hook: a commit in a worktree scans that worktree', { skip: needsBash }, (t) => {
    const main = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    git(main, 'worktree', 'add', '-q', '-b', 'side', path.join('.claude', 'worktrees', 'side'));
    const wt = path.join(main, '.claude', 'worktrees', 'side');
    write(main, 'src/main-only.js', `const t = "${TOKEN}";\n`);
    const clean = hook('pre-commit-secret-scan.mjs', bash('git commit -am x', wt), { CLAUDE_PROJECT_DIR: main });
    assert.strictEqual(clean.stdout, '', 'the main checkout is not what this commit records');
    write(wt, 'src/wt.js', `const t = "${TOKEN}";\n`);
    const res = hook('pre-commit-secret-scan.mjs', bash('cd .claude/worktrees/side && git add -A && git commit -m x', main), { CLAUDE_PROJECT_DIR: main });
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout + res.stderr);
    assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /src\/wt\.js/);
});

test("pre-commit hook: a subshell's cd does not carry the next commit into the worktree", { skip: needsBash }, (t) => {
    const main = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    git(main, 'worktree', 'add', '-q', '-b', 'side', path.join('.claude', 'worktrees', 'side'));
    write(main, 'src/main-leak.js', `const t = "${TOKEN}";\n`);
    const cmd = '(cd .claude/worktrees/side && git commit --allow-empty -m wip) && git add -A && git commit -m main';
    const res = hook('pre-commit-secret-scan.mjs', bash(cmd, main), { CLAUDE_PROJECT_DIR: main });
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout + res.stderr);
    assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /src\/main-leak\.js/);
});

test('pre-commit hook: a commit placed in another checkout scans the one the session is in too', { skip: needsBash }, (t) => {
    const main = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    git(main, 'worktree', 'add', '-q', '-b', 'side', path.join('.claude', 'worktrees', 'side'));
    write(main, 'src/main-leak.js', `const t = "${TOKEN}";\n`);
    // The worktree is clean; only the session's own checkout holds a token.
    const res = hook('pre-commit-secret-scan.mjs', bash('cd .claude/worktrees/side && git commit -m x', main), { CLAUDE_PROJECT_DIR: main });
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout + res.stderr);
    const reason = res.json.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /src\/main-leak\.js/);
    assert.match(reason, /--changed \(in [^)\n]+\)/, 'which checkout the finding is in');
});

test('pre-commit hook: steps aside for .githooks, unless the commit skips it', { skip: needsBash || posixOnly }, (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    write(repo, '.githooks/pre-commit', '#!/usr/bin/env bash\nexit 0\n', 0o755);
    git(repo, 'config', 'core.hooksPath', '.githooks');
    write(repo, 'src/new.js', `const t = "${TOKEN}";\n`);
    const quiet = hook('pre-commit-secret-scan.mjs', bash('git add -A && git commit -m x', repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(quiet.stdout, '', 'git runs .githooks/pre-commit after the add');
    const skipped = hook('pre-commit-secret-scan.mjs', bash('git add -A && git commit --no-verify -m x', repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(skipped.json?.hookSpecificOutput?.permissionDecision, 'deny', '--no-verify skips the git hook');
    fs.chmodSync(path.join(repo, '.githooks/pre-commit'), 0o644);
    const notExecutable = hook('pre-commit-secret-scan.mjs', bash('git commit -m x', repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(notExecutable.json?.hookSpecificOutput?.permissionDecision, 'deny', 'git ignores a hook it cannot execute');
});

test('pre-commit hook: a scan that did not finish is reported, not passed', { skip: needsBash || posixOnly }, (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    write(repo, 'scripts/scan-secrets.sh', '#!/usr/bin/env bash\nkill -KILL $$\n');
    write(repo, 'src/new.js', 'module.exports = 2;\n');
    const res = hook('pre-commit-secret-scan.mjs', bash('git add -A && git commit -m x', repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(res.status, 0);
    assert.ok(res.json, 'says something');
    assert.strictEqual(res.json.hookSpecificOutput?.permissionDecision, undefined, 'not a finding, so no deny');
    assert.match(res.json.systemMessage, /NOT fully scanned/);
    assert.match(res.json.systemMessage, /scan-secrets\.sh --changed: killed by SIGKILL/);
    assert.match(res.json.hookSpecificOutput.additionalContext, /not fully scanned/);
});

test('pre-commit hook: a checkout whose scanner predates --changed gets a whole-tree scan', { skip: needsBash }, (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pc-'), { scanners: true });
    write(repo, 'scripts/scan-secrets.sh', [
        '#!/usr/bin/env bash',
        'if [ -n "${1:-}" ]; then echo "usage: $0 [--range <rev>..<rev>]" >&2; exit 2; fi',
        'echo "whole-tree finding: src/a.js:1"; exit 1',
        '',
    ].join('\n'));
    write(repo, 'src/new.js', 'module.exports = 2;\n');
    const res = hook('pre-commit-secret-scan.mjs', bash('git commit -am x', repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(res.json?.hookSpecificOutput?.permissionDecision, 'deny', res.stdout + res.stderr);
    assert.match(res.json.hookSpecificOutput.permissionDecisionReason, /scan-secrets\.sh \(whole tree\)/);
});

// ── push-branch-gate.mjs ─────────────────────────────────────────────────────

/** A repository with a main branch, checked out on `branch`. */
function branchRepo(t, branch) {
    const repo = makeRepo(tmpdir(t, 'hooks-pg-'));
    git(repo, 'checkout', '-q', '-B', 'main');
    if (branch !== 'main') git(repo, 'checkout', '-q', '-b', branch);
    return repo;
}

const gate = (command, cwd) => {
    const res = hook('push-branch-gate.mjs', bash(command, cwd));
    assert.strictEqual(res.status, 0, res.stderr);
    return res.json?.hookSpecificOutput?.permissionDecision ?? 'pass';
};

test('push gate: asks for every shape of push that can reach main', (t) => {
    const repo = branchRepo(t, 'feature-x');
    for (const cmd of [
        'git push origin main',
        'git -C . push origin main',
        '(git push origin main)',
        'bash -c "git push origin main"',
        'git push origin "main"',
        "git push origin 'main'",
        'git push origin main&',
        'git push --repo=origin main',
        "sh -c 'cd app; git push origin main; echo done'",
        'git push origin HEAD:refs/heads/master',
        'git push origin +feature-x:main',
        "git push origin 'refs/heads/*:refs/heads/*'",
        'git push origin "$TARGET"',
        'git -C . push --all origin',
    ]) {
        assert.strictEqual(gate(cmd, repo), 'ask', cmd);
    }
});

test('push gate: a push that names another branch, or none from a feature branch, passes silently', (t) => {
    const repo = branchRepo(t, 'feature-x');
    for (const cmd of [
        'git push origin feature-x',
        'git push -u origin feature-x 2>&1 | tail -5',
        'git push',
        '(git push)',
        'git push origin HEAD',
        'git -C . push origin feature-x',
        'ls',
        'git status',
    ]) {
        assert.strictEqual(gate(cmd, repo), 'pass', cmd);
    }
});

test('push gate: with main checked out, a push that follows the branch asks', (t) => {
    const repo = branchRepo(t, 'main');
    for (const cmd of ['git push', '(git push)', 'git -C . push', 'bash -c "git push"', 'git push origin HEAD 2>&1 | tail -3', 'git push origin @']) {
        assert.strictEqual(gate(cmd, repo), 'ask', cmd);
    }
    assert.strictEqual(gate('git push origin feature-x', repo), 'pass');
    assert.strictEqual(gate('npm test', repo), 'pass');
});

// ── post-edit-test.mjs ───────────────────────────────────────────────────────

function serverRepo(t, testBody) {
    const repo = makeRepo(tmpdir(t, 'hooks-pt-'));
    fs.mkdirSync(path.join(repo, 'server', 'node_modules'), { recursive: true });
    write(repo, 'server/thing.js', 'module.exports = 1;\n');
    write(repo, 'server/thing.test.js', `const test = require('node:test');\nconst assert = require('node:assert');\n${testBody}\n`);
    return repo;
}

const edit = (file, cwd) => ({ tool_name: 'Edit', tool_input: { file_path: file }, cwd });
const NO_TEST_ENV = { NODE_ENV: '', SESSION_SECRET: '', MASTER_ENCRYPTION_KEY: '' };

function withoutTestEnv() {
    const env = { ...process.env };
    for (const k of Object.keys(NO_TEST_ENV)) delete env[k];
    return env;
}

test('post-edit-test: runs the sibling with the server runner\'s env defaults; silent on a pass', (t) => {
    const repo = serverRepo(t, [
        "test('env', () => {",
        "    assert.strictEqual(process.env.NODE_ENV, 'test');",
        '    assert.ok(process.env.SESSION_SECRET && process.env.MASTER_ENCRYPTION_KEY);',
        '});',
    ].join('\n'));
    const res = spawnSync(process.execPath, [path.join(HOOKS, 'post-edit-test.mjs')], {
        input: JSON.stringify(edit(path.join(repo, 'server/thing.js'), repo)),
        encoding: 'utf8',
        env: { ...withoutTestEnv(), CLAUDE_PROJECT_DIR: repo },
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stderr, '');
});

test('post-edit-test: a failing sibling wakes the model with exit 2', (t) => {
    const repo = serverRepo(t, "test('fails', () => assert.strictEqual(1, 2));");
    const res = hook('post-edit-test.mjs', edit(path.join(repo, 'server/thing.js'), repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /Sibling test failed \(node --test\) — thing\.test\.js/);
});

test('post-edit-test: a newer run of the same test supersedes an older one', async (t) => {
    const repo = serverRepo(t, "test('slow and failing', async () => { await new Promise((r) => setTimeout(r, 3000)); assert.fail('stale'); });");
    const payload = edit(path.join(repo, 'server/thing.js'), repo);
    const env = { CLAUDE_PROJECT_DIR: repo };
    const older = hookAsync('post-edit-test.mjs', payload, env);
    await new Promise((r) => setTimeout(r, 800));
    const newer = hookAsync('post-edit-test.mjs', payload, env);
    const [a, b] = await Promise.all([older, newer]);
    assert.strictEqual(a.status, 0, `the older run is dropped silently\n${a.stderr}`);
    assert.strictEqual(a.stderr, '');
    assert.strictEqual(b.status, 2, 'the newer one reports');
});

test('post-edit-test: a package without node_modules (a fresh worktree) is skipped', (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pt-'));
    write(repo, 'server/thing.js', 'module.exports = 1;\n');
    write(repo, 'server/thing.test.js', "require('node:test')('x', () => { throw new Error('ran'); });\n");
    const res = hook('post-edit-test.mjs', edit(path.join(repo, 'server/thing.js'), repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(res.status, 0, res.stderr);
});

// ── post-edit-lint.mjs ───────────────────────────────────────────────────────

// A stand-in eslint that echoes its arguments and returns canned messages.
function fakeEslint(repo, pkg, messages, status) {
    const result = JSON.stringify([{ filePath: 'x', messages }]);
    write(repo, `${pkg}/node_modules/eslint/bin/eslint.js`, [
        "const args = process.argv.slice(2);",
        "if (args.includes('--fix')) { console.log('  1:1  error  still broken  no-undef'); process.exit(1); }",
        `const result = ${JSON.stringify(result)};`,
        "console.log(result.replace('ARGS', args.join(' ')));",
        `process.exit(${status});`,
        '',
    ].join('\n'));
}

test('post-edit-lint: server reports errors and warnings from its own eslint, without --fix', (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pl-'));
    fakeEslint(repo, 'server', [
        { ruleId: 'no-undef', severity: 2, message: "'x' is not defined ARGS", line: 3, column: 5 },
        { ruleId: 'no-unused-vars', severity: 1, message: "'y' is unused", line: 4, column: 1 },
    ], 1);
    const file = write(repo, 'server/core/thing.js', 'x;\n');
    const res = hook('post-edit-lint.mjs', edit(file, repo), { CLAUDE_PROJECT_DIR: repo });
    const ctx = res.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /1 error\(s\), 1 warning\(s\) in server\/core\/thing\.js/);
    // The path is relative to the package: eslint ignores an absolute one that
    // reaches the file through a symlink ("outside of base path").
    assert.match(ctx, /3:5 {2}error {4}'x' is not defined -f json --no-warn-ignored core\/thing\.js {2}\(no-undef\)/);
    assert.match(ctx, /warning budget is 0/);
    assert.ok(!ctx.includes('--fix'));
});

test('post-edit-lint: mobile reports errors only; agent-hub keeps eslint --fix', (t) => {
    const repo = makeRepo(tmpdir(t, 'hooks-pl-'));
    fakeEslint(repo, 'mobile', [{ ruleId: 'no-console', severity: 1, message: 'console', line: 1, column: 1 }], 0);
    const warnOnly = hook('post-edit-lint.mjs', edit(write(repo, 'mobile/src/a.tsx', 'x;\n'), repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(warnOnly.stdout, '', 'mobile CI passes warnings');

    fakeEslint(repo, 'agent-hub', [], 0);
    const fixed = hook('post-edit-lint.mjs', edit(write(repo, 'agent-hub/src/b.ts', 'x;\n'), repo), { CLAUDE_PROJECT_DIR: repo });
    assert.match(fixed.json?.hookSpecificOutput?.additionalContext || '', /still reports issues in b\.ts after --fix/);

    const elsewhere = hook('post-edit-lint.mjs', edit(write(repo, 'docs/c.js', 'x;\n'), repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(elsewhere.stdout, '');
    const noDeps = hook('post-edit-lint.mjs', edit(write(repo, 'server/d.js', 'x;\n'), repo), { CLAUDE_PROJECT_DIR: repo });
    assert.strictEqual(noDeps.stdout, '', 'no server/node_modules/eslint: skipped');
});
