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
 * settings.sampleValues, which the PDF and PowerPoint routes render.
 *
 * ACCESS. A template is read through the store, which answers only the
 * caller's own templates and those shared with them inside their organisation;
 * anything else, and anything that is not a template, gets one answer that
 * does not say whether the id exists. Writing goes only to a document in this
 * chat's scope (core/documents/aiDocumentScope.js: made by template_fill_start
 * in this conversation, opened beside the chat, or pasted by the user), and
 * only to one that is a plain document, never to the template itself.
 *
 * Definitions: templateFillToolDefs.mts. Dispatched by documentBuilderTools.js.
 */

import { createRequire } from 'node:module';
import { documentUrl } from './documentBuilderLive.mts';
import { copySettings } from '../core/documents/documentCopy.mts';

const nodeRequire = createRequire(import.meta.url);

type Settings = Record<string, unknown>;
type Doc = {
    id: string, name: string, kind?: string, docType?: string, description?: string | null,
    bodyHtml?: string, css?: string, settings?: Settings | null, categories?: unknown,
    projectRole?: string | null, versionId?: string | null,
};
type Field = {
    key: string, type: string, label: string, required: boolean, summary?: string, instructions?: string,
    example?: unknown, default?: unknown, options?: string[], fields?: Field[],
};
type Contract = { parameters: Field[], instructions?: string };
type Issue = { code: string, key?: string, message: string };
type ContractModule = {
    getContract: (doc: Doc) => Contract,
    prepareDocument: (doc: Doc, values: Settings, overrides: Settings) => { valid: boolean, issues: Issue[] },
    coerceNumber: (value: unknown) => unknown,
    coerceNumberParams: (params: Field[] | undefined, scope: Settings) => void,
    typeValid: (p: Field, value: unknown) => boolean,
    hasThousandsSeparator: (text: string) => boolean,
};
export type TemplateFillStore = {
    getDocument: (id: string, userId: string) => Promise<Doc | null>,
    listDocuments: (userId: string, options: { kind: string, query?: string, limit: number, sort?: string }) => Promise<Doc[]>,
    createDocument: (input: Record<string, unknown>) => Promise<Doc>,
    updateDocument: (id: string, userId: string, updates: Record<string, unknown>) => Promise<Doc | null>,
};
type Scope = { has: (id: string) => boolean, add?: (id: string) => void, markCreated?: (id: string) => void };
type Ctx = { documentScope?: Scope | null };
type Args = { query?: unknown, templateId?: unknown, name?: unknown, documentId?: unknown, values?: unknown };
type Handler = (args: Args, ctx: Ctx, userId: string) => Promise<Record<string, unknown>>;

const MAX_LISTED = 25;
const MAX_VALUES = 200;
const MAX_TEXT = 20000;
const API_BASE = '/api/studio-documents';
const NOT_FOUND = 'Template not found. Call document_templates_list to see the templates this user can fill in.';
const contractModule = (): ContractModule => nodeRequire('../core/documents/documentContract');
const notShared = (): string => nodeRequire('../core/documents/aiDocumentScope').NOT_SHARED;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isObject = (v: unknown): v is Settings => !!v && typeof v === 'object' && !Array.isArray(v);
const formatOf = (doc: Doc): 'pdf' | 'pptx' => (doc.docType === 'presentation' ? 'pptx' : 'pdf');
const valuesOf = (doc: Doc): Settings => (isObject(doc.settings?.sampleValues) ? { ...doc.settings.sampleValues } : {});
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '';

/** A field as the model is told about it: label and help, never more than it needs. */
function describeField(p: Field): Record<string, unknown> {
    return {
        key: p.key, label: p.label || p.key, type: p.type, required: p.required === true,
        ...(p.options ? { options: p.options } : {}),
        ...(p.instructions || p.summary ? { help: p.instructions || p.summary } : {}),
        ...(p.example !== undefined ? { example: p.example } : {}),
        ...(p.fields ? { fields: p.fields.map((f) => ({ key: f.key, label: f.label || f.key, type: f.type, required: f.required === true })) } : {}),
    };
}

/** Why a value does not fit its field, in words the model can repeat to the user. */
function typeHint(p: Field, value: unknown, c: ContractModule): string {
    const label = p.label || p.key;
    switch (p.type) {
        case 'number': return `${label} must be a number${typeof value === 'string' && c.hasThousandsSeparator(value.trim()) ? ' without a thousands separator' : ''}.`;
        case 'date': return `${label} must be a date written as YYYY-MM-DD.`;
        case 'boolean': return `${label} must be true or false.`;
        case 'choice': return `${label} must be exactly one of: ${(p.options || []).join(', ')}.`;
        case 'list': return `${label} must be a list of items with: ${(p.fields || []).map((f) => f.key).join(', ')}.`;
        default: return `${label} must be text.`;
    }
}

