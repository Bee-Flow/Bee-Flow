/**
 * Fill in a document template together with the assistant, in the chat.
 *
 * The person picks one of their templates (Studio → Documents, kind
 * 'template': a designed document or a presentation with a contract of typed
 * fields, core/documents/documentContract.js). template_fill_start makes the
 * person's own private copy exactly as "Use template" does (POST
 * /api/studio-documents/:id/duplicate, routes/studioDocuments.js: same copied
 * slots, same settings through documentCopy.copySettings, so "Update available"
 * keeps working), and the values go where the document editor keeps them:
 * settings.sampleValues, which the PDF and PowerPoint routes render. Merging,
 * typing and saving the values is core/documents/templateValues.mts, shared
 * with the form under the chat answer (PUT /api/studio-documents/:id/values).
 *
 * THE FILL KEEPS ITS DOCUMENT. The copy carries a link to this conversation
 * (integrations/templateFillActive.mts). The tools that write or read a fill
 * take `documentId` optionally: without one they use the conversation's active
 * fill, and template_fill_start continues an unfinished fill of the same
 * template instead of making a second copy. Every answer that names a
 * document starts with its `documentId`, so even a cut-off preview keeps it.
 *
 * ACCESS. A template is read through the store, which answers only the
 * caller's own templates and those shared with them inside their organisation;
 * anything else, and anything that is not a template, gets one answer that
 * does not say whether the id exists. Writing goes only to a document in this
 * chat's scope (core/documents/aiDocumentScope.js: made by template_fill_start
 * in this conversation, opened beside the chat, or pasted by the user) or to
 * the caller's own document linked to this conversation, and only to a plain
 * document, never to the template itself.
 *
 * PRIVACY SHIELD. The chat restores this conversation's tokens in the
 * arguments before a tool runs (usecases/ai/directChat/toolExecSteps.js), so
 * real values are stored. A placeholder still there is one this conversation
 * does not know: it is refused, never stored (core/privacy/maskedTokens.mts).
 * What goes back to the model passes the same result filters as every other
 * tool's answer.
 *
 * Definitions: templateFillToolDefs.mts. Dispatched by documentBuilderTools.js.
 */

import { createRequire } from 'node:module';
import { documentUrl } from './documentBuilderLive.mts';
import { copySettings } from '../core/documents/documentCopy.mts';
import {
    applyTemplateValues, contractModule as realContract, describeField, isObject, MAX_VALUES, progress, saveSettings, valuesOf,
    type Contract, type ContractModule, type Settings, type TemplateDoc, type ValueGuard,
} from '../core/documents/templateValues.mts';
import { findMaskedToken } from '../core/privacy/maskedTokens.mts';
import { findActiveFill, fillLinkOf, finishedSettings, isLinkedTo, newFillLink, type FillScope } from './templateFillActive.mts';

const nodeRequire = createRequire(import.meta.url);

export type TemplateFillStore = {
    getDocument: (id: string, userId: string) => Promise<TemplateDoc | null>,
    listDocuments: (userId: string, options: { kind: string, query?: string, limit: number, sort?: string }) => Promise<TemplateDoc[]>,
    createDocument: (input: Record<string, unknown>) => Promise<TemplateDoc>,
    updateDocument: (id: string, userId: string, updates: Record<string, unknown>) => Promise<TemplateDoc | null>,
};
type Scope = FillScope & { createdInChat?: (id: string) => boolean };
/** `project`: a project's team chat, whose fills are documents of that project, shared by its members. */
type Ctx = { documentScope?: Scope | null, conversationId?: string | null, project?: { id: string } | null };
type Args = { query?: unknown, templateId?: unknown, name?: unknown, documentId?: unknown, values?: unknown, fresh?: unknown, projectId?: unknown };
type Handler = (args: Args, ctx: Ctx, userId: string) => Promise<Record<string, unknown>>;

const MAX_LISTED = 25;
const API_BASE = '/api/studio-documents';
const NOT_FOUND = 'Template not found. Call document_templates_list to see the templates this user can fill in.';
const NO_ACTIVE_FILL = 'No template is being filled in in this conversation. Call template_fill_start with the template\'s id.';
const notShared = (): string => nodeRequire('../core/documents/aiDocumentScope').NOT_SHARED;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const formatOf = (doc: TemplateDoc): 'pdf' | 'pptx' => (doc.docType === 'presentation' ? 'pptx' : 'pdf');

