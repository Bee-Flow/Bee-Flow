// AI suggestions on a page: the ONLY place that knows the
// /api/studio-documents/:id/suggestions wire contract.
//
// The AI never changes a page others can see; it proposes changes that a
// person accepts or rejects one by one (or all at once). One cache entry per
// document holds every suggestion, open and resolved. The list is refetched
// when the document's stream or the project's feed says a batch arrived, and
// when the chat announces one (DOM event `beeflow:document-suggestions`).

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import useDocumentStream from '../../hooks/useDocumentStream';
import { useProjectLive } from '../../components/projects/workspace/ProjectLiveContext';
import { apiClient } from '../client';
import type { CommentAnchor } from './comments';

export type SuggestionStatus = 'open' | 'accepted' | 'rejected' | 'stale' | 'superseded';

export interface Suggestion {
    id: string;
    batchId: string;
    kind: string;
    status: SuggestionStatus;
    anchor: CommentAnchor;
    /** Top-level blocks (editor AST) the suggestion replaces; [] = a pure insert. */
    before: unknown[];
    /** The proposed blocks; [] = a pure delete. */
    after: unknown[];
    summary: string;
    authorKind: 'ai' | 'user';
    agentId?: string | null;
    createdAt: string;
}

export interface SuggestionsData { suggestions: Suggestion[]; open: number }

export interface ResolveResult { accepted: string[]; rejected: string[]; stale: string[]; versionId?: string | null }

/** The DOM event the chat stream turns `document_suggestions` into. */
export const SUGGESTIONS_DOM_EVENT = 'beeflow:document-suggestions';

const enc = encodeURIComponent;
const base = (documentId: string) => `/api/studio-documents/${enc(documentId)}/suggestions`;

export const suggestionKeys = {
    document: (documentId: string) => ['studio-documents', 'suggestions', documentId] as const,
};

export function invalidateSuggestions(qc: QueryClient, documentId: string) {
    return qc.invalidateQueries({ queryKey: suggestionKeys.document(documentId) });
}

/**
 * The suggestions of a document. `live` (default true) also listens for
 * changes: the document's stream, the project feed and the chat's DOM event.
 * A second reader of the same document passes `live: false` and shares the cache.
 */
export function useDocumentSuggestions(documentId: string | null | undefined, { live = true, enabled = true }: { live?: boolean; enabled?: boolean } = {}) {
    const qc = useQueryClient();
    const active = enabled && live && !!documentId;
    const stream = useDocumentStream(documentId, active);
    const project = useProjectLive();

    useEffect(() => {
        if (!active || !documentId) return undefined;
        return stream.subscribe('doc.suggestions', () => { void invalidateSuggestions(qc, documentId); });
    }, [active, documentId, stream, qc]);

    useEffect(() => {
        if (!active || !documentId) return undefined;
        return project.subscribe((kind, event) => {
            if (kind !== 'doc.suggestions') return;
            const p = event.payload || {};
            if (p.documentId && p.documentId !== documentId) return;
            void invalidateSuggestions(qc, documentId);
        });
    }, [active, documentId, project, qc]);

    useEffect(() => {
        if (!active || !documentId) return undefined;
        const onEvent = (e: Event) => {
            const detail = (e as CustomEvent<{ documentId?: string }>).detail;
            if (detail?.documentId && detail.documentId !== documentId) return;
            void invalidateSuggestions(qc, documentId);
        };
        window.addEventListener(SUGGESTIONS_DOM_EVENT, onEvent);
        return () => window.removeEventListener(SUGGESTIONS_DOM_EVENT, onEvent);
    }, [active, documentId, qc]);

    return useQuery<SuggestionsData, Error>({
        queryKey: suggestionKeys.document(documentId || ''),
        enabled: enabled && !!documentId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ suggestions?: Suggestion[]; open?: number }>(base(documentId!), { signal });
            const suggestions = Array.isArray(body?.suggestions) ? body!.suggestions! : [];
            return { suggestions, open: typeof body?.open === 'number' ? body.open : suggestions.filter(s => s.status === 'open').length };
        },
    });
}

export type SuggestionTarget = { kind: 'one'; id: string } | { kind: 'batch'; id: string };
export interface ResolveVars { target: SuggestionTarget; action: 'accept' | 'reject' }

function pathOf(documentId: string, { target, action }: ResolveVars): string {
    return target.kind === 'one'
        ? `${base(documentId)}/${enc(target.id)}/${action}`
        : `${base(documentId)}/batch/${enc(target.id)}/${action}`;
}

/**
 * Accept or reject one suggestion or a whole batch. The list is always
 * refetched (a 409 `suggestion_stale` also changes what the list says).
 * Accepting writes the page: `onAccepted` lets the editor show the new text
 * (the document query is not invalidated here, the open editor owns it and a
 * refetch would swap the body under the caret).
 */
export function useResolveSuggestions(documentId: string, { onAccepted }: { onAccepted?: (r: ResolveResult) => void } = {}) {
    const qc = useQueryClient();
    return useMutation<ResolveResult, Error, ResolveVars>({
        mutationFn: async (vars) => {
            const body = await apiClient.post<Partial<ResolveResult>>(pathOf(documentId, vars), {}, { retry: false });
            return {
                accepted: body?.accepted || [], rejected: body?.rejected || [], stale: body?.stale || [],
                versionId: body?.versionId ?? null,
            };
        },
        onSettled: (_data, _err, vars) => {
            void invalidateSuggestions(qc, documentId);
        },
        onSuccess: (data, vars) => { if (vars.action === 'accept' && data.accepted.length) onAccepted?.(data); },
    });
}
