/**
 * Client for `/api/kb` — the Knowledge Studio's ONE transport.
 *
 * Its own module rather than more members on `hooks/useKnowledgeBases.js`:
 * that hook is a 500-line data layer with its own list/create/ingest state,
 * shared by the agent designer, the project page and the admin section. The
 * Studio needs the SOURCE routes (K1b) and almost none of that state, and a
 * hook cannot be called from a plain event handler. So the HTTP lives here,
 * once, and `useKnowledgeBases` re-exports these calls rather than growing a
 * fourth copy of them.
 *
 * Errors carry `.status`, `.code` and `.body`, the datatablesApi convention,
 * because the callers must tell these apart:
 *   400 `kind_not_available` — a source kind K7–K10 has not landed yet. The
 *        button is disabled with a tooltip rather than hidden (the artboard
 *        draws all seven), so this is the belt to that braces.
 *   403 `source_limit_reached` — the licence tier's `max_kb_sources`. Carries
 *        `limit`, which the message repeats: a cap without its number is not
 *        actionable.
 *   404 — the KB or source is gone, or was never visible. Never distinguish
 *        the two on screen.
 *   413 `file_too_large` — one file over 20 MB, reported per file.
 *
 * NOTE ON DOCUMENT BODIES. `GET /:id/sources/:sid/documents` is PROJECTED and
 * never carries `original_content` (K1b): a document list must not ship every
 * body of a 38-file folder to the browser to draw five rows. The one way to a
 * body is `documentContent(kbId, docId)`, one document at a time, on demand.
 */

import { createJsonResource } from '../../../../api/client';
import { API_BASE, authFetch } from '../../../../utils/helpers';

const base = `${API_BASE}/api/kb`;
const enc = encodeURIComponent;

export type QueryValue = string | number | boolean | null | undefined;

/** A named SSE frame's handler. */
export type KbStreamHandler = (name: string, payload: unknown) => void;

/** `?a=1&b=2` from an object, dropping null/undefined/'' — never `?`. */
export function qs(params: Record<string, QueryValue> = {}): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v === null || v === undefined || v === '') continue;
        q.set(k, String(v));
    }
    const s = q.toString();
    return s ? `?${s}` : '';
}

// JSON in and out (a FormData body sets its own multipart boundary, so it
// goes without a Content-Type); a non-2xx throws an Error carrying the
// server's error text, status, code and body.
const request = createJsonResource();

/**
 * Read a NAMED-event SSE stream: `event: <name>\ndata: <json>`.
 *
 * `AppStudio/runtime/sseStream.js` reads the other framing — `data:`-only
 * frames each carrying their own `type` — which is what App Studio's routes
 * send. This one is not a generalisation of it: the two servers frame
 * differently, and a parser that guessed would quietly drop half of one.
 *
 * Frames that will not parse are SKIPPED rather than fatal. A stream is a
 * partial answer already on screen; one malformed frame should cost that
 * frame, not the paragraph the person is reading.
 */
