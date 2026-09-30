/**
 * The documents a "Fill in a document" step picks from — the web's
 * documentsApi.listTemplates and documentRequest('/<id>/contract')
 * (agent-hub pages/documents/documentsApi.js), under /api/studio-documents
 * (server/routes/studioDocuments.js; NOT /api/documents, which is the legacy
 * PDF lister):
 *
 *   - GET /templates?query=&limit=200 — the caller's fillable documents, each
 *     with its contract and the placeholders its body carries
 *     (documentStore.listTemplates: the list row spread with getContract);
 *   - GET /:id/contract?versionId= — one document's contract at the revision
 *     the step pins (`baseline` when it pins none) or, with no versionId, as
 *     the document is now: what "Review available update" compares against.
 */

import { api } from '@/core/api/client';
import { field, pick, shapeOf } from '@/core/api/contract';

/**
 * One value a document asks for: a contract parameter
 * (core/documents/documentContract.js normalizeContract) or a bare
 * placeholder read off the body (documentTemplate.listPlaceholders), which
 * has a `kind` where a parameter has a `type`.
 */
export interface DocumentParameter {
    key: string;
    label: string;
    /** text | number | boolean | date | choice | list — '' for a bare placeholder. */
    type: string;
    /** A bare placeholder's kind: value | list | condition. */
    kind: string;
    required: boolean;
    summary: string;
    instructions: string;
    /** Absent when the contract gives none; any JSON value otherwise. */
    example?: unknown;
    /** A list's per-item field names. */
    fields: string[];
}

export interface DocumentSection {
    id: string;
    title: string;
    summary: string;
}

export interface DocumentContract {
    documentId: string;
    versionId: string;
    name: string;
    docType: string;
    instructions: string;
    parameters: DocumentParameter[];
    sections: DocumentSection[];
}

export interface DocumentTemplate {
    id: string;
    name: string;
    docType: string;
    versionId: string;
    /** The contract's parameters; absent from a server that sends placeholders only. */
    parameters?: DocumentParameter[];
    placeholders?: DocumentParameter[];
}

/** A list field is `{ key, … }` in a contract and a bare name on a placeholder. */
function fieldNames(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((f) => (typeof f === 'string' ? f : field.str('')(pick(f, 'key')))).filter((k) => k !== '');
}

const readParameterShape = shapeOf({
    key: field.str(''),
    label: field.str(''),
    type: field.str(''),
    kind: field.str(''),
    required: field.bool(false),
    summary: field.str(''),
    instructions: field.str(''),
});

export function readDocumentParameter(raw: unknown): DocumentParameter {
    const p: DocumentParameter = { ...readParameterShape(raw), fields: fieldNames(pick(raw, 'fields')) };
    const example = pick(raw, 'example');
    if (example !== undefined) p.example = example;
    return p;
}

const readParameters = (raw: unknown): DocumentParameter[] | undefined =>
    field.optList(readDocumentParameter)(raw)?.filter((p) => p.key !== '');

const readSection = shapeOf({ id: field.str(''), title: field.str(''), summary: field.str('') });

const readContractShape = shapeOf({
    documentId: field.str(''),
    versionId: field.str(''),
    name: field.str(''),
    docType: field.str(''),
    instructions: field.str(''),
});

export function readDocumentContract(raw: unknown): DocumentContract {
    const contract = pick(raw, 'contract');
    return {
        ...readContractShape(contract),
        parameters: readParameters(pick(contract, 'parameters')) ?? [],
        sections: field.list(readSection)(pick(contract, 'sections')).filter((s) => s.id !== ''),
    };
}

const readTemplateShape = shapeOf({ id: field.str(''), name: field.str(''), docType: field.str(''), versionId: field.str('') });

export function readDocumentTemplates(raw: unknown): DocumentTemplate[] {
    const rows = pick(raw, 'templates');
    if (!Array.isArray(rows)) return [];
    return rows
        .map((row): DocumentTemplate => {
            const out: DocumentTemplate = readTemplateShape(row);
            const parameters = readParameters(pick(row, 'parameters'));
            const placeholders = readParameters(pick(row, 'placeholders'));
            if (parameters) out.parameters = parameters;
            if (placeholders) out.placeholders = placeholders;
            return out;
        })
        .filter((d) => d.id !== '');
}

const BASE = '/api/studio-documents';

/** The web asks for up to 200, the server's cap. */
export const DOCUMENT_TEMPLATE_LIMIT = 200;

export async function listDocumentTemplates(query: string, signal?: AbortSignal): Promise<DocumentTemplate[]> {
    const q: Record<string, string> = { limit: String(DOCUMENT_TEMPLATE_LIMIT) };
    if (query) q.query = query;
    return readDocumentTemplates(await api.get<unknown>(`${BASE}/templates`, { signal, query: q }));
}

/** `versionId` null: the document as it is now. */
export async function getDocumentContract(documentId: string, versionId: string | null, signal?: AbortSignal): Promise<DocumentContract> {
    const path = `${BASE}/${encodeURIComponent(documentId)}/contract`;
    const raw = await api.get<unknown>(path, versionId === null ? { signal } : { signal, query: { versionId } });
    return readDocumentContract(raw);
}

/** Their React Query keys: the caller's documents, under the 'automate' prefix the lookups share. */
export const documentKeys = {
    templates: (query: string) => ['automate', 'flow-lookups', 'document-templates', query] as const,
    contract: (documentId: string, versionId: string | null) =>
        ['automate', 'flow-lookups', 'document-contract', documentId, versionId ?? 'current'] as const,
};