/** Refuses a Privacy Shield placeholder this conversation could not restore. */
const refuseMasked: ValueGuard = (_key, value) => {
    const token = findMaskedToken(value);
    return token
        ? `This value is masked by the Privacy Shield (${token}) and its real value is unknown in this conversation, so it was not stored. Ask the user for it, or let them type it in the form under your reply.`
        : null;
};

/** The start of every answer about a document: its id first, so a cut-off preview keeps it. */
function head(doc: TemplateDoc): Record<string, unknown> {
    return { documentId: doc.id, name: doc.name, url: documentUrl(doc.id), docType: doc.docType };
}

const projectOf = (ctx: Ctx): string | null => ctx.project?.id ?? null;
const inScope = (scope: Scope | null | undefined, id: string): boolean => !!scope && typeof scope.has === 'function' && scope.has(id);

/** The document `documentId` names, as far as this conversation may reach it, or the tool's error. */
async function namedDocument(store: TemplateFillStore, documentId: string, ctx: Ctx, userId: string): Promise<TemplateDoc | { error: string }> {
    const doc = await store.getDocument(documentId, userId);
    if (inScope(ctx.documentScope, documentId)) return doc || { error: 'Document not found.' };
    // Not in scope by the conversation's history: still this conversation's own fill when the document says so.
    if (!doc || !isLinkedTo(doc, ctx.conversationId, userId, projectOf(ctx))) return { error: notShared() };
    ctx.documentScope?.markCreated?.(documentId);
    return doc;
}

/** The document a fill tool works on, or the tool's error. */
async function fillableDocument(store: TemplateFillStore, args: Args, ctx: Ctx, userId: string): Promise<TemplateDoc | { error: string }> {
    const documentId = str(args.documentId);
    const found = documentId
        ? await namedDocument(store, documentId, ctx, userId)
        : (await findActiveFill(store, ctx.documentScope, { conversationId: ctx.conversationId, userId, projectId: projectOf(ctx) })) || { error: NO_ACTIVE_FILL };
    if ('error' in found) return found;
    if (found.kind && found.kind !== 'document') return { error: 'This is a template itself, not a document made from one. Call template_fill_start with its id to make a document to fill in.' };
    return found;
}

type Deps = { db: () => TemplateFillStore, contract: () => ContractModule };

/** document_templates_list: the templates this user may fill in, with how many fields each has. */
function listTemplates({ db, contract }: Deps): Handler {
    return async (args, _ctx, userId) => {
        const c = contract();
        const rows = await db().listDocuments(userId, { kind: 'template', query: str(args.query).slice(0, 200), limit: MAX_LISTED, sort: 'updated' });
        const templates = [];
        for (const row of rows.filter((r) => r.kind === 'template' && r.docType !== 'spreadsheet')) {
            const doc = await db().getDocument(row.id, userId);
            if (!doc) continue;
            let parameters: Contract['parameters'];
            try { parameters = c.getContract(doc).parameters; } catch { continue; }
            templates.push({
                templateId: doc.id, name: doc.name, docType: doc.docType, fieldCount: parameters.length,
                requiredCount: parameters.filter((p) => p.required).length, description: String(doc.description || '').slice(0, 300),
            });
        }
        return { templates, message: templates.length ? `${templates.length} template(s) found.` : 'No templates found. The user can make one in Studio → Documents.' };
    };
}

/** Everything the model needs to go on with a fill: fields, values, what is missing. */
function fillState(doc: TemplateDoc, c: ContractModule, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const fields = c.getContract(doc);
    const values = valuesOf(doc);
    const state = progress(doc, fields, values, c);
    return {
        ...head(doc), ...state, finished: !!fillLinkOf(doc)?.finishedAt,
        ...(fields.instructions ? { instructions: fields.instructions } : {}),
        values, fields: fields.parameters.map(describeField), ...extra,
    };
}

const ASK_MISSING = 'Store the template defaults (fields[].default) and anything the conversation states with template_fill_set_values first. Then reply in one or two sentences: what you stored, and that the rest can be filled in in the form under your reply or told to you. Do NOT list the missing fields: the form shows them.';