async function readNamedSse(response: Response, onEvent: KbStreamHandler): Promise<void> {
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

export const knowledgeApi = {
    // ── Knowledge bases ──────────────────────────────────────────────
    /**
     * Every KB the caller can see. `context` narrows it the way the pickers
     * do (`agent`, `direct_chat`, `ai_step`) — the Studio overview passes
     * none, because Studio is where a KB with no context at all is managed.
     */
    list: (context: string | null = null) => request(`${base}${qs({ context })}`),
    get: (id: string | number) => request(`${base}/${enc(id)}`),
    create: (body: unknown) => request(base, { method: 'POST', body: JSON.stringify(body) }),
    /** body: `{ name?, description?, categoryId?, icon?, usageContexts? }` — PATCH, not PUT. */
    update: (id: string | number, body: unknown) => request(`${base}/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    /**
     * Audience, on its own route: `{ isPublished, sharedGroups? }`. Separate
     * from `update` because it is the control that widens who can read the
     * documents, and it has its own authorisation (an owner may always
     * publish; anyone else needs same-org manage_knowledge).
     * `sharedGroups: undefined` means "leave as-is", not "clear".
     */
    setPublished: (id: string | number, body: unknown) => request(`${base}/${enc(id)}/publish`, { method: 'PATCH', body: JSON.stringify(body) }),
    /**
     * `confirm` is K5's "yes, break the things that use this" flag: until
     * then the server has no 409 to answer with and the flag is inert.
     */
    remove: (id: string | number, opts: { confirm?: boolean } = {}) => request(`${base}/${enc(id)}${qs({ confirm: opts.confirm ? '1' : null })}`, { method: 'DELETE' }),
    categories: () => request(`${base}/categories`),

    // ── The test question (K6) ───────────────────────────────────────
    /**
     * `POST /:id/ask` — SSE. Calls `onEvent(name, payload)` for each frame:
     *
     *   kb_sources  the passages, FIRST, so the citations are on screen while
     *               the answer is still arriving
     *   text        `{ text }`, appended as it comes
     *   done        the end
     *   error       instead of `done`
     *
     * Takes an AbortSignal because a person retyping their question while the
     * previous answer streams is the normal case, not an edge one.
     */
    ask: async (
        id: string | number,
        question: string,
        { signal, onEvent }: { signal?: AbortSignal; onEvent?: KbStreamHandler } = {},
    ): Promise<void> => {
        const res = await authFetch(`${base}/${enc(id)}/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question }),
            signal,
        });
        if (!res.ok) {
            // A failure BEFORE the stream opens still answers JSON, so the
            // reason survives — "access denied" beats an empty answer box.
            let body: { error?: string; code?: string } | null = null;
            try { body = await res.json(); } catch { /* non-JSON */ }
            const err = new Error(body?.error || `Request failed (${res.status})`) as Error & { status?: number; code?: string | null };
            err.status = res.status;
            err.code = body?.code || null;
            throw err;
        }
        // `onEvent` is required by the stream reader; a caller that omits it
        // gets the same behaviour as before (a TypeError on the first frame).
        await readNamedSse(res, onEvent as KbStreamHandler);
    },
    /**
     * A copy for a new use case. `withSources` copies the SOURCES too — they
     * refill themselves on their first refresh, so the copy gets current
     * content rather than a snapshot of somebody else's last run. Documents
     * are never copied either way (their chunks and embeddings live in the
     * search service, and they are about to be replaced anyway).
     */
    duplicate: (id: string | number, { withSources = false }: { withSources?: boolean } = {}) =>
        request(`${base}/${enc(id)}/duplicate${qs({ withSources: withSources ? '1' : null })}`, { method: 'POST' }),

    // ── Usage (K5) ───────────────────────────────────────────────────
    /**
     * `{ usage: [...], unchecked: [...] }` — the Used-by rows plus the kinds
     * the scan could NOT answer. `unchecked` is not decoration: a missing
     * consumer table means "I do not know", and a client that renders it as
     * "nothing uses this" is the reason the delete dialog would be lying.
     */
    usage: (id: string | number) => request(`${base}/${enc(id)}/usage`),
    /** `{ summary: { <kbId>: { counts: {kind:n}, partial: [] } } }` — the overview's pills. */
    usageSummary: () => request(`${base}/usage-summary`),
    /**
     * `{ suggestions: [{ kbId, kbName, agentId, agentName, score }] }`.
     * Deterministic word overlap on the server, no model call: this sits on
     * the section's front page where it is seen far more often than acted on,
     * and a suggestion that changes between two page loads reads as a system
     * that is guessing.
     */
    suggestions: () => request(`${base}/suggestions`),

    // ── Sources (K1b) ────────────────────────────────────────────────
    /** `{ sources:[…], totals:{…} }` — every counter already a Number. */
    listSources: (kbId: string | number) => request(`${base}/${enc(kbId)}/sources`),
    /** body: `{ kind, name?, config, refresh? }`. */
    createSource: (kbId: string | number, body: unknown) => request(`${base}/${enc(kbId)}/sources`, { method: 'POST', body: JSON.stringify(body) }),
    updateSource: (kbId: string | number, sid: string | number, body: unknown) => request(`${base}/${enc(kbId)}/sources/${enc(sid)}`, { method: 'PATCH', body: JSON.stringify(body) }),
    removeSource: (kbId: string | number, sid: string | number) => request(`${base}/${enc(kbId)}/sources/${enc(sid)}`, { method: 'DELETE' }),
    /** 202 `{ queued:true, source }` — sets next_refresh_at=now(); K3 does the work. */
    refreshSource: (kbId: string | number, sid: string | number) => request(`${base}/${enc(kbId)}/sources/${enc(sid)}/refresh`, { method: 'POST' }),

    /**
     * 202 `{ accepted, documents:[{id,name,status:'processing'}] }`. The ids
     * are REAL rows created before the response, so the caller follows them
     * by id through `listSourceDocuments` rather than guessing by filename.
     */
    uploadFiles: (kbId: string | number, sid: string | number, files: Iterable<File>) => {
        const form = new FormData();
        for (const f of files) form.append('files', f);
        return request(`${base}/${enc(kbId)}/sources/${enc(sid)}/files`, { method: 'POST', body: form });
    },

    /** `{ documents, total, limit, offset }` — projected, no bodies. */
    listSourceDocuments: (kbId: string | number, sid: string | number, params: Record<string, QueryValue> = {}) =>
        request(`${base}/${enc(kbId)}/sources/${enc(sid)}/documents${qs(params)}`),
    getSourceDocument: (kbId: string | number, sid: string | number, docId: string | number) =>
        request(`${base}/${enc(kbId)}/sources/${enc(sid)}/documents/${enc(docId)}`),

    // ── Documents ────────────────────────────────────────────────────
    /** The ONE route that returns a body: `{ document, content, remote_only }`. */
    documentContent: (kbId: string | number, docId: string | number) => request(`${base}/${enc(kbId)}/documents/${enc(docId)}/content`),
    removeDocument: (kbId: string | number, docId: string | number) => request(`${base}/${enc(kbId)}/documents/${enc(docId)}`, { method: 'DELETE' }),
};

export default knowledgeApi;
