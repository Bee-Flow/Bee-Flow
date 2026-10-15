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
import { createJsonResource } from '../../../../api/client';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import type { Skill, SkillForm } from '../../../../api/queries/skills';
import type { OutputSchema, SkillExample, SkillRule, SkillStep, SkillUsage } from './skillModel';

/** A conversation of the caller's own, as the example picker lists it. */
export interface ExampleConversation {
    id: string;
    title?: string | null;
    agentName?: string | null;
}

/** One message of such a conversation. `index` is its position in the thread. */
export interface ExampleMessage {
    index: number;
    role: string;
    text: string;
}

/** One step's verdict in a graded test run. */
export interface TestStepResult {
    stepId?: string;
    status: string;
    title?: string;
    evidence?: string;
}

/** A stored test run (`GET /:id/test-runs`, or the `done` frame of a live one). */
export interface TestRun {
    id: string;
    question: string;
    status: string;
    advice?: string | null;
    ranAt: string;
    results?: TestStepResult[];
}

/** An agent the caller may run a test as. */
export interface TestAgent {
    id: string;
    name: string;
}

/** A failed call: the server's message, its HTTP status, its machine `code` and the offending `field`. */
export type SkillApiError = Error & {
    status?: number;
    code?: string | null;
    field?: string | null;
};

/** The fields "Let AI fill it in" proposes. Nothing is stored until the editor's own autosave runs. */
export interface SkillDraftProposal {
    name?: string | null;
    description?: string | null;
    instructions?: string | null;
    steps?: SkillStep[];
    rulesV2?: SkillRule[];
    examplesV2?: SkillExample[];
    outputSchema?: OutputSchema | null;
}

/**
 * Read a NAMED-event SSE stream: `event: <name>\ndata: <json>`.
 *
 * The twin of `KnowledgeStudio/knowledgeApi.js`'s reader, which is not
 * exported — the two servers frame identically and one copy would be better,
 * but pulling it out belongs to whoever owns that file. Frames that will not
 * parse are SKIPPED rather than fatal: one malformed frame should cost that
 * frame, not the result already on screen.
 */
async function readNamedSse(response: Response, onEvent: (name: string, payload: unknown) => void): Promise<void> {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
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
                let payload: unknown = null;
                try { payload = JSON.parse(data); } catch { continue; }
                onEvent(name, payload);
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
    }
}

// A non-2xx throws an Error carrying the server's error text, status, code,
// the offending `field` and the body.
const request = createJsonResource(`${API_BASE}/api/skills`, {
    contentType: 'none',
    decorate: (err, body) => { err.field = (body?.field as string | undefined) || null; },
});

const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
});

export const skillsApi = {
    /** `Skill[]`, each with `canEdit` and `lastTest`. */
    list: () => request<Skill[]>(''),
    /** `{ summary: { [skillId]: { agents, automations, lastUsedAt } } }`. */
    usageSummary: () => request<{ summary: Record<string, SkillUsage> }>('/usage-summary'),
    get: (id: string) => request<Skill>(`/${encodeURIComponent(id)}`),
    create: (payload: SkillForm) => request<Skill>('', json('POST', payload)),
    /** `{ success: true }`. Throws on 403 `not_editable`. */
    update: (id: string, payload: SkillForm) => request<{ success: boolean }>(`/${encodeURIComponent(id)}`, json('PUT', payload)),
    /**
     * DELETE. `confirmBreaking` is sent only when the caller has SHOWN the
     * dependency list — the server's own 409 guard stays the authority.
     */
    remove: (id: string, confirmBreaking = false) => request<unknown>(
        `/${encodeURIComponent(id)}`,
        json('DELETE', { confirmBreaking: confirmBreaking === true }),
    ),
    /**
     * "Improve with AI" — the header button. The server PERSISTS the rewrite
     * and answers `{ skill }` with the STORED row, so the editor adopts what
     * is saved rather than a suggestion that would evaporate on navigation.
     * `note` is optional: what the person asked for, in their own words.
     */
    improve: (id: string, note = '') => request<{ skill?: Skill } & Partial<Skill>>(`/${encodeURIComponent(id)}/ai/improve`, json('POST', { note })),
    /**
     * "Let AI fill it in" — one sentence to a whole skill. NOT stored: the
     * answer is `{ draft }`, and the editor's normal autosave decides.
     */
    draft: (sentence: string) => request<{ draft?: SkillDraftProposal | null }>('/ai/draft', json('POST', { sentence })),
    /** The agents this account may run a test as — the picker AND the server's own allow-list. */
    testAgents: () => request<{ agents?: TestAgent[] }>('/test-agents'),
    /** `{ runs: [ last 20 ] }` — the Test tab's history (S1's table). */
    testRuns: (id: string) => request<{ runs?: TestRun[] }>(`/${encodeURIComponent(id)}/test-runs`),
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
    test: async (
        id: string,
        { agentId = null, question, signal, onEvent }: {
            agentId?: string | null;
            question?: string;
            signal?: AbortSignal;
            onEvent: (name: string, payload: unknown) => void;
        },
    ): Promise<void> => {
        const res = await authFetch(`${API_BASE}/api/skills/${encodeURIComponent(id)}/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, question }),
            signal,
        });
        if (!res.ok) {
            // A failure BEFORE the stream opens still answers JSON, so the
            // reason survives — "add steps first" beats an empty result list.
            let body: { error?: string; code?: string } | null = null;
            try { body = await res.json(); } catch { /* non-JSON */ }
            const err = new Error(body?.error || `Request failed (${res.status})`) as Error & { status: number; code: string | null };
            err.status = res.status;
            err.code = body?.code || null;
            throw err;
        }
        await readNamedSse(res, onEvent);
    },
    /** The caller's OWN conversations, for the example picker (S2 server route). */
    exampleConversations: () => request<{ conversations?: ExampleConversation[] }>('/examples/conversations'),
    /** Redacted messages of one of the caller's own conversations. */
    exampleMessages: (conversationId: string) => request<{ messages?: ExampleMessage[]; piiChecked?: boolean }>(
        `/examples/conversations/${encodeURIComponent(conversationId)}/messages`,
    ),
    /** Turn one message of the caller's own conversation into an example. */
    exampleFromMessage: (id: string, payload: SkillForm) => request<{ example?: SkillExample }>(
        `/${encodeURIComponent(id)}/examples/from-message`,
        json('POST', payload),
    ),
};

export default skillsApi;
