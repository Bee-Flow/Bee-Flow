#!/usr/bin/env node
// PreToolUse (Bash|PowerShell) — when the command makes a git commit, run the
// repo's own secret scanners over what that commit can contain and BLOCK it
// on a finding.
//
// Which commands commit: lib/commands.mjs splits the line on its separators
// outside quotes and reads git's arguments, so a `--dry-run` in a message
// does not skip a scan. It errs toward scanning where it cannot be sure: a
// line it finds no commit in at all but that says `git … commit` somewhere
// (`cat <<EOF | bash`, a shell function, a commit message) is scanned as a
// commit in the session's directory. Only a line whose every commit is a
// real `--dry-run` is let through unscanned.
//
// What it scans: the files that differ from HEAD plus the untracked ones
// (`--changed`), not just the index. This hook runs BEFORE the command, so in
// `git add x && git commit` the file x is not staged yet. When the index holds
// content the working tree no longer has, the staged blobs are scanned too —
// unless every commit is `git commit -a`, which records the working-tree
// copies instead.
//
// Where: the checkout each commit runs in, after the line's cd/pushd/-C. When
// that is not the checkout the session starts in, that one is scanned as
// well, so a misread cd cannot leave the checkout actually committed
// unscanned.
//
// When git's own hook is on for the checkout (core.hooksPath = .githooks), it
// scans the index right after the `git add`, so this one stays out of the way
// — unless the commit passes --no-verify or overrides core.hooksPath.
//
// Only a finding blocks. A scan that could not finish (no bash, a timeout, a
// crash) does not pass silently: the user and the model are both told the
// commit was not fully scanned, and why.

import { existsSync, accessSync, realpathSync, constants } from 'node:fs';
import path from 'node:path';
import { findCommits } from './lib/commands.mjs';
import { readEvent } from './lib/event.mjs';
import { resolveRepo, isDirectory, isStrictAncestor, git } from './lib/repo.mjs';
import { run, classify, plain } from './lib/proc.mjs';

// settings.json gives this hook 130 s. Each scan gets at most PER_SCAN_MS and
// all of them together BUDGET_MS, so the hook always answers before Claude
// Code gives up on it.
const PER_SCAN_MS = 45_000;
const BUDGET_MS = 110_000;

