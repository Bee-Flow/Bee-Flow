/**
 * A document's indexed text, read back from its chunks.
 *
 * Chunks are all the server keeps — the ingest route stores the extracted
 * text split for embedding, not the original bytes. They overlap by design
 * but are stored in order, so joining them reads as the document did. When
 * they live in the remote search-service the route says so (`remote_only`),
 * and the sheet repeats it instead of showing an empty page that looks like
 * data loss.
 */

import React, { useMemo } from 'react';

import { shareText } from '@/core/api/shareFile';

import { PreviewSheet } from './PreviewSheet';
import { useKbChunks } from '../hooks/queries';

export interface ChunkPreviewTarget {
    kbId: string;
    docId: string;
    title: string | null;
}

export function KbChunkPreview({
    doc,
    subtitle,
    onClose,
}: {
    doc: ChunkPreviewTarget | null;
    /** Shown under the title unless the chunks are remote-only. */
    subtitle: string | undefined;
    onClose: () => void;
}) {
    const chunks = useKbChunks(doc ? { kbId: doc.kbId, docId: doc.docId } : null);
    const text = useMemo(
        () => (chunks.data?.chunks ?? []).map((c) => c.content).join('\n\n'),
        [chunks.data],
    );

    return (
        <PreviewSheet
            visible={Boolean(doc)}
            onClose={onClose}
            title={doc?.title || 'Document'}
            subtitle={
                chunks.data?.remote_only
                    ? 'Indexed in the search service — the text is not readable from here'
                    : subtitle
            }
            kind="text"
            content={text}
            loading={chunks.isLoading}
            error={chunks.isError ? chunks.error : undefined}
            onRetry={() => void chunks.refetch()}
            onShare={text ? () => void shareText(text, doc?.title || 'document') : undefined}
        />
    );
}
