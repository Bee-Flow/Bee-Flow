/**
 * Which paths "show this file in its folder" may reveal.
 *
 * Only somewhere the user already chose to share with this app: a Nextcloud
 * sync folder, or Downloads — plus, when the app's own Settings page asks,
 * the log and settings files.
 *
 * "Show me this file" is a reasonable thing for the workspace (or a
 * beeflow:// link) to ask. "Show me /home/tom/.ssh" is not, and neither is
 * a network share: `\\host\share\x.exe` makes Windows reach out to
 * that host just to look.
 */

import * as path from 'node:path';

import { isInside } from '../nextcloud/paths.ts';

export interface RevealContext {
    /** Files of the app's own that may be revealed when `ownFiles` is asked for. */
    ownFiles: readonly string[];
    /** Is this (resolved, absolute) path inside one of the Nextcloud sync folders? */
    isInsideSyncFolder: (resolved: string) => boolean;
    /** The user's Downloads folder. */
    downloads: string;
}

export type RevealDecision =
    | { ok: true; path: string }
    /** `refused` is what the log names: the raw candidate, or the resolved path. */
    | { ok: false; refused: string };

export function revealDecision(target: unknown, context: RevealContext, options: { ownFiles?: boolean } = {}): RevealDecision {
    const candidate = typeof target === 'string' ? target : '';
    if (!candidate || !path.isAbsolute(candidate) || /^(\\\\|\/\/)/.test(candidate)) {
        return { ok: false, refused: candidate || 'an empty path' };
    }
    const resolved = path.resolve(candidate);
    const ownFile = options.ownFiles === true && context.ownFiles.some((file) => path.resolve(file) === resolved);
    const allowed = ownFile || context.isInsideSyncFolder(resolved) || isInside(context.downloads, resolved);
    if (!allowed) return { ok: false, refused: resolved };
    return { ok: true, path: resolved };
}
