/**
 * /api/playbooks — the entity the Playbook page reads and PATCHes (CAS by
 * `expectedVersion`; a 409 carries `currentVersion` + the current playbook,
 * and the caller reloads rather than retrying blindly).
 */
import { API_BASE, authFetch } from '../../../../utils/helpers';

const base = `${API_BASE}/api/playbooks`;
const enc = encodeURIComponent;

async function request(url, options = {}) {
    const res = await authFetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
        ...(options.body !== undefined && typeof options.body !== 'string' ? { body: JSON.stringify(options.body) } : {}),
    });
    let body = null;
    try { body = await res.json(); } catch { /* 204 */ }
    if (!res.ok) {
        const err = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = body?.code || null;
        err.body = body;
        throw err;
    }
    return body;
}

export const playbooksApi = {
    // The recipes come back in the interface language: their columns, labels
    // and briefs are what the playbook is then built with.
    recipes: (locale) => request(`${base}/recipes${locale ? `?locale=${enc(locale)}` : ''}`),
    composeRecipe: (description, locale) => request(`${base}/recipes/compose`, { method: 'POST', body: { description, locale } }),
    list: () => request(base),
    get: (id) => request(`${base}/${enc(id)}`),
    create: (body) => request(base, { method: 'POST', body }),
    patch: (id, body) => request(`${base}/${enc(id)}`, { method: 'PATCH', body }),
    // `body` carries a design revision's { feedback }; empty for a plain run.
    runPhase: (id, key, body = {}) => request(`${base}/${enc(id)}/phases/${enc(key)}/run`, { method: 'POST', body }),
    skipPhase: (id, key, expectedVersion) => request(`${base}/${enc(id)}/phases/${enc(key)}/skip`, { method: 'POST', body: { expectedVersion } }),
    retryPhase: (id, key, expectedVersion, extra = {}) => request(`${base}/${enc(id)}/phases/${enc(key)}/retry`, { method: 'POST', body: { expectedVersion, ...extra } }),
    // The access phase's assistant: a sentence in, a PROPOSAL out. Writes
    // nothing — the page applies it only after the person approves.
    accessPlan: (id, key, message) => request(`${base}/${enc(id)}/phases/${enc(key)}/access-plan`, { method: 'POST', body: { message } }),
    // The compliance phase's ONE write: the table's legal basis + retention
    // (which is what puts it in the processing register), a risk per kept
    // finding, and the review itself on the evidence chain.
    register: (id, key, body) => request(`${base}/${enc(id)}/phases/${enc(key)}/register`, { method: 'POST', body }),
    // What a retention period would MEAN for the rows that are really there —
    // the oldest one, and how many already fall outside the window. Reads.
    retentionPreview: (id, key, body) => request(`${base}/${enc(id)}/phases/${enc(key)}/retention-preview`, { method: 'POST', body }),
    // "Resolve with AI" for ONE finding: the proposal, in words and in calls.
    // Writes nothing; `resolveApply` applies it after the person presses Apply.
    resolvePlan: (id, key, code) => request(`${base}/${enc(id)}/phases/${enc(key)}/resolve-plan`, { method: 'POST', body: { code } }),
    remove: (id) => request(`${base}/${enc(id)}`, { method: 'DELETE' }),
};

export default playbooksApi;
