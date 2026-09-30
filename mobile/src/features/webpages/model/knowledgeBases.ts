/**
 * The knowledge bases a page's builder searches, as Settings edits them.
 *
 * `knowledgeBaseIds[0]` is not like the others once the page has sources:
 * source ingestion (server/agents/webpages/sourceIngestion.js) creates the
 * page's own knowledge base on the first source and files every later one
 * into `knowledgeBaseIds[0]`. Dropping or reordering it would orphan the
 * Knowledge tab and send the next upload into somebody's shared base. So it
 * is shown, locked, and always written back first.
 */

import type { Webpage } from './types';

/** The page's own base, when it has one. */
export function ownKnowledgeBaseId(webpage: Webpage): string | null {
    if (webpage.sourceCount <= 0) return null;
    return webpage.knowledgeBaseIds[0] ?? null;
}

/** The bases a person attached, i.e. everything but the page's own. */
export function attachedKnowledgeBaseIds(webpage: Webpage): string[] {
    const own = ownKnowledgeBaseId(webpage);
    return webpage.knowledgeBaseIds.filter((id) => id !== own);
}

/** What PUT /:id should store for a selection: the page's own base first, then the rest, once each. */
export function nextKnowledgeBaseIds(webpage: Webpage, selected: readonly string[]): string[] {
    const own = ownKnowledgeBaseId(webpage);
    const out = own ? [own] : [];
    for (const id of selected) if (!out.includes(id)) out.push(id);
    return out;
}

export function toggleId(ids: readonly string[], id: string): string[] {
    return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
