// The GitHub sync endpoints (/api/integrations/github-sync). Each call answers
// with the raw Response, exactly like authFetch: the caller reads `ok` and the body.
import { API_BASE, authFetch } from './mutate';

export const githubSyncApi = {
    status: () => authFetch(`${API_BASE}/api/integrations/github-sync/status`),
    configure: (body: unknown) => authFetch(`${API_BASE}/api/integrations/github-sync/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }),
    disconnect: () => authFetch(`${API_BASE}/api/integrations/github-sync/configure`, { method: 'DELETE' }),
    push: () => authFetch(`${API_BASE}/api/integrations/github-sync/push`, { method: 'POST' }),
    pushPending: () => authFetch(`${API_BASE}/api/integrations/github-sync/push-pending`, { method: 'POST' }),
    details: () => authFetch(`${API_BASE}/api/integrations/github-sync/details`),
};
