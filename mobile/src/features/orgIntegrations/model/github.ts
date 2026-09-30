/**
 * GitHub Sync's form rules and result sentences' numbers, from the server's
 * ConfigureBody (routes/integrations/githubSync.js, pinned by the contract
 * test) and GitHubSyncPanel.jsx.
 */

import type { GithubSyncConfig, GithubSyncForm } from './githubTypes';

/** NAME_RE: GitHub's own owner and repository grammar. */
export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** BRANCH_RE: what git refuses anywhere in a ref name. */
export const BRANCH_RE = /^(?![./])[^\s~^:?*[\\]{1,255}$/;

export function formFrom(config: GithubSyncConfig | null): GithubSyncForm {
    return {
        repoOwner: config?.repoOwner ?? '',
        repoName: config?.repoName ?? '',
        branch: config?.branch ?? 'main',
        autoSync: config?.autoSync ?? false,
    };
}

export type FormProblem = 'owner' | 'name' | 'branch' | null;

/** The first field the server would refuse; a blank branch means main. */
export function formProblem(form: GithubSyncForm): FormProblem {
    if (!REPO_NAME_RE.test(form.repoOwner.trim())) return 'owner';
    if (!REPO_NAME_RE.test(form.repoName.trim())) return 'name';
    const branch = form.branch.trim();
    if (branch && !BRANCH_RE.test(branch)) return 'branch';
    return null;
}

export function repoUrl(config: Pick<GithubSyncConfig, 'repoOwner' | 'repoName'>): string {
    return `https://github.com/${config.repoOwner}/${config.repoName}`;
}
