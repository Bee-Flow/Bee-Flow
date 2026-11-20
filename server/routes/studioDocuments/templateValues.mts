/**
 * The form under a chat answer that fills in a template: save field values of
 * a document made from a template. Mounted by routes/studioDocuments.js.
 *
 *   PUT /:id/values  { values: { <key>: value | null }, finish?: true }
 *                    → { documentId, values, missingRequired, issues, rejected, complete, filled, total, finished, versionId }
 *
 * The values are merged, coerced and type-checked by the same code the chat's
 * template_fill_set_values uses (core/documents/templateValues.mts), so the
 * form and the assistant cannot disagree about what a field takes. A value
 * that does not fit comes back in `rejected` with the reason, next to its
 * field; the others are saved. `finish: true` does what template_fill_finish
 * does: when every required field is filled in, the fill is marked finished;
 * otherwise nothing is finished and `missingRequired` says what is missing.
 *
 * ACCESS. The store reads only a document the caller may see (owner, shared,
 * project); a stranger, another organisation included, gets the 404. A reader
 * who may only view gets 403, and only a plain document is filled in, never a
 * template itself.
 *
 * A FACTORY: `makeTemplateValuesRouter(deps)`; `templateValuesRouter` is over the
 * real document store.
 */

import { createRequire } from 'node:module';
import type { Request, RequestHandler, Response, Router } from 'express';
import {
    applyTemplateValues, MAX_VALUES, saveSettings, type ContractModule, type TemplateDoc, type ValuesStore,
} from '../../core/documents/templateValues.mts';
import { fillLinkOf, finishedSettings } from '../../integrations/templateFillActive.mts';
import { filledByOf, requestsOf } from '../../core/documents/valueRequests.mts';
import { notifyCompleted, requestAnnotator } from './valueRequests.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { z } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { lazyGate } = nodeRequire('../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { HttpError, notFound, forbidden, badRequest } = nodeRequire('../../core/http/errors.js') as typeof import('../../shared/httpErrors.js');

const VALUES_TEXT = `values is an object of at most ${MAX_VALUES} field values by key.`;
const ValuesBody = bodyOf({
    values: z.record(z.string(), z.unknown(), { error: VALUES_TEXT }).refine((v) => Object.keys(v).length <= MAX_VALUES, VALUES_TEXT),
    finish: z.boolean({ error: 'finish is true or false.' }).optional(),
}, 'Saving template values');

type Body = { values: Record<string, unknown>, finish?: boolean };
type Notify = (n: { userId: string, category: string, title: string, message: string, link: string }) => Promise<unknown>;
type Deps = { store?: () => ValuesStore, requireAuth?: RequestHandler, contract?: () => ContractModule, notify?: Notify };

const isReadOnly = (doc: TemplateDoc): boolean => doc.projectRole === 'viewer' || doc.sharingRole === 'viewer';

/** A refusal of the store (a conflict, a cap) as the client's error; anything else stays a 500. */
function storeRefusal(e: unknown): unknown {
    const err = e as { status?: number, errorClass?: string, message?: string };
    return err.status && err.status < 500 ? new HttpError(err.status, err.errorClass || 'document_values_refused', String(err.message)) : e;
}

export function makeTemplateValuesRouter(deps: Deps = {}): Router {
    const router = express.Router({ mergeParams: true });
    const store = deps.store || ((): ValuesStore => nodeRequire('../../stores/documentStore.js') as ValuesStore);
    // Looked up at the first request, so loading this router does not load the auth and user stores.
    const requireAuth = deps.requireAuth || lazyGate(() => (nodeRequire('../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });

    router.put('/:id/values', requireAuth, validate({ body: ValuesBody }), async (req: Request<{ id: string }>, res: Response) => {
        const userId = String((req.session as unknown as { user: { id: string } }).user.id);
        const { values, finish } = req.body as Body;
        const doc = await store().getDocument(req.params.id, userId);
        if (!doc) throw notFound('document_not_found', 'Document not found');
        if (doc.kind && doc.kind !== 'document') throw badRequest('document_not_fillable', 'Only a document made from a template is filled in, not a template itself.');
        if (isReadOnly(doc)) throw forbidden('document_read_only', 'You can read this document, but only its editors can change it.');
        let out;
        // Who filled in what, and the colleagues' requests this save answers (routes/studioDocuments/valueRequests.mts).
        const requests = requestAnnotator(userId);
        try {
            out = await applyTemplateValues({ store: store(), doc, given: values, userId, origin: 'user', annotate: requests.annotate, ...(deps.contract ? { contract: deps.contract } : {}) });
        } catch (e) { throw storeRefusal(e); }
        if (!out) throw notFound('document_not_found', 'Document not found or read-only');
        if (requests.completed().length) await notifyCompleted(out.doc, requests.completed(), deps.notify ? { notify: deps.notify } : {});
        let saved = out.doc;
        let finished = !!fillLinkOf(saved)?.finishedAt;
        if (finish === true && out.complete && !finished) {
            try { saved = (await saveSettings(store(), saved, finishedSettings(saved), userId, 'user')) || saved; } catch (e) { throw storeRefusal(e); }
            finished = true;
        }
        res.json({
            documentId: saved.id, values: out.values, missingRequired: out.missingRequired, issues: out.issues, rejected: out.rejected,
            complete: out.complete, filled: out.filled, total: out.total, finished, versionId: saved.versionId ?? null,
            requests: requestsOf(saved.settings), filledBy: filledByOf(saved.settings),
        });
    });

    return router;
}

export const templateValuesRouter: Router = makeTemplateValuesRouter();
