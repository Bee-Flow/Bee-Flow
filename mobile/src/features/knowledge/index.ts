/**
 * Knowledge bases, and the ingest toolkit the other Library features share.
 *
 * Ingest lives here because a knowledge base is where uploaded text ends up:
 * the upload queue, the pickers, the scanner, the add-a-source sheet and the
 * text preview are reused by notebooks, documents and templates, which import
 * them from this index. Global search reads the lists and the passage search
 * through it too, and the organisation's admin screen the system knowledge
 * bases. Import from '@/features/knowledge'.
 */

export { KnowledgeBaseScreen } from './screens/KnowledgeBaseScreen';
export { KnowledgeListScreen } from './screens/KnowledgeListScreen';

export { listKbDocuments, listKnowledgeBases, searchKnowledgeBases } from './api/endpoints';
export type { UploadFile, UploadTarget } from './api/upload';
export { useKnowledgeBases } from './hooks/queries';
export { useSystemKnowledgeBases } from './hooks/manage';
export { useDeleteKbDocument, useRefreshKnowledge } from './hooks/mutations';
export { useIngestFlow, useKbIngestFlow, type IngestFlow } from './hooks/useIngestFlow';
export { useUploadQueue } from './hooks/useUploadQueue';
export { countLabel, documentIcon } from './model/format';
export { pickDocuments } from './model/pickers';
export type { KbDocument, KbSearchHit, KnowledgeBase, SystemKb } from './model/types';

export { AddFab } from './components/AddFab';
export { IngestSheets } from './components/IngestSheets';
export { KbChunkPreview } from './components/KbChunkPreview';
export { PreviewSheet } from './components/PreviewSheet';
export { UploadQueue } from './components/UploadQueue';
