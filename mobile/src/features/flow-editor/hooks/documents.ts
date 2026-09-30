/**
 * The documents a "Fill in a document" step picks from, and a document's
 * contract (the values it asks for, its optional sections). The list is
 * searched as the person types, a moment after they stop; the previous
 * answer stays on screen meanwhile rather than flashing "Loading…". A failed
 * read is the query's error — "could not load your documents" — never an
 * empty list.
 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { documentKeys, getDocumentContract, listDocumentTemplates } from '../api/documents';

const STALE_MS = 5 * 60_000;
const DEBOUNCE_MS = 250;

/** The caller's fillable documents matching `term` (all of them when empty). */
export function useDocumentTemplates(term: string) {
    const [query, setQuery] = useState(term.trim());
    useEffect(() => {
        const next = term.trim();
        if (next === query) return undefined;
        const handle = setTimeout(() => setQuery(next), DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [term, query]);
    return useQuery({
        queryKey: documentKeys.templates(query),
        queryFn: ({ signal }) => listDocumentTemplates(query, signal),
        staleTime: STALE_MS,
        placeholderData: keepPreviousData,
    });
}

/**
 * One document's contract: at `versionId` (the pinned revision, or
 * 'baseline'), or — with `versionId` null — as the document is now. Asked for
 * only while `enabled` and a document is picked.
 */
export function useDocumentContract(documentId: string, versionId: string | null, enabled = true) {
    return useQuery({
        queryKey: documentKeys.contract(documentId, versionId),
        queryFn: ({ signal }) => getDocumentContract(documentId, versionId, signal),
        enabled: enabled && documentId !== '',
        staleTime: STALE_MS,
    });
}
