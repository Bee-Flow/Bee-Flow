#!/usr/bin/env node
/**
 * i18n-key-guard — no English key disappears without saying so.
 *
 *   node scripts/i18n-key-guard.mjs --base <git-ref>
 *
 * Loads the English dictionary (GUI_DEFAULTS) as it is at <git-ref> and as it
 * is in the working tree, and FAILS listing every key that exists at the base
 * but not now — unless that key is listed in
 * server/i18n/defaults/removed-keys.txt (one key per line, `#` comments).
 *
 * Why: the dictionary is appended to by many branches at once, and a merge in
 * which "the second wins" drops the first branch's keys WITHOUT a conflict git
 * would show. Every other i18n check starts from a key that is in use and asks
 * whether it exists, so a key that vanished together with nothing — or
 * together with the code of a branch that still has it — is invisible to them.
 * This check looks from the other side: what was there, and is gone.
 *
 * The base is read with `git archive <ref>`, extracted to a temporary
 * directory and required from there, so it works whatever layout the base
 * has: the old monolithic en.js or the per-namespace en/ directory (en.js is a
 * re-export of en/index.js there). The archive holds server/i18n/defaults, the
 * resolver (server/moduleRoots.cjs, server/modules/roots/) and every
 * modules/<id>/server/i18n/defaults the base has, because a module keeps its
 * namespace files in its own root. Keys are compared by key, never by file: a
 * namespace file that moved from server/ to a module loses nothing. Each
 * dictionary is loaded in a child process, so the two copies of the resolver
 * never meet, and without core mode (BEEFLOW_HIDE_MODULES), so a hidden module
 * does not look like lost keys. In CI the ref is the pull request's base
 * commit; fetch it first if the checkout is shallow.
 *
 * Zero dependencies: node:* plus the `git` and `tar` binaries.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS_REL = 'server/i18n/defaults';
const ALLOW_FILE = path.join(ROOT, DEFAULTS_REL, 'removed-keys.txt');
const RESOLVER_REL = 'server/moduleRoots.cjs';
const RESOLVER_DIR_REL = 'server/modules/roots/';
const MODULES_REL = 'modules';
const MODULE_DEFAULTS = 'server/i18n/defaults';
const MAX_BUFFER = 256 * 1024 * 1024;

/** Run in the child: require the resolver (when given) and the dictionary, print its keys. */
const KEYS_SCRIPT = `
const [entry, resolver] = process.argv.slice(1);
if (resolver) require(resolver);
const { GUI_DEFAULTS } = require(entry);
if (!GUI_DEFAULTS || typeof GUI_DEFAULTS !== 'object') throw new Error(entry + ' exports no GUI_DEFAULTS');
process.stdout.write(JSON.stringify(Object.keys(GUI_DEFAULTS)));
`;

function usage(msg) {
    if (msg) console.error(`i18n-key-guard: ${msg}`);
    console.error('usage: node scripts/i18n-key-guard.mjs --base <git-ref>');
    return 2;
}

/**
 * Of the files git lists at the base, the ones the archive needs besides
 * server/i18n/defaults: the resolver, and the dictionary files of every module root.
 * @param {string[]} files repository paths, forward slashes
 * @returns {string[]}
 */
export function archiveExtras(files) {
    /** modules/<id>/server/i18n/defaults/... */
    const inModuleDefaults = (f) => {
        const parts = f.split('/');
        return parts.length > 5 && parts[0] === MODULES_REL && parts.slice(2, 5).join('/') === MODULE_DEFAULTS;
    };
    return files.filter((f) => f === RESOLVER_REL || f.startsWith(RESOLVER_DIR_REL) || inModuleDefaults(f));
}

/** The repository paths to archive at `base`. Throws (with git's stderr) when git cannot read it. */
function archivePaths(base) {
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', base, '--', RESOLVER_REL, RESOLVER_DIR_REL, MODULES_REL], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return [DEFAULTS_REL, ...archiveExtras(listed.split('\n').filter(Boolean))];
}

