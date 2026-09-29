/**
 * Global search shapes.
 *
 * There is no single `/api/search` for a person's own content. `routes/search.js`
 * is the Node port of the hosted Python search-service — an INTERNAL surface for
 * embedding, reranking and web lookups, reached over `SEARCH_SERVICE_URL` — and
 * pointing the phone at it would search the web, not the user's workspace.
 *
 * So "search everything" is a fan-out over the six surfaces that each have a
 * real read endpoint of their own, and the wire rows below are taken from the
 * server's own projections rather than guessed:
 *
 *   chats        server/routes/agents/conversations_meta.js GET /conversations/search
 *                → server/stores/agent/{agentConversations,directConversations}.js
 *   notebooks    server/routes/notebooks.js  (list, `search` is server-side)
 *   knowledge    server/routes/knowledgeBases/list.js       (no search param)
 *   documents    server/routes/knowledgeBases/documents.js  (per-KB list)
 *                + server/routes/knowledgeBases/search.js   POST /search
 *   automations  server/routes/automation/crud.js  GET /       (no search param)
 *   transcripts  server/routes/transcriptions/notes.js GET /   (no search param)
 *
 * The casing really does differ per endpoint — notebooks are camelCase, the
 * knowledge-base tables are snake_case. Normalising it here would hide the seam
 * and the next person to add a field would guess wrong.
 */

/**
 * The seven surfaces, in the order the screen renders them.
 *
 * `places` is first, and that is the point of it. This app has 37 destinations
 * and the only way to reach most of them was to open More and scroll — so
 * "where is X" was the one question the magnifier in ~45 headers could not
 * answer, while it happily searched the contents of everything. Screens rank
 * above content because someone typing "cowork" or "instellingen" is asking to
 * GO somewhere; a group with no hits is filtered out before render, so this
 * costs nothing to a search that was about content after all.
 */
export const SEARCH_GROUPS = [
    'places',
    'chats',
    'notebooks',
    'documents',
    'knowledge',
    'automations',
    'transcripts',
] as const;

export type SearchGroupKey = (typeof SEARCH_GROUPS)[number];

/**
 * How a group gets its answers. Worth stating per group, because it decides
 * what a slow network feels like and what "no results" means:
 *
 *   'server'  — the endpoint takes the query. Re-fetched on every debounce.
 *   'corpus'  — the endpoint has no query parameter, so the list is fetched
 *               once, cached, and filtered on the phone. Instant, but only
 *               matches what the list projection carries.
 */
export type SearchStrategy = 'server' | 'corpus';

export const GROUP_LABELS: Record<SearchGroupKey, string> = {
    // Not "Destinations" or "Navigation" — the word has to be what a person
    // would call the thing they are trying to reach.
    places: 'Screens',
    chats: 'Chats',
    notebooks: 'Notebooks',
    documents: 'Documents',
    knowledge: 'Knowledge bases',
    automations: 'Routines',
    transcripts: 'Meeting notes',
};

export const GROUP_STRATEGY: Record<SearchGroupKey, SearchStrategy> = {
    // Not merely cached — the corpus is a module-level constant compiled into
    // the app, so this group answers offline and before the first frame of any
    // network request.
    places: 'corpus',
    chats: 'server',
    notebooks: 'server',
    documents: 'server',
    knowledge: 'corpus',
    automations: 'corpus',
    transcripts: 'corpus',
};

/** One row in the results list, already normalised for rendering. */
export interface SearchHit {
    /** Unique across the whole result set — used as the list key. */
    key: string;
    group: SearchGroupKey;
    title: string;
    /** The matching passage, or whatever else explains why this row is here. */
    subtitle?: string;
    /** Right-aligned: a relative timestamp or a short count. */
    meta?: string;
    /**
     * Where tapping goes. `null` when the server object genuinely has no screen
     * on the phone yet — the row still renders, because knowing the thing
     * exists is most of the value, and a dead tap is worse than no tap.
     */
    href: string | null;
}

/**
 * One group's outcome. `error` and `hits` are not mutually exclusive on
 * purpose: a fan-out where knowledge bases 403 on this plan must still show
 * the four chats that matched.
 */
export interface SearchGroupResult {
    key: SearchGroupKey;
    hits: SearchHit[];
    /** Whatever was thrown. Rendered as one line under the group heading. */
    error: unknown;
}

export interface SearchResults {
    groups: SearchGroupResult[];
    total: number;
}

// ── Wire rows ────────────────────────────────────────────────────────

/**
 * GET /agents/conversations/search.
 *
 * Agent and direct rows arrive in ONE array, distinguished by `kind` — the
 * route tags agent rows and the direct store tags its own. `messages_json` is
 * only present on the legacy non-migrated path, where it is the decrypted
 * transcript; on every other path the snippet has to come from the title.
 */
export interface ConversationSearchRow {
    id: string;
    title: string | null;
    updated_at: string;
    model_tier?: string | null;
    kind?: 'direct' | 'agent' | (string & {});
    agent_id?: string | null;
    agent_name?: string | null;
    messages_json?: string | null;
}

/** GET /api/notebooks — the card projection (server/stores/notebookStore.js). */
export interface NotebookSearchRow {
    id: string;
    name: string;
    description: string;
    preview: string;
    sourceCount: number;
    lastActivityAt: string | null;
    updatedAt: string | null;
}

/** GET /api/kb — the knowledge_bases table, returned raw. */
export interface KnowledgeBaseRow {
    id: string;
    name: string;
    description: string | null;
    document_count?: number | string;
    updated_at?: string;
    created_at: string;
}

/** GET /api/kb/:id/documents — the documents table, returned raw. */
export interface KbDocumentRow {
    id: string;
    knowledge_base_id: string;
    title: string | null;
    source_type: string | null;
    source_uri: string | null;
    chunk_count: number;
    created_at: string;
}

/**
 * POST /api/kb/search — one retrieval hit.
 *
 * Two things about this response that a caller has to know: the rows come back
 * under `chunks` on the local pgvector path and under `results` on the
 * search-service path, and the projection carries `document_id` but NOT the
 * knowledge base it belongs to (see the SELECT in core/kb/localKBIngest.js).
 * The base is recovered by joining `document_id` against the document corpus.
 */
export interface KbSearchHitRow {
    id?: string;
    content: string;
    title?: string | null;
    source_uri?: string | null;
    score?: number;
    document_id?: string;
    chunk_id?: number | string;
}

export interface KbSearchResponseRow {
    chunks?: KbSearchHitRow[];
    results?: KbSearchHitRow[];
}

/** GET /api/automation — the automations list (`block` rows are Steps). */
export interface AutomationSearchRow {
    id: string;
    kind?: string;
    title: string;
    description: string | null;
    isActive: boolean;
    lastRunAt: string | null;
    updatedAt: string | null;
}

/** GET /api/transcriptions — the list projection. */
export interface TranscriptSearchRow {
    id: string;
    title: string;
    fileName: string | null;
    status: string;
    /** First 2000 chars of the raw text. The server ships it FOR this screen. */
    transcriptSnippet?: string;
    summarySnippet?: string;
    createdAt: string | null;
    updatedAt: string | null;
}
