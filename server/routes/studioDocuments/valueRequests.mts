/**
 * Asking a colleague in the project for the fields of a filled-in template
 * that only they know (core/documents/valueRequests.mts). Mounted by
 * routes/studioDocuments.js.
 *
 *   POST /:id/value-requests                    { fields: [key], assigneeIds: [userId], message? }
 *   POST /:id/value-requests/:requestId/close
 *
 * Both answer as the form's other routes do (templateValues.mts `fillAnswer`).
 *
 * Each person asked gets a bell notification (in their own language) that
 * opens the document in the project; when the asked fields all have a value
 * (whoever filled them in, the assistant included), the request closes and the
 * one who asked is told (core/documents/fillTogether.mts, shared with the
 * team chat's template_fill_ask_colleague).
 *
 * ACCESS. Only a document filed in a project, read by someone who may edit it
 * (a viewer gets 403, a stranger the 404), and only project members who may
 * edit it can be asked: an owner or editor of the project.
 *
 * A FACTORY: `makeValueRequestsRouter(deps)`; `valueRequestsRouter` is over the
 * real stores.
 */

import { createRequire } from 'node:module';
import type { Request, RequestHandler, Response, Router } from 'express';
import { cancelRequest, MAX_MESSAGE, MAX_REQUEST_FIELDS } from '../../core/documents/valueRequests.mts';
import { askColleagues, type AskDeps, type Doc } from '../../core/documents/fillTogether.mts';
import { saveSettings, type ValuesStore } from '../../core/documents/templateValues.mts';
import { fillAnswer, storeRefusal, writableDocument } from './templateValues.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { z } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { lazyGate } = nodeRequire('../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { notFound, badRequest } = nodeRequire('../../core/http/errors.js') as typeof import('../../shared/httpErrors.js');

const MAX_ASSIGNEES = 10;

const AskBody = bodyOf({
    fields: z.array(z.string().max(200), { error: 'fields is a list of field keys.' }).min(1).max(MAX_REQUEST_FIELDS),
    assigneeIds: z.array(z.string().max(200), { error: 'assigneeIds is a list of user ids.' }).min(1).max(MAX_ASSIGNEES),
    message: z.string({ error: 'message is text.' }).max(MAX_MESSAGE).optional(),
}, 'Asking colleagues for values');
/** Closing takes no fields: the request is in the path. */
const CloseBody = bodyOf({}, 'Closing a request for values');

type Deps = AskDeps & { store?: () => ValuesStore, requireAuth?: RequestHandler };

const sessionPerson = (req: Request): { id: string, name: string } => {
    const user = (req.session as unknown as { user: { id: string, name?: string, displayName?: string, username?: string } }).user;
    return { id: String(user.id), name: String(user.displayName || user.name || user.username || '') };
};

/** A document the caller may edit, in a project, that is filled in from a template. */
async function editableProjectDoc(store: ValuesStore, id: string, userId: string): Promise<Doc> {
    const doc = await writableDocument(store, id, userId) as Doc;
    if (!doc.projectId) throw badRequest('value_request_needs_project', 'Asking colleagues works for a document in a project.');
    return doc;
}

export function makeValueRequestsRouter(deps: Deps = {}): Router {
    const router = express.Router({ mergeParams: true });
    const store = deps.store || ((): ValuesStore => nodeRequire('../../stores/documentStore.js') as ValuesStore);
    const requireAuth = deps.requireAuth || lazyGate(() => (nodeRequire('../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });

    router.post('/:id/value-requests', requireAuth, validate({ body: AskBody }), async (req: Request<{ id: string }>, res: Response) => {
        const me = sessionPerson(req);
        const { fields, assigneeIds, message } = req.body as { fields: string[], assigneeIds: string[], message?: string };
        const doc = await editableProjectDoc(store(), req.params.id, me.id);
        let asked;
        try { asked = await askColleagues({ store: store(), doc, me, fields, assigneeIds, message }, deps); } catch (e) { throw storeRefusal(e); }
        res.status(201).json(fillAnswer(asked.doc));
    });

    router.post('/:id/value-requests/:requestId/close', requireAuth, validate({ body: CloseBody }), async (req: Request<{ id: string, requestId: string }>, res: Response) => {
        const me = sessionPerson(req);
        const doc = await store().getDocument(req.params.id, me.id) as Doc | null;
        if (!doc) throw notFound('document_not_found', 'Document not found');
        let out;
        try { out = cancelRequest({ ...(doc.settings || {}) }, req.params.requestId, me.id, new Date().toISOString()); } catch (e) { throw storeRefusal(e); }
        if (!out.request) throw notFound('value_request_not_found', 'This request does not exist or is already closed.');
        let saved: Doc | null;
        try { saved = await saveSettings(store(), doc, out.settings, me.id, 'user') as Doc | null; } catch (e) { throw storeRefusal(e); }
        if (!saved) throw notFound('document_not_found', 'Document not found or read-only');
        res.json(fillAnswer(saved));
    });

    return router;
}

export const valueRequestsRouter: Router = makeValueRequestsRouter();
