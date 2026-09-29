/**
 * skillsApi — the one place SkillsStudio talks to `/api/skills`.
 *
 * Thin on purpose: it does not cache, it does not retry, and it does not
 * invent a shape. Its whole job is to make a failure LEGIBLE — every
 * rejection carries `.status`, `.code` and `.body`, the convention
 * `Datatables/datatablesApi.js` set — so the callers can tell the three
 * answers apart that actually change what the UI does:
 *
 *   403 `not_editable`  the skill is visible but this account may not edit
 *                       it (S1 chose 403 over 404 exactly because a 404
 *                       would make the 350ms autosave retry forever);
 *   409 `in_use`        the delete would break something, and the payload
 *                       carries the list to show before asking again;
 *   400 `invalid_structure`  one structured facet was malformed; `field`
 *                       says which, so the editor can point at it.
 */
import { API_BASE, authFetch } from '../../../../utils/helpers';

/**
 * Read a NAMED-event SSE stream: `event: <name>\ndata: <json>`.
 *
 * The twin of `KnowledgeStudio/knowledgeApi.js`'s reader, which is not
 * exported — the two servers frame identically and one copy would be better,
 * but pulling it out belongs to whoever owns that file. Frames that will not
 * parse are SKIPPED rather than fatal: one malformed frame should cost that
 * frame, not the result already on screen.
 */
async function readNamedSse(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop() || '';
            for (const frame of frames) {
                const lines = frame.split('\n');
                const name = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
                const data = lines.find(l => l.startsWith('data:'))?.slice(5).trim();
                if (!name || data === undefined) continue;
                let payload = null;
                try { payload = JSON.parse(data); } catch { continue; }
                onEvent(name, payload);
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
    }
}

async function request(path, init) {
    const res = await authFetch(`${API_BASE}/api/skills${path}`, init);
    let body = null;
    try { body = await res.json(); } catch { /* empty or non-JSON */ }
    if (!res.ok) {
        const err = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = body?.code || null;
        err.field = body?.field || null;
        err.body = body;
        throw err;
    }
    return body;
}

const json = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
});

export const skillsApi = {
    /** `Skill[]`, each with `canEdit` and `lastTest`. */
    list: () => request(''),
    /** `{ summary: { [skillId]: { agents, automations, lastUsedAt } } }`. */
    usageSummary: () => request('/usage-summary'),
    get: (id) => request(`/${encodeURIComponent(id)}`),
    create: (payload) => request('', json('POST', payload)),
    /** `{ success: true }`. Throws on 403 `not_editable`. */
    update: (id, payload) => request(`/${encodeURIComponent(id)}`, json('PUT', payload)),
    /**
     * DELETE. `confirmBreaking` is sent only when the caller has SHOWN the
     * dependency list — the server's own 409 guard stays the authority.
     */
    remove: (id, confirmBreaking = false) => request(
        `/${encodeURIComponent(id)}`,
        json('DELETE', { confirmBreaking: confirmBreaking === true }),
    ),
    /**
     * "Improve with AI" — the header button. The server PERSISTS the rewrite
     * and answers `{ skill }` with the STORED row, so the editor adopts what
     * is saved rather than a suggestion that would evaporate on navigation.
     * `note` is optional: what the person asked for, in their own words.
     */
    improve: (id, note = '') => request(`/${encodeURIComponent(id)}/ai/improve`, json('POST', { note })),
    /**
     * "Let AI fill it in" — one sentence to a whole skill. NOT stored: the
     * answer is `{ draft }`, and the editor's normal autosave decides.
     */
    draft: (sentence) => request('/ai/draft', json('POST', { sentence })),
    /** The agents this account may run a test as — the picker AND the server's own allow-list. */
    testAgents: () => request('/test-agents'),
    /** `{ runs: [ last 20 ] }` — the Test tab's history (S1's table). */
    testRuns: (id) => request(`/${encodeURIComponent(id)}/test-runs`),
    /**
     * `POST /:id/test` — SSE. Calls `onEvent(name, payload)` per frame:
     *
     *   answer  `{ text }`  what the agent replied
     *   done    `{ run }`   the stored run row: results, status, advice
     *   error   `{ error, code }` instead of `done`
     *
     * Takes an AbortSignal: retyping the question while a run streams is the
     * normal case, not an edge one.
     */
    test: async (id, { agentId = null, question, signal, onEvent } = {}) => {
        const res = await authFetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, question }),
            signal,
        });
        if (!res.ok) {
            // A failure BEFORE the stream opens still answers JSON, so the
            // reason survives — "add steps first" beats an empty result list.
            let body = null;
            try { body = await res.json(); } catch { /* non-JSON */ }
            const err = new Error(body?.error || `Request failed (${res.status})`);
            err.status = res.status;
            err.code = body?.code || null;
            throw err;
        }
        await readNamedSse(res, onEvent);
    },
    /** The caller's OWN conversations, for the example picker (S2 server route). */
    exampleConversations: () => request('/examples/conversations'),
    /** Redacted messages of one of the caller's own conversations. */
    exampleMessages: (conversationId) => request(
        `/examples/conversations/${encodeURIComponent(conversationId)}/messages`,
    ),
    /** Turn one message of the caller's own conversation into an example. */
    exampleFromMessage: (id, payload) => request(
        `/${encodeURIComponent(id)}/examples/from-message`,
        json('POST', payload),
    ),
};

export default skillsApi;
