/**
 * The fill-in form of a document made from a template (in the chat, in a
 * project's team chat and in the document editor): save field values, look at
 * the final check's remarks, and let the assistant do that check. Mounted by
 * routes/studioDocuments.js.
 *
 *   PUT  /:id/values          { values: { <key>: value | null }, finish?: true, dismiss?: [key] }
 *   POST /:id/values/review   the assistant checks what is filled in (core/documents/fillReviewer.mts)
 *   GET  /:id/values/preview  the document with its values filled in, to look at while filling in
 *                             (core/documents/fillPreview.mts) → { html, gaps: [key] }
 *
 * The first two answer the same: where the filling stands and what is shown next to it
 * (`fillAnswer`): { documentId, values, missingRequired, issues, complete,
 * filled, total, finished, versionId, requests, filledBy, notes, review }; the
 * PUT adds `rejected`.
 *
 * The values are merged, coerced and type-checked by the same code the chat's
 * template_fill_set_values uses (core/documents/templateValues.mts), so the
 * form and the assistant cannot disagree about what a field takes. A value
 * that does not fit comes back in `rejected` with the reason, next to its
 * field; the others are saved. `finish: true` does what template_fill_finish
 * does: when every required field is filled in, the fill is marked finished;
 * otherwise nothing is finished and `missingRequired` says what is missing.
 * `dismiss` takes the final check's remark off those fields (the person read
 * it and keeps their value); taking a suggested wording over is a plain save
 * of that value.
 *
 * ACCESS. The store reads only a document the caller may see (owner, shared,
 * project); a stranger, another organisation included, gets the 404. A reader
 * who may only view gets 403 on a write (they do get the preview: it is a
 * read), and only a plain document is filled in, never a template itself.
 *
 * A FACTORY: `makeTemplateValuesRouter(deps)`; `templateValuesRouter` is over the
 * real document store.
 */

import { createRequire } from 'node:module';
import type { Request, RequestHandler, Response, Router } from 'express';
import {
    applyTemplateValues, contractModule, MAX_VALUES, progress, saveSettings, valuesOf,
    type ContractModule, type Rejected, type TemplateDoc, type ValuesStore,
} from '../../core/documents/templateValues.mts';
import { finishedSettings, isFinished } from '../../integrations/templateFillActive.mts';
import { withoutFindings, withReview, type FillReview } from '../../core/documents/fillReview.mts';
import { annotationsOf, fillAnnotator, notifyCompleted, type Notify } from '../../core/documents/fillTogether.mts';
import type { FillPreview } from '../../core/documents/fillPreview.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { z } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts.js') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { lazyGate } = nodeRequire('../../auth/gateMeta.js') as { lazyGate: (load: () => RequestHandler, meta: Record<string, unknown>) => RequestHandler };
const { HttpError, notFound, forbidden, badRequest } = nodeRequire('../../core/http/errors.js') as typeof import('../../shared/httpErrors.js');

const VALUES_TEXT = `values is an object of at most ${MAX_VALUES} field values by key.`;
const DISMISS_TEXT = `dismiss is a list of at most ${MAX_VALUES} field keys.`;
const ValuesBody = bodyOf({
    values: z.record(z.string(), z.unknown(), { error: VALUES_TEXT }).refine((v) => Object.keys(v).length <= MAX_VALUES, VALUES_TEXT),
    finish: z.boolean({ error: 'finish is true or false.' }).optional(),
    dismiss: z.array(z.string().max(200), { error: DISMISS_TEXT }).max(MAX_VALUES, DISMISS_TEXT).optional(),
}, 'Saving template values');
/** The check takes no fields: the document is in the path. */
const ReviewBody = bodyOf({}, 'Checking the filled-in values');

type Body = { values: Record<string, unknown>, finish?: boolean, dismiss?: string[] };
type Who = { userId: string, orgId: string | null };
type Deps = {
    store?: () => ValuesStore, requireAuth?: RequestHandler, contract?: () => ContractModule, notify?: Notify,
    /** The model's check (core/documents/fillReviewer.mts). */
    reviewer?: (doc: TemplateDoc, who: Who) => Promise<FillReview>,
    /** A reason the person may not use the AI now (their plan's limit), or null. */
    limit?: (who: Who) => Promise<string | null>,
    limiter?: RequestHandler,
    /** The picture of the document with its values (core/documents/fillPreview.mts). */
    preview?: (doc: TemplateDoc, orgId: string | null) => Promise<FillPreview>,
};
type Session = { user: { id: string, organizationId?: string | null }, connectorOrgId?: string | null };