/** The value as the field stores it (numbers coerced as the contract does), or a reason it cannot be. */
function fitValue(p: Field, raw: unknown, c: ContractModule): { value: unknown } | { reason: string } {
    let value = raw;
    if (p.type === 'text' && (typeof raw === 'number' || typeof raw === 'boolean')) value = String(raw);
    if (p.type === 'number') value = c.coerceNumber(raw);
    if (p.type === 'list' && Array.isArray(raw)) {
        const scope: Settings = { [p.key]: raw };
        c.coerceNumberParams([p], scope);
        value = scope[p.key];
    }
    if (typeof value === 'string' && value.length > MAX_TEXT) return { reason: `${p.label || p.key} is too long (at most ${MAX_TEXT} characters).` };
    return c.typeValid(p, value) ? { value } : { reason: typeHint(p, raw, c) };
}

/** Where the filling stands: what is filled, what is still required, and anything else in the way. */
function progress(doc: Doc, contract: Contract, values: Settings, c: ContractModule) {
    const fill = c.prepareDocument(doc, values, isObject(doc.settings?.sectionOverrides) ? doc.settings.sectionOverrides : {});
    const labels = new Map(contract.parameters.map((p) => [p.key, p.label || p.key]));
    const missingRequired = fill.issues.filter((i) => i.code === 'required' && i.key)
        .map((i) => ({ key: String(i.key), label: labels.get(String(i.key)) || String(i.key) }));
    const issues = fill.issues.filter((i) => i.code !== 'required').map((i) => i.message);
    const filled = contract.parameters.filter((p) => !isEmpty(values[p.key])).length;
    return { missingRequired, issues, complete: fill.valid, filled, total: contract.parameters.length };
}

/** The document a fill tool may write to, or the tool's error. */
async function fillableDocument(store: TemplateFillStore, args: Args, ctx: Ctx, userId: string): Promise<Doc | { error: string }> {
    const documentId = str(args.documentId);
    const scope = ctx.documentScope;
    if (!documentId || !scope || typeof scope.has !== 'function' || !scope.has(documentId)) return { error: notShared() };
    const doc = await store.getDocument(documentId, userId);
    if (!doc) return { error: 'Document not found.' };
    if (doc.kind && doc.kind !== 'document') return { error: 'This is a template itself, not a document made from one. Call template_fill_start with its id to make a document to fill in.' };
    return doc;
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
            let parameters: Field[];
            try { parameters = c.getContract(doc).parameters; } catch { continue; }
            templates.push({
                templateId: doc.id, name: doc.name, docType: doc.docType, fieldCount: parameters.length,
                requiredCount: parameters.filter((p) => p.required).length, description: String(doc.description || '').slice(0, 300),
            });
        }
        return { templates, message: templates.length ? `${templates.length} template(s) found.` : 'No templates found. The user can make one in Studio → Documents.' };
    };
}

/** template_fill_start: the user's own copy of the template, as the duplicate route makes it. */
function startFill({ db, contract }: Deps): Handler {
    return async (args, ctx, userId) => {
        const c = contract();
        const template = await db().getDocument(str(args.templateId), userId);
        if (!template || template.kind !== 'template' || template.docType === 'spreadsheet') return { error: NOT_FOUND };
        let fields: Contract;
        try { fields = c.getContract(template); } catch (e) { return { error: `This template cannot be filled in: ${(e as Error).message}` }; }
        // As the duplicate route copies it: an allow-list, the caller's own private document, filed nowhere.
        const doc = await db().createDocument({
            userId, name: str(args.name).slice(0, 200) || template.name, kind: 'document', visibility: 'private', folderId: null,
            docType: template.docType, description: template.description, bodyHtml: template.bodyHtml, css: template.css,
            settings: copySettings(template, 'document'), categories: template.projectRole ? [] : template.categories,
        });
        if (ctx.documentScope?.markCreated) ctx.documentScope.markCreated(doc.id);
        else ctx.documentScope?.add?.(doc.id);
        const state = progress(doc, fields, {}, c);
        return {
            documentId: doc.id, name: doc.name, url: documentUrl(doc.id), docType: doc.docType,
            ...(fields.instructions ? { instructions: fields.instructions } : {}),
            fields: fields.parameters.map(describeField), values: {}, ...state,
            message: `Made "${doc.name}" from the template. Now ask the user for the fields, a few at a time, by their labels; store answers with template_fill_set_values({ documentId: "${doc.id}", values }).`,
        };
    };
}

