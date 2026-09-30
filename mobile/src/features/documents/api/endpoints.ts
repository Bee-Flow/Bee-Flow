/**
 * Documents endpoints.
 *
 * Two different things share the word. Indexed documents are rows in
 * `documents`, always owned by a knowledge base and read through one
 * (features/knowledge). /api/documents is the document-renderer: PDFs it
 * produced, which live in the server's temp directory and expire.
 */

import { api } from '@/core/api/client';
import { listKbDocuments, type KnowledgeBase } from '@/features/knowledge';

import { readRenderedDocuments } from './readers';
import type { OwnedDocument, RenderedDocument } from '../model/types';

/**
 * The closest thing this server has to "all my documents".
 *
 * There is no cross-KB document endpoint, so the list is assembled by fanning
 * out, which is why it is bounded: `maxBases` caps the number of requests, and
 * Promise.allSettled means one knowledge base the caller can list but not read
 * does not empty the whole screen.
 */
export async function listDocumentsAcrossBases(
    bases: KnowledgeBase[],
    opts: { maxBases?: number; perBase?: number } = {},
    signal?: AbortSignal,
): Promise<{ documents: OwnedDocument[]; skipped: number }> {
    const { maxBases = 8, perBase = 100 } = opts;
    const chosen = bases.slice(0, maxBases);

    const settled = await Promise.allSettled(
        chosen.map(async (kb) => {
            const page = await listKbDocuments(kb.id, { limit: perBase }, signal);
            return page.documents.map<OwnedDocument>((doc) => ({ ...doc, kbId: kb.id, kbName: kb.name }));
        }),
    );

    const documents: OwnedDocument[] = [];
    for (const result of settled) {
        if (result.status === 'fulfilled') documents.push(...result.value);
    }
    documents.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    return { documents, skipped: Math.max(0, bases.length - chosen.length) };
}

export async function listRenderedDocuments(signal?: AbortSignal): Promise<RenderedDocument[]> {
    return readRenderedDocuments(await api.get<unknown>('/api/documents/list', { signal }));
}
