/** Contract readers for the document-renderer's list (server/routes/documents.js, GET /list). */

import { field, pick, shapeListOf } from '@/core/api/contract';

import type { RenderedDocument } from '../model/types';

const readRenderedRows: (raw: unknown) => RenderedDocument[] = shapeListOf({
    id: field.str(''),
    name: field.str(''),
    sizeBytes: field.num(0),
    createdAt: field.str(''),
    downloadUrl: field.str(''),
    viewUrl: field.str(''),
});

export function readRenderedDocuments(raw: unknown): RenderedDocument[] {
    return readRenderedRows(pick(raw, 'documents'));
}
