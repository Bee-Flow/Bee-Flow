/**
 * The folders of a project's Documents tab, shared by the project's members
 * (stores/projectDocumentFolders.mts).
 *
 *   GET    /:id/document-folders                  viewer  { folders, placements: { documentId: folderId } }
 *   POST   /:id/document-folders                  editor  { name } → { folder }
 *   PATCH  /:id/document-folders/:folderId        editor  { name } → { folder }
 *   DELETE /:id/document-folders/:folderId        editor  its documents go back to the top
 *   PUT    /:id/document-folders/placement        editor  { documentId, folderId | null }
 *
 * Every statement is keyed on the project in the path, so a folder or a
 * document of another project answers 404. A folder only orders the tab: who
 * may open or change a document stays the document's own access.
 */

import { createRequire } from 'node:module';
import type { RequestHandler, Router } from 'express';
import type { ProjectDocumentFolder } from '../../stores/projectDocumentFolders.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { z } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { lazyProjectRoleGate } = nodeRequire('./roleGate.js') as { lazyProjectRoleGate: (minRole: string) => RequestHandler };
const { notFound, HttpError } = nodeRequire('../../core/http/errors.js') as typeof import('../../shared/httpErrors.js');
const { sessionUser } = nodeRequire('../../core/http/sessionUser.js') as { sessionUser: (req: unknown) => { id: string } };

const NAME_MAX = 120;
const NAME_TEXT = `name is the folder's name, 1 to ${NAME_MAX} characters.`;
const name = () => z.string({ error: NAME_TEXT }).trim().min(1, NAME_TEXT).max(NAME_MAX, NAME_TEXT);
const NameBody = bodyOf({ name: name() }, 'Naming a folder');
const PlacementBody = bodyOf({
    documentId: z.string({ error: 'documentId is the id of a document in this project.' }).min(1).max(200),
    folderId: z.string({ error: 'folderId is the id of one of this project\'s folders, or null for none.' }).min(1).max(200).nullable(),
}, 'Moving a document into a folder');

type Store = {
    listFolders: (projectId: string) => Promise<ProjectDocumentFolder[]>,
    placements: (projectId: string) => Promise<Record<string, string>>,
    createFolder: (projectId: string, name: string, userId: string) => Promise<ProjectDocumentFolder | null>,
    renameFolder: (projectId: string, folderId: string, name: string) => Promise<ProjectDocumentFolder | null>,
    deleteFolder: (projectId: string, folderId: string) => Promise<boolean>,
    placeDocument: (projectId: string, documentId: string, folderId: string | null) => Promise<boolean>,
};
type Deps = { store?: () => Store, requireProjectRole?: (minRole: string) => RequestHandler };
type Params = { id: string, folderId?: string };

const FOLDER_NOT_FOUND = (): Error => notFound('folder_not_found', 'That folder is not in this project.');

export function makeDocumentFoldersRouter(deps: Deps = {}): Router {
    const router = express.Router({ mergeParams: true });
    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const store = deps.store || (() => (nodeRequire('../../stores/projectDocumentFolders.mts') as { projectDocumentFolders: Store }).projectDocumentFolders);

    router.get('/:id/document-folders', requireRole('viewer'), async (req, res) => {
        const { id } = req.params as Params;
        const [folders, placements] = await Promise.all([store().listFolders(id), store().placements(id)]);
        res.json({ folders, placements });
    });

    router.post('/:id/document-folders', requireRole('editor'), validate({ body: NameBody }), async (req, res) => {
        const { id } = req.params as Params;
        const folder = await store().createFolder(id, (req.body as { name: string }).name, sessionUser(req).id);
        if (!folder) throw new HttpError(409, 'folder_limit', 'This project has as many folders as it may have. Delete one first.');
        res.status(201).json({ folder });
    });

    router.put('/:id/document-folders/placement', requireRole('editor'), validate({ body: PlacementBody }), async (req, res) => {
        const { id } = req.params as Params;
        const { documentId, folderId } = req.body as { documentId: string, folderId: string | null };
        if (!await store().placeDocument(id, documentId, folderId)) {
            throw notFound('not_found', 'That document or folder is not in this project.');
        }
        res.json({ documentId, folderId });
    });

    router.patch('/:id/document-folders/:folderId', requireRole('editor'), validate({ body: NameBody }), async (req, res) => {
        const { id, folderId = '' } = req.params as Params;
        const folder = await store().renameFolder(id, folderId, (req.body as { name: string }).name);
        if (!folder) throw FOLDER_NOT_FOUND();
        res.json({ folder });
    });

    router.delete('/:id/document-folders/:folderId', requireRole('editor'), async (req, res) => {
        const { id, folderId = '' } = req.params as Params;
        if (!await store().deleteFolder(id, folderId)) throw FOLDER_NOT_FOUND();
        res.json({ success: true });
    });

    return router;
}

export const documentFoldersRouter = makeDocumentFoldersRouter();
