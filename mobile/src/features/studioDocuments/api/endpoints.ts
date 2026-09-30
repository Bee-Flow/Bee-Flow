/**
 * Studio Documents endpoints, under /api/studio-documents
 * (server/routes/studioDocuments.js). Not /api/documents: that prefix is the
 * legacy renderer's list of generated PDFs (features/documents).
 *
 * Every write that changes a document names the revision it was based on
 * (`expectedVersionId`): the server answers 428 without one and 409
 * `document_conflict` when the document moved on in the meantime.
 */

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';

import { readDocument, readDocumentList, readStarters, readValidation, readVersions } from './readers';
import type { CreateRequest } from '../model/create';
import { fileNameFor } from '../model/format';
import type {
    DocKind,
    DocumentFilters,
    DocumentPatch,
    DocumentStarter,
    DocumentVersion,
    StudioDocument,
    StudioDocumentRow,
    ValidationResult,
} from '../model/types';

const BASE = '/api/studio-documents';
const docPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export const DOCUMENT_PAGE_SIZE = 30;

export async function listStudioDocuments(
    filters: DocumentFilters,
    offset: number,
    signal?: AbortSignal,
): Promise<StudioDocumentRow[]> {
    const query = {
        kind: filters.kind,
        query: filters.query.trim() || undefined,
        docType: filters.format || undefined,
        sort: 'updated',
        limit: DOCUMENT_PAGE_SIZE,
        offset,
    };
    return readDocumentList(await api.get<unknown>(BASE, { query, signal }));
}

export async function getStudioDocument(id: string, signal?: AbortSignal): Promise<StudioDocument | null> {
    return readDocument(await api.get<unknown>(docPath(id), { signal }));
}

export async function listStarters(locale: string, signal?: AbortSignal): Promise<DocumentStarter[]> {
    return readStarters(await api.get<unknown>(`${BASE}/starters`, { query: { locale }, signal }));
}

export async function createStudioDocument(input: CreateRequest): Promise<StudioDocument | null> {
    const body = {
        name: input.name,
        locale: input.locale,
        kind: input.kind,
        ...(input.blankDeck ? { docType: 'presentation', bodyHtml: '', css: '' } : { starterId: input.starterId }),
    };
    return readDocument(await api.post<unknown>(BASE, body));
}

export async function updateStudioDocument(
    id: string,
    patch: DocumentPatch,
    expectedVersionId: string | null,
    previous?: Pick<StudioDocument, 'editable'>,
): Promise<StudioDocument | null> {
    const body = { ...patch, expectedVersionId: expectedVersionId ?? undefined };
    return readDocument(await api.patch<unknown>(docPath(id), body), previous);
}

/** Archive. Versions a routine or an app still references stay available. */
export async function deleteStudioDocument(id: string): Promise<void> {
    await api.delete(docPath(id));
}

/** A private copy; `kind: 'template'` is the web's "Save a copy as template". */
export async function duplicateStudioDocument(id: string, kind: DocKind = 'document'): Promise<StudioDocument | null> {
    return readDocument(await api.post<unknown>(`${docPath(id)}/duplicate`, { kind }));
}

export async function listVersions(id: string, signal?: AbortSignal): Promise<DocumentVersion[]> {
    return readVersions(await api.get<unknown>(`${docPath(id)}/versions`, { signal }));
}

export async function restoreVersion(id: string, versionId: string, expectedVersionId: string | null): Promise<void> {
    await api.post(`${docPath(id)}/versions/${encodeURIComponent(versionId)}/restore`, {
        expectedVersionId: expectedVersionId ?? undefined,
    });
}

/** prepareDocument over the given customer values and section choices. */
export async function validateStudioDocument(
    id: string,
    values: Record<string, unknown>,
    sectionOverrides: Record<string, unknown>,
): Promise<ValidationResult> {
    return readValidation(await api.post<unknown>(`${docPath(id)}/validate`, { values, sectionOverrides }));
}

export type ExportFormat = 'pdf' | 'pptx' | 'preview';

const EXPORTS: Record<ExportFormat, { segment: string; ext: 'pdf' | 'pptx' | 'html'; mime: string }> = {
    pdf: { segment: 'pdf', ext: 'pdf', mime: 'application/pdf' },
    pptx: { segment: 'pptx', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    preview: { segment: 'preview', ext: 'html', mime: 'text/html' },
};

/**
 * Fetch a rendering through the session (the routes are behind it, so a bare
 * link would land on the login page), write it to the cache and open the
 * share sheet — where "open with", "save" and "send" live.
 */
export async function shareStudioDocument(id: string, name: string, format: ExportFormat): Promise<string> {
    const spec = EXPORTS[format];
    return shareServerFile(`${docPath(id)}/${spec.segment}`, fileNameFor(name, spec.ext), spec.mime);
}
