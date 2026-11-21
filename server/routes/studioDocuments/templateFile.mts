/**
 * A template as a `.bftemplate` file (core/documents/templateFile.mts).
 * Mounted by routes/studioDocuments.js.
 *
 *   GET  /:id/export   the document as a template file, to download
 *                      (header X-Skipped-Images: how many pictures stayed out)
 *   POST /import       { file: <the parsed file>, folderId? } → { document }
 *                      a new private template of the caller
 *
 * ACCESS. Export reads only a document the caller may see (owner, shared,
 * project): a stranger, another organisation included, gets the 404. Import
 * makes a template owned by the caller, private, in their own organisation.
 *
 * A FACTORY: `makeTemplateFileRouter(deps)`; `templateFileRouter` is over the
 * real document store.
 */

import { createRequire } from 'node:module';
import type { Request, RequestHandler, Response, Router } from 'express';
import {
    canExport, inlineImages, parseTemplateFile, templateFileOf, TEMPLATE_FILE_EXTENSION, TEMPLATE_FILE_MIME,
    type ExportableDoc,
} from '../../core/documents/templateFile.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { z } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { lazyGate } = nodeRequire('../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { HttpError, notFound, badRequest } = nodeRequire('../../core/http/errors.js') as typeof import('../../shared/httpErrors.js');

const ImportBody = bodyOf({
    file: z.record(z.string(), z.unknown(), { error: 'file is the template file, as read from the .bftemplate.' }),
    folderId: z.string({ error: 'folderId is the id of a folder.' }).max(200).optional(),
}, 'Importing a template');

type Doc = ExportableDoc & { id: string, userId?: string, organizationId?: string | null };
type Store = {
    getDocument: (id: string, userId: string) => Promise<Doc | null>,
    createDocument: (input: Record<string, unknown>) => Promise<Doc>,
    firstAuthorOf?: (...args: unknown[]) => Promise<unknown>,
    revisionSeqOf?: (id: string) => Promise<unknown>,
};
type Resolver = (ref: { storageKey: string }) => Promise<string | null>;
type Deps = { store?: () => Store, requireAuth?: RequestHandler, imageResolver?: (readerId: string, doc: Doc) => Resolver };

const userIdOf = (req: Request): string => String((req.session as unknown as { user: { id: string } }).user.id);

/** The pictures a reader may see in this document, as the presentation renderer reads them. */
function defaultImageResolver(store: () => Store) {
    return (readerId: string, doc: Doc): Resolver => {
        const { makeUserImageResolver } = nodeRequire('../../services/presentationRenderer.js') as { makeUserImageResolver: unknown };
        const { makeDocumentImageResolver, sharedAuthorCache } = nodeRequire('../../core/documents/documentImages.js') as {
            makeDocumentImageResolver: (o: Record<string, unknown>) => Resolver, sharedAuthorCache: () => unknown,
        };
        return makeDocumentImageResolver({
            readerId, doc, resolverFor: makeUserImageResolver, cache: sharedAuthorCache(),
            firstAuthorOf: (...args: unknown[]) => store().firstAuthorOf?.(...args),
            revisionSeqOf: (id: string) => store().revisionSeqOf?.(id),
        });
    };
}

/** A file name a browser and every file system take: "<name>.bftemplate". */
function fileNameOf(name: string): string {
    const { documentFileName } = nodeRequire('../../core/documents/renderFilledDocument.js') as {
        documentFileName: (raw: string, fallback?: string, extension?: string) => string,
    };
    return documentFileName(name, 'template', TEMPLATE_FILE_EXTENSION);
}

/** A refusal of the file or the store (a cap, a folder) as the client's error; anything else stays a 500. */
function refusalOf(e: unknown): unknown {
    const err = e as { status?: number, errorClass?: string, message?: string };
    return err.status && err.status < 500 ? new HttpError(err.status, err.errorClass || 'template_import_refused', String(err.message)) : e;
}

export function makeTemplateFileRouter(deps: Deps = {}): Router {
    const router = express.Router({ mergeParams: true });
    const store = deps.store || ((): Store => nodeRequire('../../stores/documentStore.js') as Store);
    const resolverFor = deps.imageResolver || defaultImageResolver(store);
    const requireAuth = deps.requireAuth || lazyGate(() => (nodeRequire('../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });

    router.get('/:id/export', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
        const userId = userIdOf(req);
        const doc = await store().getDocument(req.params.id, userId);
        if (!doc) throw notFound('document_not_found', 'Document not found');
        if (!canExport(doc.docType)) throw badRequest('template_export_unsupported', 'Only a designed document or a presentation can be saved as a template file.');
        const { file, skippedImages } = await inlineImages(templateFileOf(doc), resolverFor(userId, doc));
        res.set('Content-Type', `${TEMPLATE_FILE_MIME}; charset=utf-8`);
        res.set('Content-Disposition', `attachment; filename="${fileNameOf(file.template.name)}"`);
        res.set('X-Skipped-Images', String(skippedImages.length));
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- a JSON file sent as an attachment with its own Content-Type, not HTML built from the request
        res.send(JSON.stringify(file, null, 2));
    });

    router.post('/import', requireAuth, validate({ body: ImportBody }), async (req: Request, res: Response) => {
        const userId = userIdOf(req);
        const { file, folderId } = req.body as { file: Record<string, unknown>, folderId?: string };
        let document;
        try {
            const t = parseTemplateFile(file);
            document = await store().createDocument({
                userId, name: t.name, description: t.description, docType: t.docType, bodyHtml: t.bodyHtml, css: t.css,
                settings: t.settings, categories: t.categories, kind: 'template', visibility: 'private', ...(folderId ? { folderId } : {}),
            });
        } catch (e) { throw refusalOf(e); }
        res.status(201).json({ document });
    });

    return router;
}

export const templateFileRouter: Router = makeTemplateFileRouter();
