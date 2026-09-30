/**
 * http.ts — the co-editing session's default transport: the API client for
 * every request, and a fetch that outlives the page (keepalive) for the last
 * edits of a closing tab.
 */
import { apiClient } from '../../api/client';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { CollabHttp } from './providerSupport';

export const defaultHttp: CollabHttp = {
    post: (path, body) => apiClient.post(path, body, { retry: false }),
    beacon: (path, body) => {
        authFetch(`${API_BASE}${path}`, {
            method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).catch(() => { /* best effort: the page is closing */ });
    },
};
