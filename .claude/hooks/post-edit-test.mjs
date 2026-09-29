#!/usr/bin/env node
// PostToolUse (Edit|Write), async + asyncRewake — when an edited source file has a
// colocated sibling test, run just that test in the background. On failure the hook
// exits 2, which wakes the model with the failure output; on success it's silent.
// Backend → `node --test x.test.js`; frontend → vitest run on the sibling spec.
//
// The checkout is the edited file's own (lib/repo.mjs), so a worktree under
// .claude/worktrees/ runs its own tests, and a package without node_modules
// there is skipped rather than reported as a failure.
//
// A run that does not finish is reported too ("did not finish … (HUNG?)"):
// silence would read as a pass. A result is dropped when a newer edit started a
// newer run of the same test, which will report for itself. That check is a
// marker file rather than the file's mtime, because post-edit-lint's
// `eslint --fix` rewrites agent-hub files while this runs, and an mtime
// check would throw away every failure that coincides with a fix.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readEvent, editedFile } from './lib/event.mjs';
import { repoPath } from './lib/repo.mjs';
import { run, classify, plain } from './lib/proc.mjs';

const TIMEOUT_MS = 120_000; // settings.json allows 130 s

const edited = editedFile(readEvent());
if (!edited) process.exit(0);
const { file, repo } = edited;

// Resolve the test file to run: the edited file itself if it's a test, else a
// colocated X.test.<ext> / X.spec.<ext> sibling (trying a couple of extensions).
function resolveTest(f) {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) return f;
  const m = f.match(/^(.*)\.([cm]?[jt]sx?)$/);
  if (!m) return null;
  const stem = m[1];
  const exts = [m[2], 'ts', 'tsx', 'js', 'jsx'];
  for (const kind of ['test', 'spec']) {
    for (const ext of exts) {
      const cand = `${stem}.${kind}.${ext}`;
      if (existsSync(cand)) return cand;
    }
  }
  return null;
}

const test = resolveTest(file);
if (!test) process.exit(0);
const rel = repoPath(repo, test);
if (!rel) process.exit(0);

// The same throwaway values server/scripts/run-tests.mjs gives its children
// (and the server job in ci.yml): the crypto/session modules refuse to load
// without them. Only under NODE_ENV=test and only when unset.
// NODE_TEST_CONTEXT goes: a `node --test` that inherits it from an outer test
// run reports to that run instead and exits 0, failures and all.
function serverTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (!env.NODE_ENV) env.NODE_ENV = 'test';
  if (env.NODE_ENV === 'test') {
    // The same throwaway value ci.yml's server job sets; not a credential.
    env.SESSION_SECRET ??= 'ci-session-secret-value-at-least-32-chars-long'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
    env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';
  }
  return env;
}

// Claim "latest run of this test"; the returned check says whether a newer
// run has claimed it since. Without a writable temp dir, nothing is dropped.
function claimLatestRun(testFile) {
  const key = createHash('sha256').update(path.resolve(testFile)).digest('hex').slice(0, 20);
  const marker = path.join(os.tmpdir(), 'claude-post-edit-test', key);
  const runId = randomUUID();
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, runId);
  } catch {
    return () => false;
  }
  return () => {
    try {
      return readFileSync(marker, 'utf8') !== runId;
    } catch {
      return false;
    }
  };
}

// The test path relative to its package, which is also the runner's cwd.
// Both runners match an absolute path against their own (real) root, so a
// path through a symlink or with a differently spelled drive finds nothing.
const inPackage = (dir) => rel.slice(dir.length + 1);

let spawnArgs;
let label;

if (rel.startsWith('server/') && /\.[cm]?jsx?$/.test(rel)) {
  const serverDir = path.join(repo, 'server');
  if (!existsSync(path.join(serverDir, 'node_modules'))) process.exit(0); // deps not installed → skip
  spawnArgs = [process.execPath, ['--test', inPackage('server')], { cwd: serverDir, env: serverTestEnv() }];
  label = 'node --test';
} else if (rel.startsWith('agent-hub/')) {
  const agentHub = path.join(repo, 'agent-hub');
  const candidates = [
    path.join(agentHub, 'node_modules', 'vitest', 'vitest.mjs'),
    path.join(agentHub, 'node_modules', 'vitest', 'dist', 'cli.js'),
  ];
  const vitestBin = candidates.find(existsSync);
  if (!vitestBin) process.exit(0); // deps not installed → skip
  spawnArgs = [process.execPath, [vitestBin, 'run', inPackage('agent-hub')], { cwd: agentHub }];
  label = 'vitest';
} else {
  process.exit(0);
}

const superseded = claimLatestRun(path.join(repo, rel));
const [cmd, args, opts] = spawnArgs;
const res = await run(cmd, args, { ...opts, timeoutMs: TIMEOUT_MS });
const verdict = classify(res, { failCodes: [1] });

if (verdict.outcome === 'passed' || superseded()) process.exit(0);

const out = plain((res.stdout || '') + (res.stderr || '')).trim().slice(-4000);
const name = path.basename(test);
if (verdict.outcome === 'failed') {
  process.stderr.write(`Sibling test failed (${label}) — ${name}:\n${out}\n`);
} else if (res.timedOut) {
  process.stderr.write(
    `Sibling test did not finish in ${Math.round(TIMEOUT_MS / 1000)} s (HUNG?) (${label}) — ${name}. ` +
      `Something keeps it running: an open handle, a timer, a server that never closes. Output so far:\n${out}\n`,
  );
} else {
  process.stderr.write(`Sibling test run did not complete (${label}, ${verdict.reason}) — ${name}:\n${out}\n`);
}
process.exit(2); // asyncRewake: surface it to the model
