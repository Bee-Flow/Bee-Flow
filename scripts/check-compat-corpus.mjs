#!/usr/bin/env node
/**
 * check-compat-corpus — the App Studio compatibility corpus only grows.
 *
 *   node scripts/check-compat-corpus.mjs                 against the merge-base with origin/main
 *   node scripts/check-compat-corpus.mjs --base <rev>    against <rev> (CI: the pull request's base)
 *
 * server/appStudio/compat/corpus/*.json are stored apps as they exist today, and
 * server/appStudio/compat/frozen/*.json what today's code does with them (canonical bytes,
 * validator findings, step ordinals, public definition, compiled SQL). The compat tests next to
 * them prove a change leaves existing apps alone; that proof is worth nothing if the same pull
 * request can rewrite the corpus or its expectations to match the new behaviour. So this gate
 * FAILS when a file under either directory that exists at the base is modified, deleted,
 * renamed or changes type, committed or not. Adding a file is allowed: that is how a later
 * change brings its own example (server/appStudio/compat/README.md).
 *
 * "Since the base" is `git diff <base>` against the working tree, renames split into a delete
 * and an add, so uncommitted edits count too. Without --base and without an origin/main that
 * has a merge-base with HEAD (a shallow CI checkout), the gate says so and exits 0; ci.yml's
 * server-checks job runs it with the PR base.
 *
 * Zero dependencies: node:* plus the `git` binary. Exit 0 pass or skip, 1 fail, 2 usage.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GUARDED_DIRS = ['server/appStudio/compat/corpus/', 'server/appStudio/compat/frozen/'];

/** Is this repo-relative path a corpus input or a frozen expectation? */
export function isGuarded(file) {
    return GUARDED_DIRS.some((dir) => file.startsWith(dir));
}

/**
 * `git diff --name-status -z` output → [{ status, file }]. Status letters: A added, D deleted,
 * M modified, T type changed (renames are split by --no-renames, so R never appears).
 */
export function parseNameStatus(output) {
    const parts = String(output).split('\0').filter((p) => p !== '');
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i].charAt(0), file: parts[i + 1] });
    return out;
}

/** The changes that break the rule: anything to a guarded file other than adding it. */
export function violations(changes) {
    return changes.filter((c) => isGuarded(c.file) && c.status !== 'A');
}

function git(args, cwd) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return res.status === 0 ? res.stdout : null;
}

/** The merge-base of HEAD with origin/main, or null when this clone has none. */
export function defaultBase(cwd = ROOT) {
    if (git(['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], cwd) === null) return null;
    const base = git(['merge-base', 'HEAD', 'origin/main'], cwd);
    return base ? base.trim() : null;
}

/** Changes to the guarded directories since `base`, working tree included. */
export function changesSince(base, cwd = ROOT) {
    const out = git(['diff', '--name-status', '--no-renames', '-z', base, '--', ...GUARDED_DIRS], cwd);
    if (out === null) throw new Error(`git diff against ${base} failed (is the base fetched?)`);
    return parseNameStatus(out);
}

const WORD = { D: 'deleted', M: 'modified', T: 'changed type' };

function report(bad, base, log) {
    log.error(`check-compat-corpus: ${bad.length} existing corpus file(s) changed since ${base}:\n`);
    for (const c of bad) log.error(`  ${WORD[c.status] ?? c.status}  ${c.file}`);
    log.error(`
The corpus is the record of how apps that already exist are stored and behave. A change that
needs a different canonical form, validator result, step numbering, public definition or SQL
for one of them changes an app someone is running: put the corpus file back as it was on main
and make the change leave it alone (new behaviour behind something only new apps use), or take
it to the owner. A new example is a NEW file (server/appStudio/compat/README.md).`);
}

export function main(argv = process.argv.slice(2), cwd = ROOT, log = console) {
    const at = argv.indexOf('--base');
    if (at !== -1 && (!argv[at + 1] || argv[at + 1].startsWith('--'))) {
        log.error('usage: node scripts/check-compat-corpus.mjs [--base <rev>]');
        return 2;
    }
    const base = at !== -1 ? argv[at + 1] : defaultBase(cwd);
    if (!base) {
        log.log('check-compat-corpus: SKIP, no origin/main merge-base in this clone (CI runs it with the PR base)');
        return 0;
    }
    const changes = changesSince(base, cwd);
    const bad = violations(changes);
    if (bad.length) {
        report(bad, base, log);
        return 1;
    }
    const added = changes.filter((c) => c.status === 'A').length;
    log.log(`check-compat-corpus: no existing corpus file changed since ${base.slice(0, 12)}${added ? ` (${added} added)` : ''}`);
    return 0;
}

if (isEntryPoint(import.meta.url)) {
    try {
        process.exitCode = main();
    } catch (e) {
        console.error(`check-compat-corpus: ${e.message}`);
        process.exitCode = 1;
    }
}
