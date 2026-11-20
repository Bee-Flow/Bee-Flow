/**
 * Filing a person's own document into one of their projects (the "Add to
 * project" action on the form under a chat answer):
 *
 *   GET /api/projects?kind=workspace     the projects, with the caller's permission on each
 *   PUT /api/projects/:id/resources      { kind: 'document', id, attach: true }
 *
 * The server checks the rest: editor of the project, owner of the document.
 */
import { apiJson } from './typedRequest';

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

export async function listFilingTargets(): Promise<FilingTarget[]> {
    return filingTargetsOf(await apiJson('GET /api/projects', { query: { kind: 'workspace' } }));
}

export async function addDocumentToProject(projectId: string, documentId: string): Promise<void> {
    await apiJson('PUT /api/projects/{id}/resources', { params: { id: projectId }, body: { kind: 'document', id: documentId, attach: true } });
}

/** Where a project's members open the document. */
export const projectDocumentUrl = (projectId: string, documentId: string): string =>
    `/app/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`;
