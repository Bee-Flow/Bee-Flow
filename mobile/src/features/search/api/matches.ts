/**
 * Global search, the SERVER-SEARCHED half: conversations, notebooks and
 * knowledge-base passages each have an endpoint that takes the query, so they
 * are re-run per debounce. These are the only three requests a keystroke can
 * cause.
 *
 *     routes/agents/conversations_meta.js → /agents      ← NOT /api/…
 *     routes/notebooks.js                 → /api/notebooks
 *     routes/knowledgeBases/search.js     → /api/kb/search (the knowledge
 *                                           feature's searchKnowledgeBases)
 */

import { api } from '@/core/api/client';
import { searchKnowledgeBases } from '@/features/knowledge';

import { readConversationRows, readNotebooks } from './readers';
import type { ConversationSearchRow, GroupErrors, KbSearchHitRow, NotebookSearchRow, ServerMatches } from '../model/types';

/**
 * Below this the server answers an empty array anyway
 * (conversations_meta.js refuses `q.length < 2`), so nothing is dispatched.
 */
export const MIN_QUERY_LENGTH = 2;

/** How many passages the knowledge-base search returns. */
const PASSAGE_LIMIT = 8;

/**
 * The three requests a keystroke is allowed to cost.
 *
 * `retry: false` throughout: a search is re-issued by the next keystroke
 * anyway, so a backed-off retry of a query the user has already replaced is
 * pure latency. The knowledge-base search additionally gets a long timeout —
 * it may embed the query and, on the search-service path, cross a network.
 */
export async function fetchServerMatches(term: string, signal?: AbortSignal): Promise<ServerMatches> {
    const errors: GroupErrors = {};

    const [chatsResult, notebooksResult, passagesResult] = await Promise.allSettled([
        api.get<unknown>('/agents/conversations/search', { signal, retry: false, query: { q: term, limit: 25 } }),
        api.get<unknown>('/api/notebooks', {
            signal,
            retry: false,
            query: { search: term, sort: 'activity', limit: 15 },
        }),
        // No bases named: everything this person can reach (BFSF-216).
        searchKnowledgeBases(term, [], PASSAGE_LIMIT, signal),
    ]);

    let chats: ConversationSearchRow[] = [];
    if (chatsResult.status === 'fulfilled') chats = readConversationRows(chatsResult.value);
    else errors.chats = chatsResult.reason;

    let notebooks: NotebookSearchRow[] = [];
    if (notebooksResult.status === 'fulfilled') notebooks = readNotebooks(notebooksResult.value);
    else errors.notebooks = notebooksResult.reason;

    let passages: KbSearchHitRow[] = [];
    if (passagesResult.status === 'fulfilled') passages = passagesResult.value;
    else errors.documents = passagesResult.reason;

    return { chats, notebooks, passages, errors };
}
