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
 * The base is read with `git archive <ref> server/i18n/defaults`, extracted to
 * a temporary directory and required from there, so it works whatever layout
 * the base has: the old monolithic en.js or the per-namespace en/ directory
 * (en.js is a re-export of en/index.js there). In CI the ref is the pull
 * request's base commit; fetch it first if the checkout is shallow.
 *
 * Zero dependencies: node:* plus the `git` and `tar` binaries.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS_REL = 'server/i18n/defaults';
const ALLOW_FILE = path.join(ROOT, DEFAULTS_REL, 'removed-keys.txt');

function usage(msg) {
    if (msg) console.error(`i18n-key-guard: ${msg}`);
    console.error('usage: node scripts/i18n-key-guard.mjs --base <git-ref>');
    return 2;
}

/** GUI_DEFAULTS from a `server/i18n/defaults` directory, whichever layout it has. */
function loadDictionary(defaultsDir) {
    const candidates = [path.join(defaultsDir, 'en.js'), path.join(defaultsDir, 'en', 'index.js')];
    const entry = candidates.find((f) => fs.existsSync(f));
    if (!entry) throw new Error(`no English dictionary under ${defaultsDir}`);
    const { GUI_DEFAULTS } = createRequire(entry)(entry);
    if (!GUI_DEFAULTS || typeof GUI_DEFAULTS !== 'object') throw new Error(`${entry} exports no GUI_DEFAULTS`);
    return GUI_DEFAULTS;
}

export function readAllowList(file) {
    if (!fs.existsSync(file)) return new Set();
    return new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean));
}

function main(argv) {
    const i = argv.indexOf('--base');
    const base = i === -1 ? null : argv[i + 1];
    if (!base || base.startsWith('--')) return usage('--base <git-ref> is required');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-key-guard-'));
    try {
        let archive;
        try {
            archive = execFileSync('git', ['archive', '--format=tar', base, DEFAULTS_REL], {
                cwd: ROOT, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) {
            console.error(`i18n-key-guard: cannot read ${DEFAULTS_REL} at ${base}: ${String(e.stderr || e.message).trim()}`);
            console.error('In a shallow clone, fetch the base first: git fetch --no-tags --depth=1 origin <sha>');
            return 2;
        }
        execFileSync('tar', ['-x', '-C', tmp], { input: archive });

        const before = loadDictionary(path.join(tmp, DEFAULTS_REL));
        const now = loadDictionary(path.join(ROOT, DEFAULTS_REL));
        const allowed = readAllowList(ALLOW_FILE);
        const gone = Object.keys(before).filter((k) => !Object.prototype.hasOwnProperty.call(now, k));
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
        console.log(`i18n-key-guard: no keys lost against ${base} (${Object.keys(before).length} before, ${Object.keys(now).length} now`
            + `${acknowledged ? `, ${acknowledged} removal(s) listed in removed-keys.txt` : ''}).`);
        return 0;
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
