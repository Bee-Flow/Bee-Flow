/**
 * Global search: the fan-out, and the rules for merging six answers into one
 * list.
 *
 * Paths are the FULL client-visible ones. The mount prefixes come from
 * server/index.js and are the easiest thing in this codebase to get wrong:
 *
 *     routes/agents/conversations_meta.js → /agents      ← NOT /api/…
 *     routes/notebooks.js                 → /api/notebooks
 *     routes/knowledgeBases/*             → /api/kb
 *     routes/automation/crud.js           → /api/automation
 *     routes/transcriptions/notes.js      → /api/transcriptions
 *
 * Two kinds of source, and the split is what makes the screen feel instant:
 *
 *   SERVER-SEARCHED (re-run per debounce) — conversations, notebooks and
 *   knowledge-base passages each have an endpoint that takes the query. These
 *   are the only three requests a keystroke can cause.
 *
 *   CORPUS-FILTERED (fetched once, cached, filtered on the phone) — knowledge
 *   bases, routines and meeting notes have NO query parameter on their list
 *   routes. Refetching all three per keystroke would be three requests for a
 *   filter the phone can do in a millisecond, so the lists are pulled once
 *   with a long staleTime and matched locally. The cost is honest and stated
 *   on screen: these groups only match what the list projection carries.
 *
 * Every leg is independently fallible. A knowledge base that 403s on this plan,
 * or an automations router gated off behind a licence, must not empty a result
 * list that also found four chats — so the fan-out is Promise.allSettled and
 * each group carries its own error.
 */


import { conversationSnippet, matches, snippetAround } from './format';
import type {
    AutomationSearchRow,
    ConversationSearchRow,
    KbDocumentRow,
    KbSearchHitRow,
    KbSearchResponseRow,
    KnowledgeBaseRow,
    NotebookSearchRow,
    SearchGroupKey,
    SearchGroupResult,
    SearchHit,
    SearchResults,
    TranscriptSearchRow,
} from './types';
import { SEARCH_GROUPS } from './types';
import { api } from '../../api/client';
import { translate } from '../../i18n';
import { relativeTime } from '../../lib/time';
import { DESTINATIONS, isReachable, matchesSearch } from '../settings/sitemap';

export const searchKeys = {
    all: ['search'] as const,
    /** Per-query server results. The term is part of the key, so React Query caches it. */
    query: (term: string) => ['search', 'query', term] as const,
    /** The three query-less lists, shared across every term the user types. */
    corpus: ['search', 'corpus'] as const,
    /** Recent terms, persisted on the device. See recent.ts. */
    recent: ['search', 'recent'] as const,
};

/**
 * Below this the server answers an empty array anyway
 * (conversations_meta.js refuses `q.length < 2`), so nothing is dispatched.
 */
export const MIN_QUERY_LENGTH = 2;

/** How many bases the document fan-out is allowed to touch. */
const MAX_DOCUMENT_BASES = 8;
const PER_GROUP_LIMIT = 8;

type GroupErrors = Partial<Record<SearchGroupKey, unknown>>;

// ── The query-less lists ─────────────────────────────────────────────

/** A document plus the base it came out of — the base is what a tap opens. */
export interface CorpusDocument extends KbDocumentRow {
    kbName: string;
}

export interface SearchCorpus {
    knowledgeBases: KnowledgeBaseRow[];
    documents: CorpusDocument[];
    automations: AutomationSearchRow[];
    transcripts: TranscriptSearchRow[];
    errors: GroupErrors;
}

export const EMPTY_CORPUS: SearchCorpus = {
    knowledgeBases: [],
    documents: [],
    automations: [],
    transcripts: [],
    errors: {},
};

/**
 * Fetch everything that cannot be searched server-side.
 *
 * The document leg is a fan-out over knowledge bases, because `documents` rows
 * are always read through a base and there is no cross-base endpoint. It is
 * bounded by MAX_DOCUMENT_BASES and tolerant of one base failing — a user who
 * can LIST a base but not READ it must not lose the whole group.
 */
