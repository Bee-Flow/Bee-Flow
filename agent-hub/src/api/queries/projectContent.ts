// Project content: the wire contract behind the workspace's content tabs.
//
// What is already filed in a project comes from GET /api/projects/:id/resources
// (useProjectResourcesQuery in projects.ts), and filing an item in or out is
// useAttachResource there too. This module adds what those two do not cover:
// creating a document or notebook straight inside a project, the project's own
// files, and the caller's own items for the "add existing" pickers.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { apiClient } from '../client';
import { projectErrorFromResponse, toProjectError } from './projectErrors';
import { projectKeys, useProjectResourcesQuery } from './projects';

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A document filed in a project (the resources card, no body). */
export interface ProjectDocument {
    id: string;
    name: string;
    docType?: string;
    kind?: string;
    userId?: string;
    projectId?: string | null;
    updatedAt?: string;
    createdAt?: string;
}

/** A meeting filed in a project (the resources card, no transcript text). */
export interface ProjectMeeting {
    id: string;
    title?: string;
    userId?: string;
    projectId?: string | null;
    status?: string;
    durationSeconds?: number | null;
    actionItemCount?: number | null;
    createdAt?: string;
    updatedAt?: string;
}

/** A notebook filed in a project (the notebook card projection). */
export interface ProjectNotebook {
    id: string;
    name: string;
    description?: string;
    preview?: string;
    userId?: string;
    sourceCount?: number;
    messageCount?: number;
    docWordCount?: number;
    sourceWordCount?: number;
    processingCount?: number;
    failedCount?: number;
    lastActivityAt?: string | null;
    /** Who changed the document last (a user id), and when: "Edited by Anna · 5m ago". */
    lastEditedBy?: string | null;
    lastEditedAt?: string | null;
    updatedAt?: string;
    createdAt?: string;
}

/** A knowledge base linked to a project. */
export interface ProjectKnowledgeBase {
    id: string;
    name: string;
    description?: string;
    icon?: string | null;
}

export type ProjectFileStatus = 'ready' | 'processing' | 'failed';

/** A file uploaded straight into the project. */
export interface ProjectFile {
    id: string;
    name: string;
    /** Null when the upload carried no type the server recognised. */
    mimeType?: string | null;
    size?: number | null;
    status: ProjectFileStatus;
    /** Why a failed file failed (the server's sentence); null otherwise. */
    statusReason?: string | null;
    /** Personal data in it was replaced by placeholders before it was stored. */
    redacted?: boolean;
    uploadedBy?: string | null;
    createdAt?: string;
}

export interface ProjectFiles {
    files: ProjectFile[];
    /** The knowledge base holding the files; null until the first upload. */
    kbId: string | null;
}

/** One of the caller's documents, as the document library lists it. */
export interface MyDocument {
    id: string;
    name: string;
    docType?: string;
    userId?: string;
    projectId?: string | null;
    updatedAt?: string;
}

/** One of the caller's notebooks, as the notebook library lists it. */
export interface MyNotebook {
    id: string;
    name: string;
    projectId?: string | null;
    lastActivityAt?: string | null;
    updatedAt?: string;
}

/** A meeting the caller may read; only `isOwner` ones can be filed. */
export interface MyMeeting {
    id: string;
    title?: string;
    isOwner?: boolean;
    projectId?: string | null;
    status?: string;
    durationSeconds?: number | null;
    createdAt?: string;
}

/** A knowledge base the caller may read (raw row from GET /api/kb). */
export interface ReadableKnowledgeBase {
    id: string;
    name: string;
    description?: string | null;
    organization_id?: string | null;
    source_kind?: string | null;
}

/** Content sections of GET /api/projects/:id/resources. */
export type ContentSection = 'documents' | 'notebooks' | 'meetings' | 'knowledgeBases';

/** The same ceiling as knowledge-base ingestion on the server. */
export const MAX_PROJECT_FILE_BYTES = 20 * 1024 * 1024;

const enc = encodeURIComponent;

export const contentKeys = {
    mine: (what: 'documents' | 'notebooks' | 'meetings' | 'knowledge-bases') => ['project-content', 'mine', what] as const,
};

// ── What is filed in the project ────────────────────────────────────────────

export interface SectionState<T> {
    status: 'loading' | 'error' | 'ok';
    items: T[];
    refetch: () => void;
}

/**
 * One content section of the project's resources. A section the server
 * answered with `null` (its store could not be read) is an ERROR, never an
 * empty list: "could not load" must not read as "nothing here". A section left
 * out is an error too, unless the answer names the project's kind: the server
 * then left it out because this kind of project does not hold it (a Studio
 * Solution has no documents or meetings), so there is genuinely nothing.
 */
export function useProjectSection<T>(projectId: string, section: ContentSection): SectionState<T> {
    const query = useProjectResourcesQuery(projectId);
    const refetch = () => { query.refetch(); };
    if (query.isPending) return { status: 'loading', items: [], refetch };
    const raw = query.data?.[section];
    if (!query.isError && raw === undefined && typeof query.data?.kind === 'string') return { status: 'ok', items: [], refetch };
    if (query.isError || !Array.isArray(raw)) return { status: 'error', items: [], refetch };
    return { status: 'ok', items: raw as T[], refetch };
}

// ── Create inside the project ───────────────────────────────────────────────

function useInvalidateContent(projectId: string) {
    const qc = useQueryClient();
    return () => {
        qc.invalidateQueries({ queryKey: projectKeys.resources(projectId) });
        qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
    };
}