export const isReadOnly = (doc: TemplateDoc): boolean => doc.projectRole === 'viewer' || doc.sharingRole === 'viewer';

/** A refusal of the store or of the fill rules (a conflict, a cap) as the client's error; anything else stays a 500. */
export function storeRefusal(e: unknown): unknown {
    if (e instanceof HttpError) return e;
    const err = e as { status?: number, errorClass?: string, message?: string };
    return err.status && err.status < 500 ? new HttpError(err.status, err.errorClass || 'document_values_refused', String(err.message)) : e;
}

/** The document the values go into, or the refusal: missing, a template, or read-only for this person. */
export async function writableDocument(store: ValuesStore, id: string, userId: string): Promise<TemplateDoc> {
    const doc = await store.getDocument(id, userId);
    if (!doc) throw notFound('document_not_found', 'Document not found');
    if (doc.kind && doc.kind !== 'document') throw badRequest('document_not_fillable', 'Only a document made from a template is filled in, not a template itself.');
    if (isReadOnly(doc)) throw forbidden('document_read_only', 'You can read this document, but only its editors can change it.');
    return doc;
}

/** Where the filling stands and what is shown next to it: the answer of every route of the form. */
export function fillAnswer(doc: TemplateDoc, c: ContractModule = contractModule()): Record<string, unknown> {
    const values = valuesOf(doc);
    return {
        documentId: doc.id, values, ...progress(doc, c.getContract(doc), values, c),
        finished: isFinished(doc), versionId: doc.versionId ?? null, ...annotationsOf(doc),
    };
}

/** One more settings write on the saved document, or the document as it is when nothing changes. */
async function resave(store: ValuesStore, doc: TemplateDoc, settings: Record<string, unknown>, userId: string): Promise<TemplateDoc> {
    if (settings === doc.settings) return doc;
    try { return (await saveSettings(store, doc, settings, userId, 'user')) || doc; } catch (e) { throw storeRefusal(e); }
}

/** After the values: the remarks the person dismissed are taken off, and the fill is finished when asked and complete. */
async function afterValues(store: ValuesStore, saved: TemplateDoc, userId: string, body: Body, complete: boolean): Promise<TemplateDoc> {
    const kept = await resave(store, saved, withoutFindings(saved.settings || {}, body.dismiss || []), userId);
    const finish = body.finish === true && complete && !isFinished(kept);
    return finish ? resave(store, kept, finishedSettings(kept), userId) : kept;
}

/** Store the review; when the document moved on meanwhile, on its newest state (a remark on a changed value is dropped on reading). */
async function storeReview(store: ValuesStore, doc: TemplateDoc, review: FillReview, userId: string): Promise<TemplateDoc> {
    let current = doc;
    for (let attempt = 0; ; attempt += 1) {
        try {
            const saved = await saveSettings(store, current, withReview(current.settings || {}, review), userId, 'user');
            if (!saved) throw notFound('document_not_found', 'Document not found or read-only');
            return saved;
        } catch (e) {
            const fresh = attempt === 0 && (e as { status?: number }).status === 409 ? await store.getDocument(current.id, userId) : null;
            if (!fresh) throw storeRefusal(e);
            current = fresh;
        }
    }
}

/** The check's own refusal as it is (no model, the privacy policy); anything the model call threw as one upstream failure. */
function reviewRefusal(e: unknown): Error {
    const err = e as { status?: number, errorClass?: string, message?: string };
    if (err.status && String(err.errorClass || '').startsWith('fill_review_')) return new HttpError(err.status, String(err.errorClass), String(err.message));
    (nodeRequire('../../telemetry/log.js') as { warn: (...a: unknown[]) => void }).warn('[Documents] fill review failed:', err.message);
    return new HttpError(502, 'fill_review_failed', 'The AI check could not run. Please try again.');
}

const realPreview = (doc: TemplateDoc, orgId: string | null): Promise<FillPreview> => (nodeRequire('../../core/documents/fillPreview.mts') as {
    filledPreview: (doc: TemplateDoc, orgId: string | null) => Promise<FillPreview> }).filledPreview(doc, orgId);

