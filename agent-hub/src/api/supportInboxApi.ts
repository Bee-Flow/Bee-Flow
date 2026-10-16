// The support inbox endpoints (/api/support). Each call answers with the raw
// Response, exactly like authFetch: the caller reads `ok` and the body.
import { API_BASE, authFetch } from './mutate';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const supportInboxApi = {
    threads: (query: string) => authFetch(`${API_BASE}/api/support/threads?${query}`),
    thread: (id: string) => authFetch(`${API_BASE}/api/support/threads/${id}`),
    mailbox: () => authFetch(`${API_BASE}/api/support/mailbox`),
    disconnectMailbox: () => authFetch(`${API_BASE}/api/support/mailbox/disconnect`, { method: 'POST' }),
    events: (id: string) => authFetch(`${API_BASE}/api/support/threads/${id}/events`),
    sendMessage: (id: string, body: string, internalNote: boolean) => authFetch(`${API_BASE}/api/support/threads/${id}/messages`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ body, internalNote }),
    }),
    patchThread: (id: string, patch: unknown) => authFetch(`${API_BASE}/api/support/threads/${id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch),
    }),
    followupDone: (id: string) => authFetch(`${API_BASE}/api/support/threads/${id}/followup-done`, { method: 'POST' }),
    canned: () => authFetch(`${API_BASE}/api/support/canned`),
    renderCanned: (cannedId: string, threadId: string | null) => authFetch(`${API_BASE}/api/support/canned/${cannedId}/render`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ threadId }),
    }),
    bulk: (ids: string[], action: string, params: Record<string, string>) => authFetch(`${API_BASE}/api/support/threads/bulk`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ids, action, params }),
    }),
};
