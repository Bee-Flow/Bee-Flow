/**
 * The text files of a repository checkout, for codemods that rewrite repository paths
 * (scripts/server-mv.mjs, scripts/module-move.mjs).
 *
 *     walkFiles(dir, (name) => TEXT_EXT.test(name))   every matching file below dir, absolute
 *
 * Vendored, generated and agent folders (SKIP_DIRS) are never entered, at any depth.
 * Zero dependencies: node:* only.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Extensions of the files a path rewrite reads: code, manifests and prose. */
export const TEXT_EXT = /\.(?:m?js|cjs|ts|mts|tsx|jsx|json|ya?ml|md|mdx|sh|txt)$/;

/** Directory names a walk never enters. */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'coverage', 'dist', 'build', '.next']);

/**
 * All files under dir whose name passes `ok`, absolute, in directory order.
 * @param {string} dir
 * @param {(name: string) => boolean} ok
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function walkFiles(dir, ok, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkFiles(full, ok, out);
        else if (ok(e.name)) out.push(full);
    }
    return out;
}
