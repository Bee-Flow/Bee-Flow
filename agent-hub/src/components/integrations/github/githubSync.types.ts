/**
 * The shapes the GitHub sync panel reads off /api/integrations/github-sync/*.
 * Only the fields the panel itself touches are named; the server sends more.
 */

export interface GitHubSyncConfig {
    repoOwner?: string;
    repoName?: string;
    branch?: string;
    autoSync?: boolean;
    lastFullSync?: string | null;
}

export interface GitHubSyncOverview {
    synced: number;
    pending: number;
    error: number;
    total: number;
}

export interface GitHubSyncStatus {
    githubConnected?: boolean;
    configured?: boolean;
    config?: GitHubSyncConfig | null;
    overview?: GitHubSyncOverview | null;
}

export interface GitHubSyncDetail {
    id: string;
    resource_type: string;
    resource_id: string;
    sync_status: string;
    last_synced_at?: string | null;
    error_message?: string | null;
}

export interface GitHubSyncMessage {
    type: 'success' | 'error';
    text: string;
}
