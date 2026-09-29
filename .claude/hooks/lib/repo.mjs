// Which git checkout a hook should act on.
//
// Two layouts run these hooks. In a cloud session CLAUDE_PROJECT_DIR is the
// repository itself. On the owner's Windows machine it is a wrapper folder
// ("Bee Flow - AI", with spaces) and the repository sits one level down in
// Bee-Flow-AI/. The hooks used to hard-code the second layout, so in the first
// they looked for <repo>/Bee-Flow-AI/scripts/…, found nothing and did nothing,
// silently. A subagent may also work in a git worktree under
// .claude/worktrees/<name>/, a checkout of its own that must be linted,
// tested and scanned as itself.
//
// So ask git, starting from what the tool touched, and guess from the layout
// only when git cannot answer.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const WRAPPED_REPO = 'Bee-Flow-AI';

export function isDirectory(p) {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** `p` itself when it is a directory, else its nearest existing ancestor. */
function nearestDirectory(p) {
    for (let dir = p; ; dir = path.dirname(dir)) {
        if (isDirectory(dir)) return dir;
        if (path.dirname(dir) === dir) return null;
    }
}

/** Run git in `cwd` and return its trimmed stdout, or null when it fails. */
export function git(cwd, args, { timeout = 5000 } = {}) {
    const res = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return res.status === 0 ? res.stdout.trim() : null;
}

/** The top level of the checkout that contains `dir`, or null. */
export function gitTopLevel(dir) {
    if (!dir || !isDirectory(dir)) return null;
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    return top ? path.resolve(top) : null;
}

const real = (p) => {
    try {
        return realpathSync(p);
    } catch {
        return path.resolve(p);
    }
};

/** True when `outer` strictly contains `inner`. */
export function isStrictAncestor(outer, inner) {
    const rel = path.relative(real(outer), real(inner));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The checkout a hook should act on: the git top level of the edited file's
 * directory, else of `cwd`, else of CLAUDE_PROJECT_DIR; then the wrapper
 * layout's CLAUDE_PROJECT_DIR/Bee-Flow-AI when that is a repository, then
 * CLAUDE_PROJECT_DIR itself. Null when none of these exists.
 *
 * A repository found AROUND a wrapper project (a home directory under
 * version control, say) is skipped: it is not this project.
 *
 * @param {{ filePath?: string, cwd?: string, projectDir?: string }} [where]
 */
export function resolveRepo({ filePath, cwd, projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
    const candidates = [];
    if (filePath) candidates.push(nearestDirectory(path.dirname(path.resolve(cwd || '.', filePath))));
    if (cwd) candidates.push(cwd);
    if (projectDir) candidates.push(projectDir);

    const inner = projectDir ? path.join(projectDir, WRAPPED_REPO) : null;
    const wrapped = Boolean(inner) && existsSync(path.join(inner, '.git'));

    for (const dir of candidates) {
        const top = gitTopLevel(dir);
        if (!top) continue;
        if (wrapped && isStrictAncestor(top, projectDir)) continue;
        return top;
    }
    if (wrapped) return gitTopLevel(inner) || path.resolve(inner);
    return projectDir && isDirectory(projectDir) ? path.resolve(projectDir) : null;
}

/** `file` relative to `repo` with forward slashes, or null when it lies outside. */
export function repoPath(repo, file) {
    const rel = path.relative(real(repo), real(file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}
