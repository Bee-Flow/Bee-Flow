/** GitHub Sync, as server/routes/integrations/githubSync.js serialises it. */

/** The repository the org's agents and skills are pushed to (stores/githubSyncStore.js getOrgSyncConfig). */
export interface GithubSyncConfig {
    repoOwner: string;
    repoName: string;
    branch: string;
    autoSync: boolean;
    lastFullSync: string | null;
}

/** getSyncOverview: resources per state; `total` counts live ones only. */
export interface GithubSyncOverview {
    synced: number;
    pending: number;
    error: number;
    total: number;
}

/** `GET /api/integrations/github-sync/status`. */
export interface GithubSyncStatus {
    configured: boolean;
    /** The CALLER's GitHub token is stored; sync pushes with it. */
    githubConnected: boolean;
    config: GithubSyncConfig | null;
    overview: GithubSyncOverview | null;
}

/** One row of `GET …/details` (a github_sync_state row). */
export interface GithubSyncItem {
    id: string;
    resourceType: string;
    resourceId: string;
    status: string;
    lastSyncedAt: string | null;
    errorMessage: string | null;
}

/** The configure body (ConfigureBody, .strict()). */
export interface GithubSyncForm {
    repoOwner: string;
    repoName: string;
    branch: string;
    autoSync: boolean;
}

/** `POST …/push` → per kind; `POST …/push-pending` → pushed and errors. */
export interface GithubPushAll {
    agents: { pushed: number; skipped: number };
    skills: { pushed: number; skipped: number };
}

export interface GithubPushPending {
    pushed: number;
    errors: number;
}