const BASH = ['bash', 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'];
const SCANNERS = ['scripts/check-no-test-secrets.sh', 'scripts/scan-secrets.sh'];

const input = readEvent();
if (!input) process.exit(0);

const command = String(input.tool_input?.command || '');
// A parser that throws must not end this hook: Claude Code treats a crashed
// hook as a non-blocking error and runs the command, commit and all.
let parsed = [];
let parseFailed = false;
try {
  parsed = findCommits(command, {
    cwd: input.cwd || process.cwd(),
    powershell: input.tool_name === 'PowerShell',
  });
} catch {
  parseFailed = true;
}
// No commit found, yet the line says `git … commit`: a shape the parser
// cannot read. Scan it as a commit where the session is, and assume it skips
// git's own hook, since nothing says it does not.
const unreadable = (parseFailed || parsed.length === 0) && /\bgit\b[\s\S]*\bcommit\b/i.test(command);
const commits = unreadable
  ? [{ cwd: null, dryRun: false, noVerify: true, all: false, hooksPathOverride: false }]
  : parsed.filter((c) => !c.dryRun);
if (commits.length === 0) process.exit(0);

const deadline = Date.now() + BUDGET_MS;
const projectDir = process.env.CLAUDE_PROJECT_DIR;
const findings = [];
const unscanned = [];

// Is .githooks/pre-commit going to run for this commit anyway?
function gitHookScans(repo) {
  const value = git(repo, ['config', '--get', 'core.hooksPath']);
  if (!value) return false;
  const own = path.join(repo, '.githooks');
  const hook = path.join(own, 'pre-commit');
  if (!existsSync(hook) || !samePath(path.resolve(repo, value), own)) return false;
  if (process.platform === 'win32') return true;
  try {
    accessSync(hook, constants.X_OK);
    return true;
  } catch {
    return false; // git skips a hook that is not executable
  }
}

function samePath(a, b) {
  try {
    const [x, y] = [realpathSync(a), realpathSync(b)];
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch {
    return false;
  }
}

// Paths whose staged content differs from the working tree's; --changed reads
// the working tree, so those need --staged as well. Unknown counts as yes.
function indexDiffersFromWorktree(repo) {
  const staged = git(repo, ['diff', '--cached', '--name-only', '-z']);
  if (staged === null) return true;
  if (!staged) return false;
  const unstaged = git(repo, ['diff', '--name-only', '-z']);
  if (unstaged === null) return true;
  const changed = new Set(unstaged.split('\0').filter(Boolean));
  return staged.split('\0').some((p) => changed.has(p));
}

async function scan(repo, script, flag) {
  for (const bash of BASH) {
    const left = deadline - Date.now();
    if (left < 1000) return { res: null, reason: 'the hook ran out of time before this scan' };
    const res = await run(bash, [script, flag], { cwd: repo, timeoutMs: Math.min(PER_SCAN_MS, left) });
    if (res.error?.code === 'ENOENT') continue;
    // A checkout from before --changed/--staged answers with its usage
    // line; scan its whole tree the way it knows instead.
    if (res.status === 2 && /usage:/.test(res.stderr + res.stdout)) {
      const rest = Math.min(PER_SCAN_MS, deadline - Date.now());
      return { res: rest > 1000 ? await run(bash, [script], { cwd: repo, timeoutMs: rest }) : null, flag: '(whole tree)' };
    }
    return { res };
  }
  return { res: null, reason: `bash was not found (tried ${BASH.join(', ')})` };
}

// Per checkout: does any commit skip git's own hook, and does every one
// stage all it records itself (-a)?
const repos = new Map();
function note(repo, { bypassed, stagesAll }) {
  const key = repo || '';
  const seen = repos.get(key);
  repos.set(key, {
    ownHookBypassed: Boolean(seen?.ownHookBypassed || bypassed),
    stagesAll: (seen ? seen.stagesAll : true) && stagesAll,
  });
}

// A commit whose directory is unknown (cd "$X") runs where the session is,
// as far as this hook can tell.
const home = resolveRepo({ cwd: input.cwd, projectDir });
let elsewhere = false;
for (const c of commits) {
  const repo = c.cwd && isDirectory(c.cwd) ? resolveRepo({ cwd: c.cwd, projectDir }) : home;
  if (repo !== home) elsewhere = true;
  note(repo, { bypassed: c.noVerify || c.hooksPathOverride, stagesAll: c.all });
}
// A commit placed in another checkout scans the session's checkout too: the
// cd that put it there may have been misread (a subshell, a function, a
// PowerShell scope). Git's own hook counts as skipped if any commit skips it.
if (elsewhere && home) {
  note(home, { bypassed: commits.some((c) => c.noVerify || c.hooksPathOverride), stagesAll: false });
}

for (const [repo, { ownHookBypassed, stagesAll }] of repos) {
  if (!repo) {
    unscanned.push('could not work out which git checkout the commit is in');
    continue;
  }
  const scripts = SCANNERS.filter((s) => existsSync(path.join(repo, s)));
  if (scripts.length === 0) {
    // Another repository has no scanners to run; this project always has them.
    const ours = projectDir && (path.resolve(repo) === path.resolve(projectDir) || isStrictAncestor(projectDir, repo));
    if (ours) unscanned.push(`${repo} has no scripts/scan-secrets.sh`);
    continue;
  }
  if (!ownHookBypassed && gitHookScans(repo)) continue;

  // `git commit -a` records the working tree's copy of every tracked file,
  // which --changed reads; what the index held before is not committed.
  const flags = !stagesAll && indexDiffersFromWorktree(repo) ? ['--changed', '--staged'] : ['--changed'];
  const where = repos.size > 1 ? ` (in ${repo})` : '';
  for (const flag of flags) {
    for (const script of scripts) {
      const { res, reason, flag: ran = flag } = await scan(repo, script, flag);
      const name = `${path.basename(script)} ${ran}`;
      if (!res) {
        unscanned.push(`${name}${where}: ${reason || 'the hook ran out of time'}`);
        continue;
      }
      const verdict = classify(res, { failCodes: [1] });
      const output = plain((res.stdout || '') + (res.stderr || '')).trim();
      if (verdict.outcome === 'failed') findings.push({ flag: ran, text: `\n$ ${name}${where}\n${output}` });
      else if (verdict.outcome === 'incomplete') {
        const why = res.timedOut ? `did not finish in ${Math.round(res.ms / 1000)} s` : verdict.reason;
        unscanned.push(`${name}${where}: ${why}${output ? ` — ${output.split('\n').slice(-3).join(' / ')}` : ''}`);
      }
    }
  }
}

if (findings.length) {
  const also = unscanned.length ? `\n\nAlso not fully scanned: ${unscanned.join('; ')}` : '';
  const notes = [];
  if (unreadable) {
    notes.push('The hook could not find a `git commit` in this command, but it mentions one, so it was scanned as a commit.');
  }
  // Only the index holds it: the retry that fixed the file is refused too
  // until the clean copy is staged, which this hook, running before the
  // command, cannot see happen in `git add x && git commit`.
  if (findings.every((f) => f.flag === '--staged')) {
    notes.push(
      'Every finding is in the STAGED copy of a file (the index), which is what `git commit` records; the working-tree copy is clean. ' +
        'If you already removed the secret from the file, stage the clean version in a SEPARATE command first ' +
        '(`git add <file>`, or `git restore --staged <file>` to unstage it), then commit. ' +
        'This hook runs before the command, so `git add <file> && git commit` in one command still sees the old index.',
    );
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Secret scan failed — commit blocked.\n' +
          findings.map((f) => f.text).join('').slice(0, 6000) +
          also.slice(0, 1000) +
          '\n\nRemove/rotate the secret, or move test fixtures into a *.test.js / __tests__/ file, then retry.' +
          notes.map((n) => `\n\n${n}`).join(''),
      },
    }),
  );
  process.exit(0);
}

if (unscanned.length) {
  const why = unscanned.join('; ').slice(0, 2000);
  process.stdout.write(
    JSON.stringify({
      systemMessage: `secret-scan hook: this commit was NOT fully scanned — ${why}`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `The pre-commit secret scan did not complete, so this commit was not fully scanned for secrets (${why}). ` +
          'Before pushing, run `bash scripts/check-no-test-secrets.sh --changed` and `bash scripts/scan-secrets.sh --changed` ' +
          'from the repository root and check that both pass.',
      },
      suppressOutput: true,
    }),
  );
}

process.exit(0);
