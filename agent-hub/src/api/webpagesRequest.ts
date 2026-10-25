// Raw (unchecked) requests to the webpages API, for the panels that read
// `res.ok` and the body themselves. `webpageRequest` addresses one page
// (`/api/webpages/:id<path>`, the DB viewer), `webpagesRequest` the collection
// root (`/api/webpages<path>`, the knowledge sources).

import { API_BASE, authFetch } from '../utils/helpers';
import type { ApiOptions } from './webpagesApi';

export function webpageRequest(webpageId: string | undefined, path: string, opts: ApiOptions = {}) {
    const url = `${API_BASE}/api/webpages/${webpageId}${path}`;
    const headers = opts.body ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers;
    return authFetch(url, { ...opts, headers });
}

export function webpagesRequest(path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
    const url = `${API_BASE}/api/webpages${path}`;
    return authFetch(url, {
        headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
        ...opts,
    });
}
