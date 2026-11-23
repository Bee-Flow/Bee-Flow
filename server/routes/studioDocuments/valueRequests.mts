/**
 * Asking a colleague in the project for the fields of a filled-in template
 * that only they know (core/documents/valueRequests.mts). Mounted by
 * routes/studioDocuments.js.
 *
 *   POST /:id/value-requests                    { fields: [key], assigneeIds: [userId], message? } → { requests }
 *   POST /:id/value-requests/:requestId/close   → { requests }
 *
 * Each person asked gets a bell notification (in their own language) that
 * opens the document in the project; when the asked fields all have a value
 * (whoever filled them in), the request closes and the one who asked is told
 * (requestAnnotator + notifyCompleted, used by the values route).
 *
 * ACCESS. Only a document filed in a project, read by someone who may edit it
 * (a viewer gets 403, a stranger the 404), and only project members who may
 * edit it can be asked: an owner or editor of the project.
 *
 * A FACTORY: `makeValueRequestsRouter(deps)`; `valueRequestsRouter` is over the
 * real stores.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response, Router } from 'express';
import {
    addRequest, cancelRequest, recordFilled, requestsOf, MAX_MESSAGE, MAX_REQUEST_FIELDS,
    type Settings, type ValueRequest,
} from '../../core/documents/valueRequests.mts';
import { saveSettings, type TemplateDoc, type ValuesStore } from '../../core/documents/templateValues.mts';
import { serverName } from '../../core/documents/serverNames.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { z } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { lazyGate } = nodeRequire('../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { HttpError, notFound, forbidden, badRequest } = nodeRequire('../../core/http/errors.js') as typeof import('../../shared/httpErrors.js');
const log = nodeRequire('../../telemetry/log.js') as { warn: (...a: unknown[]) => void };

const MAX_ASSIGNEES = 10;

const AskBody = bodyOf({
    fields: z.array(z.string().max(200), { error: 'fields is a list of field keys.' }).min(1).max(MAX_REQUEST_FIELDS),
    assigneeIds: z.array(z.string().max(200), { error: 'assigneeIds is a list of user ids.' }).min(1).max(MAX_ASSIGNEES),
    message: z.string({ error: 'message is text.' }).max(MAX_MESSAGE).optional(),
}, 'Asking colleagues for values');
/** Closing takes no fields: the request is in the path. */
const CloseBody = bodyOf({}, 'Closing a request for values');

type Doc = TemplateDoc & { name?: string, projectId?: string | null, kind?: string };
type Notify = (n: { userId: string, category: string, title: string, message: string, link: string }) => Promise<unknown>;
type Deps = {
    store?: () => ValuesStore,
    requireAuth?: RequestHandler,
    projectRole?: (userId: string, projectId: string) => Promise<string | null>,
    notify?: Notify,
    contractKeys?: (doc: Doc) => Array<{ key: string, label: string }>,
    name?: typeof serverName,
};

const sessionUser = (req: Request): { id: string, name: string } => {
    const user = (req.session as unknown as { user: { id: string, name?: string, displayName?: string, username?: string } }).user;
    return { id: String(user.id), name: String(user.displayName || user.name || user.username || '') };
};

const isReadOnly = (doc: Doc): boolean => doc.projectRole === 'viewer' || doc.sharingRole === 'viewer';
const EDITORS = new Set(['owner', 'editor']);

/** Where the bell sends the person: the document, opened inside its project. */
export const documentLink = (doc: Doc): string => `/app/projects/${encodeURIComponent(String(doc.projectId))}/documents/${encodeURIComponent(doc.id)}`;

function defaultContractKeys(doc: Doc): Array<{ key: string, label: string }> {
    const { getContract } = nodeRequire('../../core/documents/documentContract.js') as { getContract: (d: unknown) => { parameters: Array<{ key: string, label?: string }> } };
    return getContract(doc).parameters.map((p) => ({ key: p.key, label: p.label || p.key }));
}

function defaultNotify(): Notify {
    return (n) => (nodeRequire('../../stores/notificationStore.js') as { createNotification: Notify }).createNotification(n);
}

/**
 * For the values route: record who filled in what and close the requests that
 * are now answered, in the same save; `completed()` then lists them.
 */
export function requestAnnotator(userId: string, now: string = new Date().toISOString()) {
    let completed: ValueRequest[] = [];
    return {
        annotate: (settings: Settings, values: Settings, changedKeys: string[]): Settings => {
            const out = recordFilled(settings, values, changedKeys, userId, now);
            completed = out.completed;
            return out.settings;
        },
        completed: () => completed,
    };
}

/** Tell each requester that what they asked for is filled in. Best effort: a failed bell never fails the save. */
export async function notifyCompleted(doc: Doc, completed: ValueRequest[], deps: { notify?: Notify, name?: typeof serverName } = {}): Promise<void> {
    const notify = deps.notify || defaultNotify();
    const name = deps.name || serverName;
    for (const r of completed) {
        try {
            await notify({
                userId: r.requestedBy, category: 'info', link: documentLink(doc),
                title: await name(r.requestedBy, 'doc_value_requests.done_title', { document: doc.name || '' }),
                message: await name(r.requestedBy, 'doc_value_requests.done_message', { count: r.fields.length }),
            });
        } catch (e) { log.warn('[valueRequests] could not tell the requester', { error: (e as Error).message }); }
    }
}