/** The fill of this template this conversation already has going, as the answer that continues it; null when none. */
async function resumedFill(store: TemplateFillStore, templateId: string, ctx: Ctx, userId: string, c: ContractModule): Promise<Record<string, unknown> | null> {
    const going = await findActiveFill(store, ctx.documentScope, { conversationId: ctx.conversationId, userId, templateId, projectId: projectOf(ctx) });
    return going ? fillState(going, c, {
        resumed: true,
        message: `This conversation is already filling in "${going.name}" from this template: continuing with it (no new copy). ${ASK_MISSING} Pass fresh: true only when the user asks for a second, separate document.`,
    }) : null;
}

/** The template to copy, or the tool's error. */
async function fillableTemplate(store: TemplateFillStore, templateId: string, userId: string, c: ContractModule): Promise<TemplateDoc | { error: string }> {
    const template = await store.getDocument(templateId, userId);
    if (!template || template.kind !== 'template' || template.docType === 'spreadsheet') return { error: NOT_FOUND };
    try { c.getContract(template); } catch (e) { return { error: `This template cannot be filled in: ${(e as Error).message}` }; }
    return template;
}

/** template_fill_start: the user's own copy of the template, as the duplicate route makes it; or the fill already going. */
function startFill({ db, contract }: Deps): Handler {
    return async (args, ctx, userId) => {
        const c = contract();
        const templateId = str(args.templateId);
        // The fill already going comes first: in a team chat a colleague goes on with it even when the
        // template itself is in someone else's library (the document is the project's, they may read it).
        const resumed = args.fresh !== true && templateId ? await resumedFill(db(), templateId, ctx, userId, c) : null;
        if (resumed) return resumed;
        const template = await fillableTemplate(db(), templateId, userId, c);
        if ('error' in template) return template;
        const conversationId = str(ctx.conversationId);
        // As the duplicate route copies it: an allow-list, the caller's own private document, filed nowhere;
        // in a team chat filed in the project, so every member fills it in (the caller checked the project role).
        const doc = await db().createDocument({
            userId, name: str(args.name).slice(0, 200) || template.name, kind: 'document', visibility: 'private', folderId: null,
            ...(ctx.project ? { projectId: ctx.project.id, projectOrgChecked: true } : {}),
            docType: template.docType, description: template.description, bodyHtml: template.bodyHtml, css: template.css,
            settings: { ...copySettings(template, 'document'), ...(conversationId ? { templateFill: newFillLink(conversationId, template.id) } : {}) },
            categories: template.projectRole ? [] : template.categories,
        });
        if (ctx.documentScope?.markCreated) ctx.documentScope.markCreated(doc.id);
        else ctx.documentScope?.add?.(doc.id);
        return fillState(doc, c, {
            message: `Made "${doc.name}" from the template. ${ASK_MISSING} Store answers with template_fill_set_values.`,
        });
    };
}

/** template_fill_set_values: merge, check and save field values. */
function setValues({ db, contract }: Deps): Handler {
    return async (args, ctx, userId) => {
        const doc = await fillableDocument(db(), args, ctx, userId);
        if ('error' in doc) return doc;
        if (!isObject(args.values) || Object.keys(args.values).length > MAX_VALUES) return { documentId: doc.id, error: `Pass values as an object of at most ${MAX_VALUES} fields by key.` };
        let out;
        try {
            out = await applyTemplateValues({ store: db(), doc, given: args.values, userId, origin: 'ai', guard: refuseMasked, contract });
        } catch (e) {
            const status = (e as { status?: number }).status;
            if (status && status < 500) return { documentId: doc.id, error: (e as Error).message };
            throw e;
        }
        if (!out) return { documentId: doc.id, error: 'Document is read-only.' };
        const { doc: saved, values, rejected, contract: _fields, ...state } = out;
        return {
            ...head(saved), values, rejected, ...state,
            message: state.complete ? 'Every required field is filled in. Sum up the values, let the user confirm, then call template_fill_finish.' : `Saved. ${ASK_MISSING}`,
        };
    };
}

/** template_fill_status: where the fill stands now, edits made in the form included. */
function fillStatus({ db, contract }: Deps): Handler {
    return async (args, ctx, userId) => {
        const doc = await fillableDocument(db(), args, ctx, userId);
        if ('error' in doc) return doc;
        return fillState(doc, contract(), { message: `Current values, including what the user filled in the form. Never ask again for a field that has a value. ${ASK_MISSING}` });
    };
}