export async function fetchSearchCorpus(signal?: AbortSignal): Promise<SearchCorpus> {
    const errors: GroupErrors = {};

    const [basesResult, automationsResult, transcriptsResult] = await Promise.allSettled([
        api.get<KnowledgeBaseRow[]>('/api/kb', { signal }),
        api.get<{ automations: AutomationSearchRow[] }>('/api/automation', { signal }),
        api.get<{ transcriptions: TranscriptSearchRow[] }>('/api/transcriptions', {
            signal,
            query: { limit: 100 },
        }),
    ]);

    let knowledgeBases: KnowledgeBaseRow[] = [];
    if (basesResult.status === 'fulfilled') {
        knowledgeBases = basesResult.value ?? [];
    } else {
        // One failure, two groups: documents are read THROUGH the bases, so a
        // failed base list takes the documents with it.
        errors.knowledge = basesResult.reason;
        errors.documents = basesResult.reason;
    }

    let automations: AutomationSearchRow[] = [];
    if (automationsResult.status === 'fulfilled') {
        // `kind: 'block'` rows are reusable Steps, not routines — they have no
        // trigger and cannot be opened as a routine.
        automations = (automationsResult.value?.automations ?? []).filter(
            (row) => (row.kind ?? 'automation') !== 'block',
        );
    } else {
        errors.automations = automationsResult.reason;
    }

    let transcripts: TranscriptSearchRow[] = [];
    if (transcriptsResult.status === 'fulfilled') {
        transcripts = transcriptsResult.value?.transcriptions ?? [];
    } else {
        errors.transcripts = transcriptsResult.reason;
    }

    const documents: CorpusDocument[] = [];
    if (knowledgeBases.length > 0) {
        const chosen = knowledgeBases.slice(0, MAX_DOCUMENT_BASES);
        const pages = await Promise.allSettled(
            chosen.map(async (kb) => {
                const page = await api.get<{ documents: KbDocumentRow[] }>(
                    `/api/kb/${encodeURIComponent(kb.id)}/documents`,
                    { signal, query: { limit: 100 } },
                );
                return (page?.documents ?? []).map<CorpusDocument>((doc) => ({
                    ...doc,
                    kbName: kb.name,
                }));
            }),
        );
        let failed = 0;
        let firstReason: unknown = null;
        for (const page of pages) {
            if (page.status === 'fulfilled') {
                documents.push(...page.value);
            } else {
                failed++;
                if (firstReason === null) firstReason = page.reason;
            }
        }
        // Only report a document error when EVERY base refused; one unreadable
        // base is a normal sharing outcome, not a broken screen.
        if (failed > 0 && failed === chosen.length) errors.documents = firstReason;
    }

    return { knowledgeBases, documents, automations, transcripts, errors };
}

// ── The query-taking endpoints ───────────────────────────────────────

export interface ServerMatches {
    chats: ConversationSearchRow[];
    notebooks: NotebookSearchRow[];
    /** Retrieval hits from POST /api/kb/search — passages, not documents. */
    passages: KbSearchHitRow[];
    errors: GroupErrors;
}

export const EMPTY_MATCHES: ServerMatches = { chats: [], notebooks: [], passages: [], errors: {} };

/**
 * The three requests a keystroke is allowed to cost.
 *
 * `retry: false` throughout: a search is re-issued by the next keystroke
 * anyway, so a backed-off retry of a query the user has already replaced is
 * pure latency. The knowledge-base search additionally gets a long timeout —
 * it may embed the query and, on the search-service path, cross a network.
 */
export async function fetchServerMatches(
    term: string,
    signal?: AbortSignal,
): Promise<ServerMatches> {
    const errors: GroupErrors = {};

    const [chatsResult, notebooksResult, passagesResult] = await Promise.allSettled([
        api.get<ConversationSearchRow[]>('/agents/conversations/search', {
            signal,
            retry: false,
            query: { q: term, limit: 25 },
        }),
        api.get<{ notebooks: NotebookSearchRow[] }>('/api/notebooks', {
            signal,
            retry: false,
            query: { search: term, sort: 'activity', limit: 15 },
        }),
        // An empty kb_ids deliberately means "everything I can reach" — the
        // route treats it as a global search rather than an error (BFSF-216).
        api.post<KbSearchResponseRow>(
            '/api/kb/search',
            { query: term, kb_ids: [], top_k: PER_GROUP_LIMIT },
            { signal, retry: false, timeoutMs: 45_000 },
        ),
    ]);

    let chats: ConversationSearchRow[] = [];
    if (chatsResult.status === 'fulfilled') chats = chatsResult.value ?? [];
    else errors.chats = chatsResult.reason;

    let notebooks: NotebookSearchRow[] = [];
    if (notebooksResult.status === 'fulfilled') notebooks = notebooksResult.value?.notebooks ?? [];
    else errors.notebooks = notebooksResult.reason;

    let passages: KbSearchHitRow[] = [];
    if (passagesResult.status === 'fulfilled') {
        // The rows come back under `chunks` on the local pgvector path and
        // under `results` on the search-service path; the route only
        // normalises one direction, so read both.
        passages = passagesResult.value?.chunks ?? passagesResult.value?.results ?? [];
    } else {
        errors.documents = passagesResult.reason;
    }

    return { chats, notebooks, passages, errors };
}

