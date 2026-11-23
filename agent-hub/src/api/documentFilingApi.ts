/**
 * Filing a person's own document into one of their projects (the "Add to
 * project" action on the form under a chat answer):
 *
 *   GET /api/projects?kind=workspace     the projects, with the caller's permission on each
 *   PUT /api/projects/:id/resources      { kind: 'document', id, attach: true }
 *
 * The server checks the rest: editor of the project, owner of the document.
 *
 * And putting a document of a project in one of the project's folders (the
 * Documents tab's folders, shared by the members: a customer's folder, say),
 * making the folder when it does not exist yet:
 *
 *   GET  /api/projects/:id/document-folders             { folders, placements }
 *   POST /api/projects/:id/document-folders             { name }
 *   PUT  /api/projects/:id/document-folders/placement   { documentId, folderId | null }
 */
import { apiJson } from './typedRequest';
import { documentFoldersOf, type DocumentFolders } from './queries/projectDocumentFolders';

export interface FilingTarget {
    id: string;
    name: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The projects a document can go into: the ones the caller owns or edits. */
export function filingTargetsOf(body: unknown): FilingTarget[] {
    if (!Array.isArray(body)) return [];
    return body
        .filter((p): p is Record<string, unknown> => isObject(p) && typeof p.id === 'string'
            && (p.permission === 'owner' || p.permission === 'editor'))
        .map((p) => ({ id: String(p.id), name: typeof p.name === 'string' && p.name ? p.name : String(p.id) }));
}

async function listFilingTargets(): Promise<FilingTarget[]> {
    return filingTargetsOf(await apiJson('GET /api/projects', { query: { kind: 'workspace' } }));
}

async function addDocumentToProject(projectId: string, documentId: string): Promise<void> {
    await apiJson('PUT /api/projects/{id}/resources', { params: { id: projectId }, body: { kind: 'document', id: documentId, attach: true } });
}

/** Where a project's members open the document. */
export const projectDocumentUrl = (projectId: string, documentId: string): string =>
    `/app/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`;

interface FolderChoice {
    /** An existing folder, or null for none. Ignored when `newName` is given. */
    folderId: string | null;
    /** A folder to make first. */
    newName?: string;
}

function listProjectFolders(projectId: string): Promise<DocumentFolders> {
    return apiJson('GET /api/projects/{id}/document-folders', { params: { id: projectId } }).then(documentFoldersOf);
}

/** Put the document in the chosen folder (made first when it is a new one); the folder it ended up in, or null for none. */
async function placeInProjectFolder(projectId: string, documentId: string, choice: FolderChoice): Promise<{ id: string; name: string } | null> {
    let folder: { id: string; name: string } | null = null;
    const name = choice.newName?.trim();
    if (name) {
        const made = await apiJson<'POST /api/projects/{id}/document-folders', { folder?: { id?: unknown; name?: unknown } }>(
            'POST /api/projects/{id}/document-folders', { params: { id: projectId }, body: { name } });
        if (typeof made.folder?.id !== 'string') throw new Error('The folder could not be made.');
        folder = { id: made.folder.id, name: typeof made.folder.name === 'string' ? made.folder.name : name };
    }
    const folderId = folder ? folder.id : choice.folderId;
    await apiJson('PUT /api/projects/{id}/document-folders/placement', { params: { id: projectId }, body: { documentId, folderId } });
    return folder || (folderId ? { id: folderId, name: '' } : null);
}

/** Filing a document in a project and its folders; a test hands in its own. */
export interface FilingApi {
    targets: () => Promise<FilingTarget[]>;
    add: (projectId: string, documentId: string) => Promise<void>;
    folders: (projectId: string) => Promise<DocumentFolders>;
    place: (projectId: string, documentId: string, choice: FolderChoice) => Promise<{ id: string; name: string } | null>;
}

export const filingApi: FilingApi = { targets: listFilingTargets, add: addDocumentToProject, folders: listProjectFolders, place: placeInProjectFolder };