/** The given values merged into the stored ones: what fits is taken, what does not comes back with a reason. */
function mergeValues(fields: Contract, stored: Settings, given: Settings, c: ContractModule) {
    const byKey = new Map(fields.parameters.map((p) => [p.key, p]));
    const values = { ...stored };
    const rejected: Array<{ key: string, message: string }> = [];
    let changed = false;
    for (const [key, raw] of Object.entries(given)) {
        const p = byKey.get(key);
        if (!p) { rejected.push({ key, message: `Unknown field "${key}". Use the keys from template_fill_start's fields.` }); continue; }
        if (isEmpty(raw)) { if (key in values) { delete values[key]; changed = true; } continue; }
        const fit = fitValue(p, raw, c);
        if ('reason' in fit) { rejected.push({ key, message: fit.reason }); continue; }
        values[key] = fit.value;
        changed = true;
    }
    return { values, rejected, changed };
}

/** Save the values as an AI edit of the document (a revision of its own); a caller's mistake is the tool's error. */
async function saveValues(store: TemplateFillStore, doc: Doc, values: Settings, userId: string): Promise<Doc | { error: string }> {
    try {
        const updated = await store.updateDocument(doc.id, userId, {
            settings: { ...(doc.settings || {}), sampleValues: values }, expectedVersionId: doc.versionId,
            source: 'ai', summary: 'Filled in template fields', contributors: [{ userId, kind: 'ai' }],
        });
        return updated || { error: 'Document is read-only.' };
    } catch (e) {
        const status = (e as { status?: number }).status;
        if (status && status < 500) return { error: (e as Error).message };
        throw e;
    }
}

/** template_fill_set_values: merge, check and save field values. */
function setValues({ db, contract }: Deps): Handler {
    return async (args, ctx, userId) => {
        const c = contract();
        const doc = await fillableDocument(db(), args, ctx, userId);
        if ('error' in doc) return doc;
        if (!isObject(args.values) || Object.keys(args.values).length > MAX_VALUES) return { error: `Pass values as an object of at most ${MAX_VALUES} fields by key.` };
        const fields = c.getContract(doc);
        const { values, rejected, changed } = mergeValues(fields, valuesOf(doc), args.values, c);
        const saved = changed ? await saveValues(db(), doc, values, userId) : doc;
        if ('error' in saved) return saved;
        const state = progress(saved, fields, values, c);
        return { documentId: doc.id, name: saved.name, url: documentUrl(doc.id), values, rejected, ...state,
            message: state.complete ? 'Every required field is filled in. Sum up the values, let the user confirm, then call template_fill_finish.' : 'Saved. Ask the user for the missing fields.' };
    };
}

/** template_fill_finish: refuse while something required is missing, else hand over the download. */
function finishFill({ db, contract }: Deps): Handler {
    return async (args, ctx, userId) => {
        const c = contract();
        const doc = await fillableDocument(db(), args, ctx, userId);
        if ('error' in doc) return doc;
        const state = progress(doc, c.getContract(doc), valuesOf(doc), c);
        const base = { documentId: doc.id, name: doc.name, url: documentUrl(doc.id), ...state };
        if (!state.complete) {
            return { ...base, message: 'Not finished yet: ask the user for the missing fields (missingRequired) and resolve the issues, then call this again.' };
        }
        const format = formatOf(doc);
        return {
            ...base, finished: true, format, downloadUrl: `${API_BASE}/${encodeURIComponent(doc.id)}/${format}`,
            message: `"${doc.name}" is ready. End your reply with the clickable link "[${doc.name}](${documentUrl(doc.id)})"; the card under your reply downloads it as ${format === 'pptx' ? 'PowerPoint' : 'PDF'}.`,
        };
    };
}

/** The four handlers on a store (and contract code) of the caller's choosing: the seam the tests use. */
export function makeTemplateFillHandlers({ store, contract = contractModule }: { store: TemplateFillStore | (() => TemplateFillStore), contract?: () => ContractModule }): Record<string, Handler> {
    const deps: Deps = { db: () => (typeof store === 'function' ? store() : store), contract };
    return { document_templates_list: listTemplates(deps), template_fill_start: startFill(deps), template_fill_set_values: setValues(deps), template_fill_finish: finishFill(deps) };
}

/** The handlers on the real document store, loaded at the first call. */
export const TEMPLATE_FILL_HANDLERS: Record<string, Handler> = makeTemplateFillHandlers({ store: () => nodeRequire('../stores/documentStore') });
