/**
 * isEntryPoint — is this module the script node was started with, rather
 * than one a test (or another script) imported?
 *
 *   if (isEntryPoint(import.meta.url)) main();
 *
 * Both paths go through realpath: node resolves symlinks for import.meta.url
 * but not for argv[1], so a plain comparison is false when the script is
 * started through a symlink (a linked checkout, a worktree under macOS's
 * /var -> /private/var). A gate that quietly skipped main() would exit 0.
 * Windows paths compare case-insensitively.
 *
 * Zero dependencies: node:* only. A script that imports this and is copied
 * into a test sandbox needs this file copied next to it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isEntryPoint(metaUrl, argv1 = process.argv[1]) {
    if (!argv1) return false;
    try {
        const [a, b] = [fs.realpathSync(path.resolve(argv1)), fs.realpathSync(fileURLToPath(metaUrl))];
        return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    } catch {
        return false;
    }
}