function refusalOf(e: unknown): unknown {
    const err = e as { status?: number, errorClass?: string, message?: string };
    return err.status && err.status < 500 ? new HttpError(err.status, err.errorClass || 'value_request_refused', String(err.message)) : e;
}

/** A document the caller may edit, in a project, that is filled in from a template. */
async function editableProjectDoc(store: ValuesStore, id: string, userId: string): Promise<Doc> {
    const doc = await store.getDocument(id, userId) as Doc | null;
    if (!doc) throw notFound('document_not_found', 'Document not found');
    if (!doc.projectId) throw badRequest('value_request_needs_project', 'Asking colleagues works for a document in a project.');
    if (doc.kind && doc.kind !== 'document') throw badRequest('document_not_fillable', 'Only a document made from a template is filled in, not a template itself.');
    if (isReadOnly(doc)) throw forbidden('document_read_only', 'You can read this document, but only its editors can change it.');
    return doc;
}

export function makeValueRequestsRouter(deps: Deps = {}): Router {
    const router = express.Router({ mergeParams: true });
    const store = deps.store || ((): ValuesStore => nodeRequire('../../stores/documentStore.js') as ValuesStore);
    const projectRole = deps.projectRole || ((u: string, p: string) => (nodeRequire('../../auth/projectAccess.js') as { getProjectRole: (u: string, p: string) => Promise<string | null> }).getProjectRole(u, p));
    const notify = deps.notify || defaultNotify();
    const contractKeys = deps.contractKeys || defaultContractKeys;
    const name = deps.name || serverName;
    const requireAuth = deps.requireAuth || lazyGate(() => (nodeRequire('../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });

    router.post('/:id/value-requests', requireAuth, validate({ body: AskBody }), async (req: Request<{ id: string }>, res: Response) => {
        const me = sessionUser(req);
        const { fields, assigneeIds, message } = req.body as { fields: string[], assigneeIds: string[], message?: string };
        const doc = await editableProjectDoc(store(), req.params.id, me.id);
        const assignees = [...new Set(assigneeIds)].filter((id) => id !== me.id);
        if (!assignees.length) throw badRequest('value_request_no_one', 'Pick a colleague to ask (not yourself).');
        for (const id of assignees) {
            if (!EDITORS.has(String(await projectRole(id, String(doc.projectId))))) {
                throw badRequest('value_request_not_member', 'Only people who may edit this project can be asked.');
            }
        }
        const known = contractKeys(doc);
        const now = new Date().toISOString();
        let settings: Settings = { ...(doc.settings || {}) };
        const made: ValueRequest[] = [];
        try {
            for (const assigneeId of assignees) {
                settings = addRequest(settings, { id: randomUUID(), fields, assigneeId, requestedBy: me.id, message, now, knownKeys: known.map((k) => k.key) });
                made.push(requestsOf(settings).at(-1) as ValueRequest);
            }
        } catch (e) { throw refusalOf(e); }
        let saved: Doc | null;
        try { saved = await saveSettings(store(), doc, settings, me.id, 'user') as Doc | null; } catch (e) { throw refusalOf(e); }
        if (!saved) throw notFound('document_not_found', 'Document not found');
        const labelOf = new Map(known.map((k) => [k.key, k.label]));
        for (const r of made) {
            try {
                await notify({
                    userId: r.assigneeId, category: 'heads_up', link: documentLink(saved),
                    title: await name(r.assigneeId, 'doc_value_requests.ask_title', { document: saved.name || '' }),
                    message: await name(r.assigneeId, 'doc_value_requests.ask_message', {
                        person: me.name, fields: r.fields.map((k) => labelOf.get(k) || k).join(', '), note: r.message ? ` “${r.message}”` : '',
                    }),
                });
            } catch (e) { log.warn('[valueRequests] could not notify the colleague', { error: (e as Error).message }); }
        }
        res.status(201).json({ requests: requestsOf(saved.settings) });
    });

    router.post('/:id/value-requests/:requestId/close', requireAuth, validate({ body: CloseBody }), async (req: Request<{ id: string, requestId: string }>, res: Response) => {
        const me = sessionUser(req);
        const doc = await store().getDocument(req.params.id, me.id) as Doc | null;
        if (!doc) throw notFound('document_not_found', 'Document not found');
        let out;
        try { out = cancelRequest({ ...(doc.settings || {}) }, req.params.requestId, me.id, new Date().toISOString()); } catch (e) { throw refusalOf(e); }
        if (!out.request) throw notFound('value_request_not_found', 'This request does not exist or is already closed.');
        let saved: Doc | null;
        try { saved = await saveSettings(store(), doc, out.settings, me.id, 'user') as Doc | null; } catch (e) { throw refusalOf(e); }
        res.json({ requests: requestsOf((saved || doc).settings) });
    });

    return router;
}

export const valueRequestsRouter: Router = makeValueRequestsRouter();