export interface NewDocumentVars { name: string; docType?: string; locale?: string }

export function useCreateProjectDocument(projectId: string) {
    const invalidate = useInvalidateContent(projectId);
    return useMutation<ProjectDocument, Error, NewDocumentVars>({
        mutationFn: async (vars) => {
            let body: { document?: ProjectDocument } | null;
            try {
                body = await apiClient.post<{ document?: ProjectDocument }>(`/api/projects/${enc(projectId)}/documents`, vars, { retry: false });
            } catch (e) {
                throw toProjectError(e, 'Could not create the document');
            }
            if (!body?.document?.id) throw new Error('Could not create the document');
            return body.document;
        },
        onSuccess: invalidate,
    });
}

export interface NewNotebookVars { name: string; description?: string }

export function useCreateProjectNotebook(projectId: string) {
    const invalidate = useInvalidateContent(projectId);
    return useMutation<ProjectNotebook, Error, NewNotebookVars>({
        mutationFn: async (vars) => {
            let body: { notebook?: ProjectNotebook } | null;
            try {
                body = await apiClient.post<{ notebook?: ProjectNotebook }>(`/api/projects/${enc(projectId)}/notebooks`, vars, { retry: false });
            } catch (e) {
                throw toProjectError(e, 'Could not create the notebook');
            }
            if (!body?.notebook?.id) throw new Error('Could not create the notebook');
            return body.notebook;
        },
        onSuccess: invalidate,
    });
}

// ── Project files ───────────────────────────────────────────────────────────

const FILE_POLL_MS = 4000;

export function useProjectFilesQuery(projectId: string | null | undefined) {
    return useQuery<ProjectFiles, Error>({
        queryKey: projectKeys.files(projectId || ''),
        enabled: !!projectId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ files?: ProjectFile[]; kbId?: string | null }>(
                `/api/projects/${enc(projectId!)}/files`, { signal },
            );
            return { files: Array.isArray(body?.files) ? body!.files! : [], kbId: body?.kbId ?? null };
        },
        // A file is indexed after the upload answers; keep asking until every
        // one has settled, then stop.
        refetchInterval: (query) => (query.state.data?.files.some(f => f.status === 'processing') ? FILE_POLL_MS : false),
    });
}

/**
 * Multipart upload, so it goes through authFetch: apiClient only sends JSON.
 * The server scans and indexes the file with the same checks as any
 * knowledge-base upload.
 */
export function useUploadProjectFile(projectId: string) {
    const qc = useQueryClient();
    return useMutation<ProjectFile, Error, File>({
        mutationFn: async (file) => {
            const form = new FormData();
            form.append('file', file);
            let res: Response;
            try {
                res = await authFetch(`${API_BASE}/api/projects/${enc(projectId)}/files`, { method: 'POST', body: form });
            } catch {
                throw new Error('Could not upload the file');
            }
            let body: { file?: ProjectFile; error?: string } | null = null;
            try { body = await res.json(); } catch { /* not JSON */ }
            if (!res.ok) {
                throw projectErrorFromResponse(res.status, body,
                    res.status === 413 ? 'This file is larger than the upload limit' : 'Could not upload the file');
            }
            if (!body?.file?.id) throw new Error('Could not upload the file');
            return body.file;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.files(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
        },
    });
}

export function useDeleteProjectFile(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (fileId) => {
            try {
                await apiClient.delete(`/api/projects/${enc(projectId)}/files/${enc(fileId)}`, { retry: false });
            } catch (e) {
                throw toProjectError(e, 'Could not delete the file');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.files(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
        },
    });
}

// ── The caller's own items, for the "add existing" pickers ──────────────────

export function useMyDocumentsQuery(enabled: boolean) {
    return useQuery<MyDocument[], Error>({
        queryKey: contentKeys.mine('documents'),
        enabled,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ documents?: MyDocument[] }>('/api/studio-documents', {
                signal, query: { kind: 'document', sort: 'updated', limit: 100 },
            });
            return Array.isArray(body?.documents) ? body!.documents! : [];
        },
    });
}

export function useMyNotebooksQuery(enabled: boolean) {
    return useQuery<MyNotebook[], Error>({
        queryKey: contentKeys.mine('notebooks'),
        enabled,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ notebooks?: MyNotebook[] }>('/api/notebooks', {
                signal, query: { sort: 'activity', limit: 60 },
            });
            return Array.isArray(body?.notebooks) ? body!.notebooks! : [];
        },
    });
}

/** Only the caller's OWN meetings: a meeting someone published to the org
 *  can be read, but only its owner may file it into a project. */
export function useMyMeetingsQuery(enabled: boolean) {
    return useQuery<MyMeeting[], Error>({
        queryKey: contentKeys.mine('meetings'),
        enabled,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ transcriptions?: MyMeeting[] }>('/api/transcriptions', {
                signal, query: { limit: 100 },
            });
            const rows = Array.isArray(body?.transcriptions) ? body!.transcriptions! : [];
            return rows.filter(m => m.isOwner !== false);
        },
    });
}

export function useReadableKnowledgeBasesQuery(enabled: boolean) {
    return useQuery<ReadableKnowledgeBase[], Error>({
        queryKey: contentKeys.mine('knowledge-bases'),
        enabled,
        queryFn: async ({ signal }) => {
            const rows = await apiClient.get<ReadableKnowledgeBase[]>('/api/kb', { signal });
            return Array.isArray(rows) ? rows : [];
        },
    });
}
