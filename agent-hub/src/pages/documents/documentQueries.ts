// The Documents screens' reads, through React Query: a document with the
// names of its people, the library pages, folders, starters, the composed
// preview the canvas shows, and who is signed in. The network calls stay in
// documentsApi.js (shared with the routine and app builders); this module is
// the caching and the types.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from '../../api/client';
import {
    documentRequest, fetchPreviewHtml, getDocumentView, listDocumentsPage,
} from './documentsApi';

/** A person the server named for this reader; `name` absent = unknown (a former member). */
export type People = Record<string, { name?: string }>;

export interface ContractSection { id: string; title?: string }

export interface StudioDocument {
    id: string;
    userId: string;
    name: string;
    docType: string;
    description?: string;
    bodyHtml: string;
    css?: string;
    settings?: Record<string, any>;
    kind?: string;
    visibility?: string;
    folderId?: string | null;
    categories?: string[];
    versionId: string;
    baselineVersionId?: string | null;
    projectId?: string | null;
    projectRole?: 'owner' | 'editor' | 'viewer';
    updatedBy?: string | null;
    updatedAt?: string;
    createdAt?: string;
    archived?: boolean;
    editable?: boolean;
    deletable?: boolean;
    contract?: { sections?: ContractSection[] };
    merge?: { merged: boolean; fromOthers: string[]; othersOutsideSections: boolean };
}

export interface LibraryRow {
    id: string;
    userId: string;
    name: string;
    docType: string;
    kind?: string;
    visibility?: string;
    categories?: string[];
    versionId?: string;
    projectId?: string | null;
    updatedBy?: string | null;
    updatedAt?: string;
    archived?: boolean;
    /** Notebook rows only: how many sources it reads. */
    sourceCount?: number;
}

export interface LibraryFilters {
    kind: 'document' | 'template' | 'section';
    query?: string;
    folderId?: string;
    category?: string;
    visibility?: string;
    docType?: string;
    sort?: 'updated' | 'name';
    offset: number;
    limit: number;
    archived?: boolean;
}

export interface Folder { id: string; name: string; parentId: string | null }

export interface Starter {
    id: string;
    name: string;
    docType: string;
    description?: string;
    settings?: { contract?: { parameters?: unknown[] } };
}

export const docKeys = {
    all: ['studio-documents'] as const,
    one: (id: string) => ['studio-documents', 'one', id] as const,
    library: (filters: LibraryFilters) => ['studio-documents', 'library', filters] as const,
    folders: ['studio-documents', 'folders'] as const,
    starters: (locale: string) => ['studio-documents', 'starters', locale] as const,
    preview: (id: string, reloadKey: number) => ['studio-documents', 'preview', id, reloadKey] as const,
    me: ['auth', 'session-user'] as const,
};

/** One document and the names of its owner and last editor. */
export function useDocumentView(id: string | null | undefined) {
    return useQuery({
        queryKey: docKeys.one(id || ''),
        enabled: !!id,
        queryFn: async () => (await getDocumentView(id!)) as { document: StudioDocument; people: People },
        // The editor owns the document once it is open; a refetch on focus
        // would hand it a body older than what is being typed. Dropped when
        // the editor closes, so opening it again reads the newest state.
        refetchOnWindowFocus: false,
        staleTime: Infinity,
        gcTime: 0,
    });
}

/** One library page; the previous page stays on screen while the next loads. */
export function useLibrary(filters: LibraryFilters) {
    return useQuery({
        queryKey: docKeys.library(filters),
        queryFn: async () => {
            const { archived, ...rest } = filters;
            return listDocumentsPage({
                ...rest,
                ...(archived ? { archived: '1' } : {}),
                folderId: rest.folderId,
            }) as Promise<{ documents: LibraryRow[]; total: number; people: People; notebooks?: boolean }>;
        },
        placeholderData: keepPreviousData,
    });
}

export function useFolders() {
    return useQuery({
        queryKey: docKeys.folders,
        queryFn: async () => ((await documentRequest('/folders')) as { folders: Folder[] }).folders || [],
    });
}

export function useStarters(locale: string, enabled: boolean) {
    return useQuery({
        queryKey: docKeys.starters(locale),
        enabled,
        queryFn: async () => ((await documentRequest(`/starters?locale=${encodeURIComponent(locale || 'en')}`)) as { starters: Starter[] }).starters || [],
        staleTime: 10 * 60_000,
    });
}

/** The composed document the canvas frame shows (sanitised by the server). */
export function usePreviewHtml(id: string, reloadKey: number, enabled = true) {
    return useQuery({
        queryKey: docKeys.preview(id, reloadKey),
        enabled: enabled && !!id,
        queryFn: ({ signal }) => fetchPreviewHtml(id, { signal }) as Promise<string>,
        staleTime: Infinity,
        gcTime: 0,
        refetchOnWindowFocus: false,
        retry: 1,
    });
}

export interface SessionUser { id: string; name?: string }

/** Who is signed in, for screens whose host did not say. */
export function useSessionUser(enabled: boolean) {
    return useQuery({
        queryKey: docKeys.me,
        enabled,
        staleTime: Infinity,
        queryFn: async (): Promise<SessionUser | null> => {
            const body = await apiClient.get<{ user?: { id?: string; displayName?: string; firstName?: string; username?: string } }>('/auth/user');
            const u = body?.user;
            if (!u?.id) return null;
            return { id: u.id, name: u.displayName || u.firstName || u.username || undefined };
        },
    });
}
