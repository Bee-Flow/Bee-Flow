// The per-user settings endpoint (/ai/user-settings). Each call answers with
// the raw Response, exactly like authFetch: the caller reads `ok` and the body.
import { API_BASE, authFetch } from './mutate';

export const userSettingsApi = {
    get: () => authFetch(`${API_BASE}/ai/user-settings`),
    save: (body: unknown) => authFetch(`${API_BASE}/ai/user-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }),
};
