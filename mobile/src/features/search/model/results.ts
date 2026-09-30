/**
 * The rules for merging the two fetches into one rendered list.
 *
 * Pure and synchronous so the screen can re-derive it while a request is still
 * in flight: the corpus groups answer from cache the moment a character is
 * typed, and the server groups fill in underneath. That is the whole reason
 * the corpus/server split exists (api/corpus.ts, api/matches.ts).
 */

import { buildAccessSnapshot } from '@/core/access';
import { translate } from '@/core/i18n';
import { DESTINATIONS, isReachable, matchesSearch } from '@/features/sitemap';

import { automationHits, chatHits, documentHits, knowledgeHits, notebookHits, transcriptHits } from './hits';
import {
    SEARCH_GROUPS,
    type GroupErrors,
    type SearchAccess,
    type SearchCorpus,
    type SearchGroupKey,
    type SearchGroupResult,
    type SearchHit,
    type SearchResults,
    type ServerMatches,
} from './types';

export type { SearchAccess } from './types';

export const EMPTY_CORPUS: SearchCorpus = {
    knowledgeBases: [],
    documents: [],
    automations: [],
    transcripts: [],
    errors: {},
};

export const EMPTY_MATCHES: ServerMatches = { chats: [], notebooks: [], passages: [], errors: {} };

/** Nobody signed in: no permission, no role, every person gate shut. */
const NO_ACCESS: SearchAccess = buildAccessSnapshot({ user: null, permissions: null });

/**
 * The app's own screens, as search results.
 *
 * Everything here already existed: `DESTINATIONS` is the map /sitemap renders,
 * `matchesSearch` is the filter its own search field uses, and `isReachable` is
 * the core/access gate. Settings children and the other rows the drawer does
 * not list are INCLUDED deliberately: they are exactly the ones nobody can
 * find by browsing.
 */
function placeHits(term: string, access: SearchAccess): SearchHit[] {
    if (!term.trim()) return [];
    return DESTINATIONS.filter(
        (d) =>
            isReachable(d, access) &&
            // `translate` from module scope, not a hook: this is pure and
            // synchronous. A Dutch user typing "instellingen" and an English
            // one typing "settings" both reach the same row.
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

export function buildResults(
    term: string,
    corpus: SearchCorpus,
    matchesFromServer: ServerMatches,
    access: SearchAccess = NO_ACCESS,
): SearchResults {
    const q = term.trim().toLowerCase();
    const errors: GroupErrors = { ...corpus.errors, ...matchesFromServer.errors };

    const hits: Record<SearchGroupKey, SearchHit[]> = {
        // Screens the caller may not open must not appear — a row that 403s
        // is worse than no row.
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
