#!/usr/bin/env node
// PostToolUse (Edit|Write) — lint the file that was just changed, with the eslint
// of its own package. Runs eslint's JS entry directly via node (no shell, no
// npx.cmd) so paths with spaces and Windows resolution both just work. Problems
// are fed back to the model as context; everything outside the three packages
// below, or in a package without node_modules (a fresh worktree), is a no-op.
//
//   agent-hub/  *.{ts,tsx,js,jsx,mjs,cjs}  eslint --fix, then report what is left
//   server/     *.{js,cjs,mjs}              report errors AND warnings, no --fix:
//                                           server's warning budget is 0
//                                           (server/.eslint-budget.json), so one
//                                           warning fails CI as surely as an error
//   mobile/     *.{ts,tsx,js,jsx}           report errors, no --fix: `npm run lint`
//                                           has no --max-warnings, so CI passes
//                                           warnings
//
// The checkout is the edited file's own (lib/repo.mjs), so a worktree under
// .claude/worktrees/ is linted with its own config.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { readEvent, editedFile } from './lib/event.mjs';
import { repoPath } from './lib/repo.mjs';
import { run, plain } from './lib/proc.mjs';

const TIMEOUT_MS = 25_000; // settings.json allows 30 s

const edited = editedFile(readEvent());
if (!edited) process.exit(0);
const { file, repo } = edited;
const rel = repoPath(repo, file);
if (!rel) process.exit(0);

const PACKAGES = [
  { dir: 'agent-hub', files: /\.(ts|tsx|js|jsx|mjs|cjs)$/, fix: true },
  { dir: 'server', files: /\.(js|cjs|mjs)$/, warnings: true },
  { dir: 'mobile', files: /\.(ts|tsx|js|jsx)$/, warnings: false },
];
const pkg = PACKAGES.find((p) => rel.startsWith(`${p.dir}/`) && p.files.test(rel));
if (!pkg) process.exit(0);

const pkgDir = path.join(repo, pkg.dir);
const eslintBin = path.join(pkgDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
if (!existsSync(eslintBin)) process.exit(0); // deps not installed → skip

function tell(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
      suppressOutput: true,
    }),
  );
  process.exit(0);
}

// Relative to the package, which is eslint's cwd: an absolute path that
// reaches the file through a symlink lies outside eslint's base path and is
// ignored without a word.
const target = rel.slice(pkg.dir.length + 1);
const args = pkg.fix ? [eslintBin, '--fix', target] : [eslintBin, '-f', 'json', '--no-warn-ignored', target];
const res = await run(process.execPath, args, { cwd: pkgDir, timeoutMs: TIMEOUT_MS });
const out = plain((res.stdout || '') + (res.stderr || '')).trim();

if (res.timedOut) tell(`eslint did not finish on ${rel} within ${TIMEOUT_MS / 1000} s, so its lint status is unknown.`);

if (pkg.fix) {
  if (res.status && out) tell(`eslint still reports issues in ${path.basename(file)} after --fix:\n${out.slice(0, 4000)}`);
  process.exit(0);
}

let messages;
try {
  messages = JSON.parse(res.stdout).flatMap((r) => r.messages || []);
} catch {
  // Not JSON: eslint itself failed (a config error, a crash).
  if (res.status && out) tell(`eslint could not lint ${rel}:\n${out.slice(0, 2000)}`);
  process.exit(0);
}

const shown = messages.filter((m) => m.severity === 2 || (pkg.warnings && m.severity === 1));
if (shown.length === 0) process.exit(0);

const errors = shown.filter((m) => m.severity === 2).length;
const warnings = shown.length - errors;
const counts = [errors && `${errors} error(s)`, warnings && `${warnings} warning(s)`].filter(Boolean).join(', ');
const why = warnings ? ` (${pkg.dir}'s eslint warning budget is 0, so a warning fails CI too)` : '';
const lines = shown
  .slice(0, 40)
  .map((m) => `  ${m.line ?? 0}:${m.column ?? 0}  ${m.severity === 2 ? 'error  ' : 'warning'}  ${m.message}${m.ruleId ? `  (${m.ruleId})` : ''}`);
tell(`eslint: ${counts} in ${rel}${why}:\n${lines.join('\n')}`.slice(0, 4000));