/** A refusal with a status (a presentation, the house style not reachable) as the client's error; anything else stays a 500. */
function previewRefusal(e: unknown): unknown {
    const err = e as { status?: number, errorClass?: string, message?: string };
    return err.status ? new HttpError(err.status, err.errorClass || 'fill_preview_failed', String(err.message)) : e;
}

const realLimit = ({ orgId, userId }: Who): Promise<string | null> => (nodeRequire('../../core/entitlements/limits.js') as {
    checkSubscriptionLimits: (orgId: string | null, kind: string, userId: string) => Promise<string | null> }).checkSubscriptionLimits(orgId, 'chat', userId);
const realReviewer = (doc: TemplateDoc, who: Who): Promise<FillReview> => (nodeRequire('../../core/documents/fillReviewer.mts') as {
    reviewFill: (doc: TemplateDoc, who: Who) => Promise<FillReview> }).reviewFill(doc, who);

export function makeTemplateValuesRouter(deps: Deps = {}): Router {
    const router = express.Router({ mergeParams: true });
    const store = deps.store || ((): ValuesStore => nodeRequire('../../stores/documentStore.js') as ValuesStore);
    const contract = deps.contract || contractModule;
    // Looked up at the first request, so loading this router does not load the auth and user stores.
    const requireAuth = deps.requireAuth || lazyGate(() => (nodeRequire('../../auth/permissions.js') as { requireAuth: RequestHandler }).requireAuth, { axis: 'auth' });
    // A check is one model call: a person finishing a document asks for a few, never for a stream of them.
    const limiter = deps.limiter || (nodeRequire('../../utils/perUserRateLimit.js') as {
        perUserRateLimit: (o: { windowMs: number, max: number, name: string }) => RequestHandler }).perUserRateLimit({ windowMs: 60_000, max: 10, name: 'document-fill-review' });
    const who = (req: Request): Who => {
        const session = req.session as unknown as Session;
        return { userId: String(session.user.id), orgId: session.connectorOrgId || session.user.organizationId || null };
    };

    router.put('/:id/values', requireAuth, validate({ body: ValuesBody }), async (req: Request<{ id: string }>, res: Response) => {
        const { userId } = who(req);
        const body = req.body as Body;
        const doc = await writableDocument(store(), req.params.id, userId);
        let out;
        // Who filled in what, the colleagues' requests this save answers, and the remarks it makes moot (core/documents/fillTogether.mts).
        const marks = fillAnnotator(userId);
        try {
            out = await applyTemplateValues({ store: store(), doc, given: body.values, userId, origin: 'user', annotate: marks.annotate, contract });
        } catch (e) { throw storeRefusal(e); }
        if (!out) throw notFound('document_not_found', 'Document not found or read-only');
        if (marks.completed().length) await notifyCompleted(out.doc, marks.completed(), deps.notify ? { notify: deps.notify } : {});
        const saved = await afterValues(store(), out.doc, userId, body, out.complete);
        const rejected: Rejected[] = out.rejected;
        res.json({ ...fillAnswer(saved, contract()), rejected });
    });

    router.post('/:id/values/review', requireAuth, limiter, validate({ body: ReviewBody }), async (req: Request<{ id: string }>, res: Response) => {
        const person = who(req);
        const doc = await writableDocument(store(), req.params.id, person.userId);
        const refused = await (deps.limit || realLimit)(person);
        if (refused) throw new HttpError(402, 'ai_limit_reached', refused);
        let review: FillReview;
        try { review = await (deps.reviewer || realReviewer)(doc, person); } catch (e) { throw reviewRefusal(e); }
        res.json(fillAnswer(await storeReview(store(), doc, review, person.userId), contract()));
    });

    router.get('/:id/values/preview', requireAuth, async (req: Request<{ id: string }>, res: Response) => {
        const person = who(req);
        const doc = await store().getDocument(req.params.id, person.userId);
        if (!doc) throw notFound('document_not_found', 'Document not found');
        if (doc.kind && doc.kind !== 'document') throw badRequest('document_not_fillable', 'Only a document made from a template is filled in, not a template itself.');
        let out: FillPreview;
        try { out = await (deps.preview || realPreview)(doc, person.orgId); } catch (e) { throw previewRefusal(e); }
        // What it shows changes with every value saved: never a stored copy.
        res.set('Cache-Control', 'no-store');
        res.json(out);
    });

    return router;
}

export const templateValuesRouter: Router = makeTemplateValuesRouter();