// ── Merging ──────────────────────────────────────────────────────────

/**
 * Turn the two fetches into the rendered list.
 *
 * Pure and synchronous so the screen can re-derive it while a request is still
 * in flight: the corpus groups answer from cache the moment a character is
 * typed, and the server groups fill in underneath. That is the whole reason
 * the split exists.
 */
export function buildResults(
    term: string,
    corpus: SearchCorpus,
    matchesFromServer: ServerMatches,
    access: SearchAccess = { permissions: null, isAdmin: false },
): SearchResults {
    const q = term.trim().toLowerCase();
    const errors: GroupErrors = { ...corpus.errors, ...matchesFromServer.errors };

    const hits: Record<SearchGroupKey, SearchHit[]> = {
        places: placeHits(term, access),
        chats: chatHits(matchesFromServer.chats, term),
        notebooks: notebookHits(matchesFromServer.notebooks, term),
        documents: documentHits(corpus.documents, matchesFromServer.passages, term),
        knowledge: knowledgeHits(corpus.knowledgeBases, q),
        automations: automationHits(corpus.automations, q),
        transcripts: transcriptHits(corpus.transcripts, term),
    };

    const groups: SearchGroupResult[] = SEARCH_GROUPS.map((key) => ({
        key,
        hits: hits[key],
        error: errors[key] ?? null,
    }));

    return { groups, total: groups.reduce((sum, group) => sum + group.hits.length, 0) };
}

/**
 * Who is allowed to see which screen. Passed in rather than read from a hook so
 * buildResults stays pure and synchronous — see the note above it.
 */
export interface SearchAccess {
    permissions: readonly string[] | null;
    isAdmin: boolean;
}

/**
 * The app's own screens, as search results.
 *
 * Everything here already existed: `DESTINATIONS` is the directory More renders,
 * `matchesSearch` is the filter its own search field uses, and `isReachable` is
 * the permission check — all three exported, pure and already tested. They were
 * simply never wired to the magnifier that sits in ~45 headers, so the phone
 * could find the text inside a document but not the screen called "Integrations".
 *
 * `weight: 'hidden'` rows are INCLUDED deliberately: the sitemap's own comment
 * says hidden means "not rendered, but STILL SEARCHABLE", and those twelve rows
 * are exactly the ones nobody can find by browsing.
 */
function placeHits(term: string, access: SearchAccess): SearchHit[] {
    if (!term.trim()) return [];
    return DESTINATIONS.filter(
        (d) =>
            isReachable(d, access.permissions, access.isAdmin) &&
            // `translate` from module scope, not a hook: buildResults is pure
            // and synchronous. A Dutch user typing "instellingen" and an
            // English one typing "settings" both reach the same row.
            matchesSearch(d, term, translate),
    )
        .slice(0, 8)
        .map<SearchHit>((d) => ({
            key: `place:${d.id}`,
            group: 'places',
            title: d.label,
            subtitle: d.hint,
            // External destinations open a browser; the row still says where it
            // goes rather than pretending to be an in-app screen.
            meta: d.external ? 'Opens in browser' : undefined,
            href: d.href,
        }));
}

function chatHits(rows: ConversationSearchRow[], term: string): SearchHit[] {
    return rows.slice(0, 12).map<SearchHit>((row) => {
        const isDirect = row.kind !== 'agent';
        const snippet = conversationSnippet(row.messages_json, term);
        return {
            key: `chat:${row.kind ?? 'agent'}:${row.id}`,
            group: 'chats',
            title: row.title || 'Untitled chat',
            subtitle: snippet ?? (isDirect ? 'Matched in the title' : `${row.agent_name ?? 'Agent'} · matched in the title`),
            meta: relativeTime(row.updated_at),
            // Agent conversations have no screen on the phone yet; they open in
            // the agent's own chat on the web. Showing them anyway is the point
            // — "it exists, on your desktop" beats pretending it does not.
            href: isDirect ? `/chat/${row.id}` : null,
        };
    });
}

function notebookHits(rows: NotebookSearchRow[], term: string): SearchHit[] {
    return rows.slice(0, PER_GROUP_LIMIT).map<SearchHit>((row) => ({
        key: `notebook:${row.id}`,
        group: 'notebooks',
        title: row.name || 'Untitled notebook',
        subtitle:
            (row.description && snippetAround(row.description, term)) ||
            (row.preview && snippetAround(row.preview, term)) ||
            `${row.sourceCount} source${row.sourceCount === 1 ? '' : 's'}`,
        meta: relativeTime(row.lastActivityAt ?? row.updatedAt),
        href: `/notebooks/${row.id}`,
    }));
}

