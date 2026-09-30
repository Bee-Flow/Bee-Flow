/** Shapes the Documents screen reads that no other feature owns. */

import type { KbDocument } from '@/features/knowledge';

/**
 * A PDF the document-renderer produced. These live in the server's temp
 * directory and expire — hence "It may have expired" being a real 404 body
 * rather than a bug.
 */
export interface RenderedDocument {
    id: string;
    name: string;
    sizeBytes: number;
    createdAt: string;
    downloadUrl: string;
    viewUrl: string;
}

/** A document plus the knowledge base it came out of, for cross-KB views. */
export interface OwnedDocument extends KbDocument {
    kbId: string;
    kbName: string;
}
