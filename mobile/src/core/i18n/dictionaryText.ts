/**
 * The two English dictionaries, read as TEXT — for tests only (it uses
 * node:fs). Both are large modules on the other side of the monorepo, and a
 * lockstep test must not need a bundler to answer whether a key exists.
 *
 * The server dictionary is one file per namespace under
 * server/i18n/defaults/en/, merged by its index.js (which holds no keys); the
 * client copy is generated from it by scripts/gen-i18n-defaults.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');

export const CLIENT_DICT = path.join(REPO, 'agent-hub/src/i18n/en-defaults.js');

const SERVER_DICT_DIR = path.join(REPO, 'server/i18n/defaults/en');
export const SERVER_DICT = fs
    .readdirSync(SERVER_DICT_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .sort()
    .map((f) => path.join(SERVER_DICT_DIR, f));

/**
 * `'key': 'value'` and `"key": "value"` — the server catalogue mixes quote
 * styles, which has caught people out before (a grep for `"` alone misses
 * half of it), so both are read in one pass.
 */
export function readDict(files: string | string[]): Map<string, string> {
    const src = ([] as string[])
        .concat(files)
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n');
    const out = new Map<string, string>();
    for (const re of [
        /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm,
        /^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm,
    ]) {
        for (const m of src.matchAll(re)) {
            const [, key, value] = m;
            if (key && !out.has(key)) out.set(key, value ?? '');
        }
    }
    return out;
}
