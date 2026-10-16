// The Word-templates endpoints (/api/templates). Each call answers with the
// raw Response, exactly like authFetch: the caller reads `ok` and the body.
import { API_BASE, authFetch } from './mutate';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const templatesApi = {
    chatModels: () => authFetch(`${API_BASE}/ai/config/chat-models`),
    list: () => authFetch(`${API_BASE}/api/templates`),
    get: (id: string) => authFetch(`${API_BASE}/api/templates/${id}`),
    upload: (body: FormData) => authFetch(`${API_BASE}/api/templates/upload`, { method: 'POST', body }),
    rename: (id: string, name: string) => authFetch(`${API_BASE}/api/templates/${id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
    }),
    remove: (id: string) => authFetch(`${API_BASE}/api/templates/${id}`, { method: 'DELETE' }),
    download: (id: string) => authFetch(`${API_BASE}/api/templates/${id}/download`),
    fill: (id: string, values: unknown) => authFetch(`${API_BASE}/api/templates/${id}/fill`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ values }),
    }),
    fillAndStore: (id: string, values: unknown) => authFetch(`${API_BASE}/api/templates/${id}/fill-and-store`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ values }),
    }),
    /** An authenticated GET of a file URL the server handed out (a generated document). */
    file: (url: string) => authFetch(url),
};