/**
 * Documents, from two directions at once.
 *
 * A title match is what someone means by "find my invoice PDF"; a passage
 * match from POST /api/kb/search is what they mean by "find where I wrote
 * about the invoice". Both belong in the same group, so passages are joined
 * back onto the corpus by `document_id` — which is the only way to recover the
 * knowledge base a chunk came from, since the chunk projection does not carry
 * `knowledge_base_id` (see the SELECT in core/kb/localKBIngest.js).
 */
function documentHits(
    documents: CorpusDocument[],
    passages: KbSearchHitRow[],
    term: string,
): SearchHit[] {
    const q = term.toLowerCase();
    const byId = new Map(documents.map((doc) => [String(doc.id).toLowerCase(), doc]));
    const seen = new Set<string>();
    const out: SearchHit[] = [];

    for (const passage of passages) {
        const docId = passage.document_id ? String(passage.document_id).toLowerCase() : null;
        const owner = docId ? byId.get(docId) : undefined;
        const key = `document:${docId ?? passage.chunk_id ?? passage.id ?? out.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            key,
            group: 'documents',
            title: owner?.title || passage.title || passage.source_uri || 'Untitled document',
            subtitle: snippetAround(passage.content ?? '', term),
            meta: owner?.kbName,
            // Unjoinable passage: the chunk is real but we cannot say which
            // base holds it, so the row informs without offering a dead tap.
            href: owner ? `/knowledge/${owner.knowledge_base_id}` : null,
        });
    }

    for (const doc of documents) {
        if (out.length >= PER_GROUP_LIMIT * 2) break;
        const key = `document:${String(doc.id).toLowerCase()}`;
        if (seen.has(key)) continue;
        if (!matches(doc.title, q) && !matches(doc.source_uri, q)) continue;
        seen.add(key);
        out.push({
            key,
            group: 'documents',
            title: doc.title || doc.source_uri || 'Untitled document',
            subtitle: `${doc.kbName} · ${doc.chunk_count} chunk${doc.chunk_count === 1 ? '' : 's'}`,
            meta: relativeTime(doc.created_at),
            href: `/knowledge/${doc.knowledge_base_id}`,
        });
    }

    return out;
}

function knowledgeHits(rows: KnowledgeBaseRow[], q: string): SearchHit[] {
    return rows
        .filter((row) => matches(row.name, q) || matches(row.description, q))
        .slice(0, PER_GROUP_LIMIT)
        .map<SearchHit>((row) => ({
            key: `kb:${row.id}`,
            group: 'knowledge',
            title: row.name,
            subtitle: row.description ?? undefined,
            meta: row.document_count === undefined ? undefined : `${row.document_count} docs`,
            href: `/knowledge/${row.id}`,
        }));
}

function automationHits(rows: AutomationSearchRow[], q: string): SearchHit[] {
    return rows
        .filter((row) => matches(row.title, q) || matches(row.description, q))
        .slice(0, PER_GROUP_LIMIT)
        .map<SearchHit>((row) => ({
            key: `automation:${row.id}`,
            group: 'automations',
            title: row.title || 'Untitled routine',
            subtitle: row.description ?? (row.isActive ? 'Active' : 'Paused'),
            meta: relativeTime(row.lastRunAt ?? row.updatedAt),
            href: `/automations/${row.id}`,
        }));
}

/**
 * Meeting notes match on the snippet the server ships FOR this purpose:
 * `transcriptSnippet` is the first 2000 characters of the raw text and its
 * doc comment says "for client-side search". Beyond those 2000 characters the
 * phone cannot see, which is exactly what the "searched on this device" note
 * on the group heading is warning about.
 */
function transcriptHits(rows: TranscriptSearchRow[], term: string): SearchHit[] {
    const q = term.toLowerCase();
    return rows
        .filter(
            (row) =>
                matches(row.title, q) ||
                matches(row.fileName, q) ||
                matches(row.transcriptSnippet, q) ||
                matches(row.summarySnippet, q),
        )
        .slice(0, PER_GROUP_LIMIT)
        .map<SearchHit>((row) => {
            const body = matches(row.transcriptSnippet, q)
                ? row.transcriptSnippet
                : matches(row.summarySnippet, q)
                  ? row.summarySnippet
                  : null;
            return {
                key: `transcript:${row.id}`,
                group: 'transcripts',
                title: row.title || row.fileName || 'Untitled recording',
                subtitle: body ? snippetAround(body, term) : (row.summarySnippet ?? undefined),
                meta: relativeTime(row.createdAt ?? row.updatedAt),
                href: `/recordings/${row.id}`,
            };
        });
}
