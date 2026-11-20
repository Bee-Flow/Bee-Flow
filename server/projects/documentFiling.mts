/**
 * Filing a person's own document into one of their projects from outside the
 * project page: the chat assistant after a template is filled in
 * (integrations/templateFillTools.mts, document_add_to_project), found by name
 * through boot/featureModules.js.
 *
 * The same move as PUT /api/projects/:id/resources {kind:'document'}
 * (routes/projects/resources.js): editor or owner of the project, a project
 * that holds documents, and the store files only a document the person owns
 * (stores/document/projectDocuments.mts). The move goes through
 * projects/itemFiling.js, so the project's change feed records it.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Role = 'owner' | 'editor' | 'viewer' | null;
type Project = { id: string, name: string, kind?: string | null, permission?: string };
type Entry = { setProject: (...args: unknown[]) => Promise<boolean> };
export type FilingTarget = { id: string, name: string };
export type FileResult = { ok: true, project: FilingTarget } | { ok: false, error: string };

export interface FilingDeps {
    listProjects: (userId: string) => Promise<Project[]>,
    getProject: (projectId: string) => Promise<Project | null>,
    getProjectRole: (userId: string, projectId: string) => Promise<Role>,
    isAllowedIn: (kind: string, projectKind: string | null) => boolean,
    documentEntry: () => Entry,
    fileItem: (move: { entry: Entry, kind: string, id: string, userId: string, projectId: string, attach: boolean }) => Promise<boolean>,
}

const MAX_TARGETS = 50;
const canAdd = (role: unknown): boolean => role === 'owner' || role === 'editor';

export function makeDocumentFiling(deps: FilingDeps) {
    /** The projects this person may add a document to, most recently changed first. */
    async function targets(userId: string): Promise<FilingTarget[]> {
        const projects = await deps.listProjects(userId);
        return projects
            .filter((p) => canAdd(p.permission) && deps.isAllowedIn('document', p.kind ?? null))
            .slice(0, MAX_TARGETS)
            .map((p) => ({ id: p.id, name: p.name }));
    }

    /** File the person's own document into the project; the reason in words when it cannot be. */
    async function fileDocument(userId: string, documentId: string, projectId: string): Promise<FileResult> {
        const project = await deps.getProject(projectId);
        const role = project ? await deps.getProjectRole(userId, projectId) : null;
        if (!project || !role) return { ok: false, error: 'Project not found. Call document_add_to_project without projectId to see the projects this user can add to.' };
        if (!canAdd(role)) return { ok: false, error: `The user can only view "${project.name}", not add documents to it.` };
        if (!deps.isAllowedIn('document', project.kind ?? null)) return { ok: false, error: `"${project.name}" is a Studio Solution, which holds no documents.` };
        const ok = await deps.fileItem({ entry: deps.documentEntry(), kind: 'document', id: documentId, userId, projectId, attach: true });
        return ok ? { ok: true, project: { id: project.id, name: project.name } } : { ok: false, error: 'Only the owner of a document can add it to a project.' };
    }

    return { targets, fileDocument };
}

/** On the real stores, loaded at the first call. */
function realDeps(): FilingDeps {
    const projectStore = () => nodeRequire('../stores/projectStore');
    const membership = () => nodeRequire('./membership');
    const audience = () => nodeRequire('../auth/audience');
    let filing: { fileItem: FilingDeps['fileItem'] } | null = null;
    return {
        listProjects: async (userId) => projectStore().listUserProjects(userId, await audience().resolveUserGroups(userId), { kind: 'workspace' }),
        getProject: (projectId) => projectStore().getProject(projectId),
        getProjectRole: (userId, projectId) => nodeRequire('../auth/projectAccess').getProjectRole(userId, projectId),
        isAllowedIn: (kind, projectKind) => membership().isAllowedIn(kind, projectKind),
        documentEntry: () => membership().getKind('document'),
        fileItem: (move) => {
            if (!filing) {
                const feed = nodeRequire('../core/projectContent/changeFeed').makeChangeFeed({ store: projectStore() });
                filing = nodeRequire('./itemFiling').makeItemFiling({
                    feed: { recordProjectChange: feed.recordProjectChange, recordItemMoved: feed.recordItemMoved },
                    lifecycle: nodeRequire('../core/projectContent/itemLifecycle'),
                }) as { fileItem: FilingDeps['fileItem'] };
            }
            return filing.fileItem(move);
        },
    };
}

export const documentFiling = makeDocumentFiling(realDeps());
