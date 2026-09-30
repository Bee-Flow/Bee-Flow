/**
 * GitHub Sync: the repository the organisation's agent and skill
 * configurations are committed to, and pushing them.
 *
 * Verified against server/routes/integrations/githubSync.js, mounted at
 * /api/integrations/github-sync, every route `requirePermission('manage_agents')`:
 * GET /status, GET /details, POST /configure `{ repoOwner, repoName,
 * branch?, autoSync? }` (.strict(); names pinned to GitHub's grammar, and the
 * repository must be reachable with the caller's own token, else 400),
 * DELETE /configure, POST /push → `{ results: { agents, skills } }`, POST
 * /push-pending → `{ results: { pushed, errors } }`.
 */

import { api } from '@/core/api/client';

import { readGithubSyncItems, readGithubSyncStatus, readPushAll, readPushPending } from './githubReaders';
import type {
    GithubPushAll,
    GithubPushPending,
    GithubSyncForm,
    GithubSyncItem,
    GithubSyncStatus,
} from '../model/githubTypes';

const BASE = '/api/integrations/github-sync';

export async function getGithubSyncStatus(signal?: AbortSignal): Promise<GithubSyncStatus> {
    return readGithubSyncStatus(await api.get<unknown>(`${BASE}/status`, { signal }));
}

export async function getGithubSyncDetails(signal?: AbortSignal): Promise<GithubSyncItem[]> {
    return readGithubSyncItems(await api.get<unknown>(`${BASE}/details`, { signal }));
}

export async function configureGithubSync(form: GithubSyncForm): Promise<void> {
    await api.post(`${BASE}/configure`, {
        repoOwner: form.repoOwner.trim(),
        repoName: form.repoName.trim(),
        branch: form.branch.trim() || 'main',
        autoSync: form.autoSync,
    });
}

export async function disconnectGithubSync(): Promise<void> {
    await api.delete(`${BASE}/configure`);
}

export async function pushAllToGithub(): Promise<GithubPushAll> {
    return readPushAll(await api.post<unknown>(`${BASE}/push`));
}

export async function pushPendingToGithub(): Promise<GithubPushPending> {
    return readPushPending(await api.post<unknown>(`${BASE}/push-pending`));
}
