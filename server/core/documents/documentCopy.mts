/**
 * What a copy of a designed document carries over (POST /api/studio-documents/:id/duplicate,
 * routes/studioDocuments.js): its name when the person gave none, and which of
 * the original's settings it keeps. A spreadsheet is copied by usecases/sheetCopy.js.
 */

import { serverName } from './serverNames.mts';

type CopySource = {
    id: string;
    kind?: string | null;
    versionId?: string | null;
    settings?: Record<string, unknown> | null;
};

/** "Plan — copy", in the copier's own language (core/documents/serverNames.mts). */
export async function copyName(userId: string, name: unknown): Promise<string> {
    return String(await serverName(userId, 'doc_server.copy_name', { name })).slice(0, 200);
}

/**
 * The original's settings for a copy of kind `kind`, without its preview
 * values, section overrides and its link to the chat that filled it in
 * (`templateFill`, integrations/templateFillActive.mts: a copy is no fill).
 *
 * `settings.source` is what "Update available" offers to pull in (GET /:id/updates),
 * replacing the whole body. Only a document made FROM a template or a section
 * (using it) keeps that link; a copy of a document and "Save a copy as template"
 * are copies of their own and get none, not even the original's own link.
 */
export function copySettings(doc: CopySource, kind: string): Record<string, unknown> {
    const { source: _inherited, sampleValues: _values, sectionOverrides: _overrides, templateFill: _fill, ...kept } = doc.settings || {};
    const fromTemplate = kind === 'document' && (doc.kind === 'template' || doc.kind === 'section');
    return { ...kept, ...(fromTemplate ? { source: { documentId: doc.id, versionId: doc.versionId } } : {}) };
}
