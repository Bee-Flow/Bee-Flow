/**
 * Writing a project file into a FULL-tier runtime's workdir. The workdir is
 * bind-mounted read-write into the project's container, so an entry in it may
 * be a symlink the container made. A write here never follows one: the path
 * must stay inside the workdir lexically, every directory on the way is
 * checked with lstat (a missing one is created), and the file is opened with
 * O_NOFOLLOW.
 */

import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';

export type WriteOutcome = 'written' | 'outside' | 'link';

/**
 * The directory `relDir` under `rootReal`, created where missing, with every
 * component a real directory (never a symlink); null when one is not.
 */
export async function ensureRealDirInside(rootReal: string, relDir: string): Promise<string | null> {
    let current = rootReal;
    for (const part of relDir.split(path.sep).filter(Boolean)) {
        if (part === '.' || part === '..') return null;
        current = path.join(current, part);
        let st: Stats;
        try {
            st = await lstat(current);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            await mkdir(current);
            continue;
        }
        if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    return current;
}

/**
 * Write `content` to `rel` under the workdir. `workdir` is the path as
 * configured, `workdirReal` its realpath (the workdir itself is a mount point
 * the container cannot replace).
 */
export async function writeInsideWorkdir(workdir: string, workdirReal: string, rel: string, content: string | Uint8Array): Promise<WriteOutcome> {
    const root = path.resolve(workdir);
    const dest = path.resolve(root, rel);
    if (dest === root || !dest.startsWith(root + path.sep)) return 'outside';
    const parent = await ensureRealDirInside(workdirReal, path.relative(root, path.dirname(dest)));
    if (!parent) return 'link';
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0);
    let fh: FileHandle;
    try {
        fh = await open(path.join(parent, path.basename(dest)), flags, 0o644);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ELOOP') return 'link';
        throw err;
    }
    try { await fh.writeFile(content); } finally { await fh.close(); }
    return 'written';
}
