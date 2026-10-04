/**
 * The notebook page's reads and writes through react-query: the notebook as
 * it opens (with the caller's role, its project and whether it is co-edited),
 * the caller's private chat with it, and renaming.
 *
 *   GET    /api/notebooks/:id                → { notebook, sources, project, collab }
 *   GET    /api/notebooks/:id/conversation   → { messages, locked }
 *   PUT    /api/notebooks/:id { name }       → { success, version }
 *   DELETE /api/notebooks/:id/conversation   → { success }
 *
 * The notebook read is taken ONCE per open: the editor owns the document from
 * then on (its own saves, or the live co-editing session), so this query never
 * refetches behind it on focus or reconnect.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../api/client';
import type { NotebookSource } from './hooks/useSourcesPolling';

export type NotebookRole = 'owner' | 'editor' | 'viewer';

export interface NotebookRecord {
    id: string;
    userId: string;
    name: string;
    description?: string;
    documentContent: string;
    documentMd?: string | null;
    version: number;
    projectId: string | null;
    role: NotebookRole;
    projectRole?: 'owner' | 'editor' | 'viewer';
    lastEditedBy?: string | null;
    lastEditedAt?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    /** The `managed` of the GET (managedPart.managedOf), when a Solution stage owns the notebook. */
    managed?: unknown;
}

export interface NotebookProjectSummary {
    id: string;
    name: string;
    kind: 'workspace' | 'solution' | null;
    color: string | null;
    icon: string | null;
    /** The caller's role on the PROJECT. */
    role: 'owner' | 'editor' | 'viewer';
}

export interface NotebookDetailData {
    notebook: NotebookRecord;
    sources: NotebookSource[];
    project: NotebookProjectSummary | null;
    collab: { eligible: boolean };
}

export interface ChatHistoryMessage {
    id?: string;
    role: string;
    content: unknown;
    [key: string]: unknown;
}

export const notebookKeys = {
    all: ['notebooks'] as const,
    detail: (id: string) => ['notebooks', 'detail', id] as const,
    conversation: (id: string) => ['notebooks', 'conversation', id] as const,
};

/** Can this role change the notebook? */
export const canEditNotebook = (role: NotebookRole | null | undefined): boolean => role === 'owner' || role === 'editor';

function normalizeDetail(raw: unknown): NotebookDetailData {
    const data = (raw || {}) as Partial<NotebookDetailData> & { notebook?: Partial<NotebookRecord> };
    const nb = (data.notebook || {}) as NotebookRecord;
    return {
        notebook: { ...nb, role: nb.role || 'owner', projectId: nb.projectId ?? null, version: nb.version ?? 0 },
        sources: Array.isArray(data.sources) ? data.sources : [],
        project: data.project || null,
        collab: { eligible: !!data.collab?.eligible },
    };
}

export function useNotebookDetail(id: string | null) {
    return useQuery({
        queryKey: notebookKeys.detail(id || ''),
        queryFn: async ({ signal }) => normalizeDetail(await apiClient.get(`/api/notebooks/${encodeURIComponent(id || '')}`, { signal, retry: false })),
        enabled: !!id,
        staleTime: Infinity,
        gcTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: false,
    });
}

export function useNotebookConversation(id: string | null) {
    return useQuery({
        queryKey: notebookKeys.conversation(id || ''),
        queryFn: async ({ signal }) => {
            const data = (await apiClient.get<{ messages?: ChatHistoryMessage[]; locked?: boolean }>(
                `/api/notebooks/${encodeURIComponent(id || '')}/conversation`, { signal, retry: false },
            )) || {};
            return { messages: Array.isArray(data.messages) ? data.messages : [], locked: !!data.locked };
        },
        enabled: !!id,
        staleTime: Infinity,
        gcTime: 0,
        refetchOnWindowFocus: false,
        retry: false,
    });
}

/** Rename the notebook; the open detail is updated in place. */
export function useRenameNotebook(id: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (name: string) => apiClient.put(`/api/notebooks/${encodeURIComponent(id)}`, { name }, { retry: false }),
        onSuccess: (_data, name) => {
            qc.setQueryData<NotebookDetailData>(notebookKeys.detail(id), (prev) => (prev ? { ...prev, notebook: { ...prev.notebook, name } } : prev));
        },
    });
}

/** Start the private chat over (the history is deleted for the caller only). */
export function useClearNotebookChat(id: string) {
    return useMutation({
        mutationFn: () => apiClient.delete(`/api/notebooks/${encodeURIComponent(id)}/conversation`, { retry: false }),
    });
}
