// The GitHub sync endpoints (/api/integrations/github-sync). Each call answers
// with the raw Response, exactly like authFetch: the caller reads `ok` and the body.
// `orgId` is the organisation a platform admin chose in the admin dashboard
// (sent as ?orgId=); null works on the caller's own organisation.
import { API_BASE, authFetch } from './mutate';
import { withOrgIdParam } from './adminOrgScope';

export function githubSyncApi(orgId: string | null = null) {
    const at = (path: string) => withOrgIdParam(`${API_BASE}/api/integrations/github-sync/${path}`, orgId);
    return {
        status: () => authFetch(at('status')),
        configure: (body: unknown) => authFetch(at('configure'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        disconnect: () => authFetch(at('configure'), { method: 'DELETE' }),
        push: () => authFetch(at('push'), { method: 'POST' }),
        pushPending: () => authFetch(at('push-pending'), { method: 'POST' }),
        details: () => authFetch(at('details')),
    };
}