/** template_fill_finish: refuse while something required is missing, else mark it finished and hand over the download. */
function finishFill({ db, contract }: Deps): Handler {
    return async (args, ctx, userId) => {
        const c = contract();
        const doc = await fillableDocument(db(), args, ctx, userId);
        if ('error' in doc) return doc;
        const state = progress(doc, c.getContract(doc), valuesOf(doc), c);
        const base = { ...head(doc), ...state };
        if (!state.complete) {
            return { ...base, message: 'Not finished yet: ask the user for the missing fields (missingRequired) and resolve the issues, then call this again.' };
        }
        if (fillLinkOf(doc) && !fillLinkOf(doc)?.finishedAt) await saveSettings(db(), doc, finishedSettings(doc), userId, 'ai');
        const format = formatOf(doc);
        return {
            ...base, finished: true, format, downloadUrl: `${API_BASE}/${encodeURIComponent(doc.id)}/${format}`,
            message: `"${doc.name}" is ready. End your reply with the clickable link "[${doc.name}](${documentUrl(doc.id)})"; the card under your reply downloads it as ${format === 'pptx' ? 'PowerPoint' : 'PDF'}.`,
        };
    };
}

/** Files a person's document into a project (projects/documentFiling.mts). */
export type DocumentFiling = {
    targets: (userId: string) => Promise<Array<{ id: string, name: string }>>,
    fileDocument: (userId: string, documentId: string, projectId: string) => Promise<{ ok: true, project: { id: string, name: string } } | { ok: false, error: string }>,
};

/** document_add_to_project: list the projects the user may add to, or file the document into one. */
function addToProject({ db }: Deps, filing: () => DocumentFiling): Handler {
    return async (args, ctx, userId) => {
        if (ctx.project) return { error: 'In a team chat the document is already the project\'s.' };
        if (!str(args.documentId)) return { error: 'documentId is required: the id from template_fill_start or template_fill_finish.' };
        const doc = await fillableDocument(db(), args, ctx, userId);
        if ('error' in doc) return doc;
        const projectId = str(args.projectId);
        if (!projectId) {
            const projects = await filing().targets(userId);
            return projects.length
                ? { ...head(doc), projects, message: 'Ask the user which project, unless they named one; then call this again with its projectId.' }
                : { ...head(doc), projects, message: 'The user has no project they can add documents to.' };
        }
        const filed = await filing().fileDocument(userId, doc.id, projectId);
        if (!filed.ok) return { ...head(doc), error: filed.error };
        const url = `/app/projects/${encodeURIComponent(filed.project.id)}/documents/${encodeURIComponent(doc.id)}`;
        return {
            ...head(doc), url, project: filed.project, added: true,
            message: `"${doc.name}" is now in the project "${filed.project.name}"; its members can open and edit it there. End your reply with the clickable link "[${doc.name}](${url})".`,
        };
    };
}

const realFiling = (): DocumentFiling => {
    const { featureModule } = nodeRequire('../core/featureModules.js') as { featureModule: (name: string) => unknown };
    return (featureModule('projects/documentFiling') as { documentFiling: DocumentFiling }).documentFiling;
};

/** The handlers on a store (and contract code) of the caller's choosing: the seam the tests use. */
export function makeTemplateFillHandlers({ store, contract = realContract, filing = realFiling }: {
    store: TemplateFillStore | (() => TemplateFillStore), contract?: () => ContractModule, filing?: () => DocumentFiling,
}): Record<string, Handler> {
    const deps: Deps = { db: () => (typeof store === 'function' ? store() : store), contract };
    return {
        document_templates_list: listTemplates(deps), template_fill_start: startFill(deps), template_fill_set_values: setValues(deps),
        template_fill_status: fillStatus(deps), template_fill_finish: finishFill(deps), document_add_to_project: addToProject(deps, filing),
    };
}

/** The handlers on the real document store, loaded at the first call. */
export const TEMPLATE_FILL_HANDLERS: Record<string, Handler> = makeTemplateFillHandlers({ store: () => nodeRequire('../stores/documentStore') });
