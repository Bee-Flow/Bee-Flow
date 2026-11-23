/**
 * The folders of a project's Documents tab, shared by its members
 * (server/routes/projects/documentFolders.mts):
 *
 *   GET    /api/projects/:id/document-folders            { folders, placements: { documentId: folderId } }
 *   POST   /api/projects/:id/document-folders            { name }
 *   PATCH  /api/projects/:id/document-folders/:folderId  { name }
 *   DELETE /api/projects/:id/document-folders/:folderId  its documents go back to the top
 *   PUT    /api/projects/:id/document-folders/placement  { documentId, folderId | null }
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiJson } from '../typedRequest';

export interface DocumentFolder {
    id: string;
    name: string;
    createdBy: string;
    createdAt: string;
}

export interface DocumentFolders {
    folders: DocumentFolder[];
    placements: Record<string, string>;
}

const documentFolderKey = (projectId: string) => ['projects', projectId, 'document-folders'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The answer read defensively: unknown shapes become "no folders". */
export function documentFoldersOf(body: unknown): DocumentFolders {
    const b = isObject(body) ? body : {};
    const folders = (Array.isArray(b.folders) ? b.folders : [])
        .filter((f): f is Record<string, unknown> => isObject(f) && typeof f.id === 'string' && typeof f.name === 'string')
        .map((f) => ({ id: String(f.id), name: String(f.name), createdBy: String(f.createdBy ?? ''), createdAt: String(f.createdAt ?? '') }));
    const placements: Record<string, string> = {};
    if (isObject(b.placements)) {
        for (const [doc, folder] of Object.entries(b.placements)) if (typeof folder === 'string') placements[doc] = folder;
    }
    return { folders, placements };
}

export function useDocumentFolders(projectId: string) {
    return useQuery({
        queryKey: documentFolderKey(projectId),
        queryFn: async () => documentFoldersOf(await apiJson('GET /api/projects/{id}/document-folders', { params: { id: projectId } })),
        enabled: !!projectId,
    });
}

/** Make, rename, delete a folder and move a document; every one refreshes the folders. */
export function useDocumentFolderActions(projectId: string) {
    const qc = useQueryClient();
    const settle = { onSettled: () => qc.invalidateQueries({ queryKey: documentFolderKey(projectId) }) };
    const create = useMutation({
        mutationFn: (name: string) => apiJson('POST /api/projects/{id}/document-folders', { params: { id: projectId }, body: { name } }),
        ...settle,
    });
    const rename = useMutation({
        mutationFn: ({ folderId, name }: { folderId: string; name: string }) =>
            apiJson('PATCH /api/projects/{id}/document-folders/{folderId}', { params: { id: projectId, folderId }, body: { name } }),
        ...settle,
    });
    const remove = useMutation({
        mutationFn: (folderId: string) => apiJson('DELETE /api/projects/{id}/document-folders/{folderId}', { params: { id: projectId, folderId } }),
        ...settle,
    });
    const place = useMutation({
        mutationFn: ({ documentId, folderId }: { documentId: string; folderId: string | null }) =>
            apiJson('PUT /api/projects/{id}/document-folders/placement', { params: { id: projectId }, body: { documentId, folderId } }),
        ...settle,
    });
    return { create, rename, remove, place };
}