/**
 * The keys of GUI_DEFAULTS in a checkout (or an extracted archive), whichever layout it has.
 * @param {string} checkout the directory that holds server/
 * @param {Record<string, string>} rootsEnv where the module roots are, for the child
 */
function loadKeys(checkout, rootsEnv) {
    const defaultsDir = path.join(checkout, DEFAULTS_REL);
    const candidates = [path.join(defaultsDir, 'en.js'), path.join(defaultsDir, 'en', 'index.js')];
    const entry = candidates.find((f) => fs.existsSync(f));
    if (!entry) throw new Error(`no English dictionary under ${defaultsDir}`);
    const resolver = path.join(checkout, RESOLVER_REL);
    const args = ['-e', KEYS_SCRIPT, entry, ...(fs.existsSync(resolver) ? [resolver] : [])];
    const env = { ...process.env, ...rootsEnv };
    delete env.BEEFLOW_HIDE_MODULES;
    try {
        return JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
        const lines = String(e.stderr || e.message).trim().split('\n').filter((l) => l.startsWith('Error') || l.includes('Error:'));
        throw new Error(`cannot load ${path.relative(checkout, entry)}: ${lines[0] || String(e.message)}`);
    }
}

export function readAllowList(file) {
    if (!fs.existsSync(file)) return new Set();
    return new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean));
}

/** Extract the dictionary of `base` into `tmp`; a usage error (2) when git cannot read it. */
function extractBase(base, tmp) {
    let archive;
    try {
        archive = execFileSync('git', ['archive', '--format=tar', base, ...archivePaths(base)], {
            cwd: ROOT, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e) {
        console.error(`i18n-key-guard: cannot read ${DEFAULTS_REL} at ${base}: ${String(e.stderr || e.message).trim()}`);
        console.error('In a shallow clone, fetch the base first: git fetch --no-tags --depth=1 origin <sha>');
        return 2;
    }
    execFileSync('tar', ['-x', '-C', tmp], { input: archive });
    return 0;
}

/**
 * @param {string} base
 * @param {string[]} before keys at the base
 * @param {string[]} nowKeys keys now
 */
function report(base, before, nowKeys) {
    const now = new Set(nowKeys);
    const allowed = readAllowList(ALLOW_FILE);
    const gone = before.filter((k) => !now.has(k));
    const missing = gone.filter((k) => !allowed.has(k));
    const acknowledged = gone.length - missing.length;
    if (missing.length) {
        console.error(`i18n-key-guard: ${missing.length} English key(s) present at ${base} are missing now:\n`);
        for (const k of missing) console.error(`  ${k}`);
        console.error(`
A key that disappears in a merge is how screens end up showing raw keys weeks
later. If this branch did not mean to remove them, a merge dropped them: put
them back in server/i18n/defaults/en/<namespace>.js and run
\`node scripts/gen-i18n-defaults.mjs\`. If the removal is intended, list each
key in ${DEFAULTS_REL}/removed-keys.txt.`);
        return 1;
    }
    console.log(`i18n-key-guard: no keys lost against ${base} (${before.length} before, ${now.size} now`
        + `${acknowledged ? `, ${acknowledged} removal(s) listed in removed-keys.txt` : ''}).`);
    return 0;
}

function main(argv) {
    const i = argv.indexOf('--base');
    const base = i === -1 ? null : argv[i + 1];
    if (!base || base.startsWith('--')) return usage('--base <git-ref> is required');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-key-guard-'));
    try {
        const extracted = extractBase(base, tmp);
        if (extracted) return extracted;
        const before = loadKeys(tmp, { BEEFLOW_MODULE_ROOTS: path.join(tmp, MODULES_REL) });
        const now = loadKeys(ROOT, {});
        return report(base, before, now);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// Run as a command, not imported by a test (see entry-point.mjs).
if (isEntryPoint(import.meta.url)) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (e) {
        console.error(`i18n-key-guard: ${e.message}`);
        process.exitCode = 1;
    }
}
