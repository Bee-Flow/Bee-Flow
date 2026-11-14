/**
 * /api/playbooks — the entity the Playbook page reads and PATCHes (CAS by
 * `expectedVersion`; a 409 carries `currentVersion` + the current playbook,
 * and the caller reloads rather than retrying blindly).
 */
import { createJsonResource } from '@/api/client';
import { apiUrl } from '@/api/typedRequest';

const enc = encodeURIComponent;

// JSON in and out (a plain-object body is serialised); a non-2xx throws an
// Error carrying the server's error text, status, code and body.
const request = createJsonResource();

export const playbooksApi = {
    // The recipes come back in the interface language: their columns, labels
    // and briefs are what the playbook is then built with.
    recipes: (locale?: string) => request(`${apiUrl('GET /api/playbooks/recipes')}${locale ? `?locale=${enc(locale)}` : ''}`),
    composeRecipe: (description: string, locale?: string) => request(apiUrl('POST /api/playbooks/recipes/compose'), { method: 'POST', body: { description, locale } }),
    list: () => request(apiUrl('GET /api/playbooks')),
    get: (id: string) => request(apiUrl('GET /api/playbooks/{id}', { params: { id } })),
    create: (body: unknown) => request(apiUrl('POST /api/playbooks'), { method: 'POST', body }),
    patch: (id: string, body: unknown) => request(apiUrl('PATCH /api/playbooks/{id}', { params: { id } }), { method: 'PATCH', body }),
    // `body` carries a design revision's { feedback }; empty for a plain run.
    runPhase: (id: string, key: string, body: unknown = {}) => request(apiUrl('POST /api/playbooks/{id}/phases/{key}/run', { params: { id, key } }), { method: 'POST', body }),
    skipPhase: (id: string, key: string, expectedVersion: number) => request(apiUrl('POST /api/playbooks/{id}/phases/{key}/skip', { params: { id, key } }), { method: 'POST', body: { expectedVersion } }),
    retryPhase: (id: string, key: string, expectedVersion: number, extra: Record<string, unknown> = {}) => request(apiUrl('POST /api/playbooks/{id}/phases/{key}/retry', { params: { id, key } }), { method: 'POST', body: { expectedVersion, ...extra } }),
    // The access phase's assistant: a sentence in, a PROPOSAL out. Writes
    // nothing — the page applies it only after the person approves.
    accessPlan: (id: string, key: string, message: string) => request(apiUrl('POST /api/playbooks/{id}/phases/{key}/access-plan', { params: { id, key } }), { method: 'POST', body: { message } }),
    // The compliance phase's ONE write: the table's legal basis + retention
    // (which is what puts it in the processing register), a risk per kept
    // finding, and the review itself on the evidence chain.
    register: (id: string, key: string, body: unknown) => request(apiUrl('POST /api/playbooks/{id}/phases/{key}/register', { params: { id, key } }), { method: 'POST', body }),
    // What a retention period would MEAN for the rows that are really there —
    // the oldest one, and how many already fall outside the window. Reads.
    retentionPreview: (id: string, key: string, body: unknown) => request(apiUrl('POST /api/playbooks/{id}/phases/{key}/retention-preview', { params: { id, key } }), { method: 'POST', body }),
    // "Resolve with AI" for ONE finding: the proposal, in words and in calls.
    // Writes nothing; `resolveApply` applies it after the person presses Apply.
    resolvePlan: (id: string, key: string, code: string) => request(apiUrl('POST /api/playbooks/{id}/phases/{key}/resolve-plan', { params: { id, key } }), { method: 'POST', body: { code } }),
    remove: (id: string) => request(apiUrl('DELETE /api/playbooks/{id}', { params: { id } }), { method: 'DELETE' }),
};

