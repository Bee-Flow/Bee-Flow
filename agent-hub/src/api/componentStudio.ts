// The requests the Component Studio builder (admin/component-studio/
// ComponentBuilder) sends itself.
//
// Each helper sends exactly the request the builder used to send inline and
// hands the Response back untouched: the caller keeps reading the body (and,
// for the sample save, `res.ok`) as before. The deletes go through `mutate`,
// which throws on a non-2xx answer, as they always did.

import { API_BASE, authFetch, mutate } from './mutate';

/** GET /components — every component with its definition, for the sidebar. */
export function fetchComponents(): Promise<Response> {
    return authFetch(`${API_BASE}/components`);
}

/** GET /components/:id — one component's full definition and code. */
export function fetchComponent(id: string): Promise<Response> {
    return authFetch(`${API_BASE}/components/${id}`);
}

/** POST /components (create) or PUT /components/:id (update) with the whole form. */
export function saveComponent(isCreating: boolean, id: string | null, payload: Record<string, unknown>): Promise<Response> {
    const url = isCreating
        ? `${API_BASE}/components`
        : `${API_BASE}/components/${id}`;
    const method = isCreating ? 'POST' : 'PUT';
    return authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

/** DELETE /components/:id — checked: a refusal throws an ApiError. */
export function deleteComponent(id: string): Promise<Response> {
    return mutate(`${API_BASE}/components/${id}`, { method: 'DELETE' });
}

/** POST /test-component — run a saved component with the given inputs. */
export function runComponentTest(componentId: string, inputs: unknown): Promise<Response> {
    return authFetch(`${API_BASE}/test-component`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ componentId, inputs }),
    });
}

/** PUT /components/:id with only `sampleOutput` and the derived `outputs`. */
export function saveComponentSample(id: string, sampleOutput: unknown, outputs: Record<string, string>): Promise<Response> {
    return authFetch(`${API_BASE}/components/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleOutput, outputs }),
    });
}
