/**
 * Contract readers for /api/notebooks (routes/notebooks.js over
 * server/stores/notebookStore.js). Every response the notebook screens read
 * goes through one of these.
 */

import { field, nullable, pick, shapeOf } from '@/core/api/contract';

import type {
    Notebook,
    NotebookCard,
    NotebookConversationResponse,
    NotebookDetailResponse,
    NotebookListResponse,
    NotebookSource,
} from '../model/types';

export const readNotebookCard: (raw: unknown) => NotebookCard = shapeOf({
    id: field.str(''),
    name: field.str(''),
    description: field.str(''),
    type: field.str(''),
    projectId: field.strOrNull,
    organizationId: field.strOrNull,
    version: field.num(0),
    sourceCount: field.num(0),
    processingCount: field.num(0),
    failedCount: field.num(0),
    sourceWordCount: field.num(0),
    docWordCount: field.num(0),
    messageCount: field.num(0),
    preview: field.str(''),
    pinned: field.bool(false),
    pinnedAt: field.strOrNull,
    lastActivityAt: field.strOrNull,
    lastActivityKind: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

export const readNotebookList: (raw: unknown) => NotebookListResponse = shapeOf({
    notebooks: field.list(readNotebookCard),
    limit: field.num(0),
    offset: field.num(0),
    hasMore: field.bool(false),
});

export const readNotebook: (raw: unknown) => Notebook = shapeOf({
    id: field.str(''),
    userId: field.str(''),
    name: field.str(''),
    description: field.str(''),
    instructions: field.str(''),
    knowledgeBaseIds: field.strArray,
    settings: field.record<Record<string, unknown>>({}),
    cryptoContext: field.recordOrNull,
    documentContent: field.str(''),
    documentMd: field.strOrNull,
    documentFormat: field.str(''),
    type: field.str(''),
    projectId: field.strOrNull,
    organizationId: field.strOrNull,
    version: field.num(0),
    sourceCount: field.num(0),
    folderId: field.strOrNull,
    categories: field.strArray,
    lastEditedBy: field.strOrNull,
    lastEditedAt: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

/**
 * A missing `status` reads as '' — neither working nor failed — so a row the
 * server did not describe can never keep the detail screen polling.
 */
export const readNotebookSource: (raw: unknown) => NotebookSource = shapeOf({
    id: field.str(''),
    notebookId: field.str(''),
    type: field.str(''),
    name: field.str(''),
    storageKey: field.strOrNull,
    fileName: field.strOrNull,
    metadata: field.record<NotebookSource['metadata']>({}),
    status: field.str(''),
    stage: field.strOrNull,
    error: field.strOrNull,
    wordCount: field.num(0),
    sortOrder: field.num(0),
    hasContent: field.bool(false),
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

export const readNotebookDetail: (raw: unknown) => NotebookDetailResponse | null = nullable(
    shapeOf({ notebook: readNotebook, sources: field.list(readNotebookSource) }),
);

/**
 * PUT /api/notebooks/:id answers `{ success, version }` — the CAS token the
 * next save sends back as `expectedVersion`. Null when an older server does
 * not say, so the next save simply writes.
 */
export const readUpdateResult: (raw: unknown) => { version: number | null } = shapeOf({ version: field.numOrNull });

/** PATCH …/sources/:sid answers the name as the server cleaned it. */
export const readRenamedSource: (raw: unknown) => { name: string } = shapeOf({ name: field.str('') });

/** The `source` row a POST …/sources/url|text answers with, or null. */
export function readCreatedSource(raw: unknown): NotebookSource | null {
    return nullable(readNotebookSource)(pick(raw, 'source'));
}

/** The `notebook` row POST /api/notebooks answers with, or null. */
export function readCreatedNotebook(raw: unknown): Notebook | null {
    return nullable(readNotebook)(pick(raw, 'notebook'));
}

export const readSourceContent: (raw: unknown) => { content: string; name: string; type: string } = shapeOf({
    content: field.str(''),
    name: field.str(''),
    type: field.str(''),
});

const readTurn = shapeOf({
    role: field.oneOf(['user', 'assistant'] as const, 'assistant'),
    content: field.str(''),
    createdAt: field.optStr,
    modelId: field.optStr,
    modelTier: field.optStr,
    attachments: field.optStrArray,
});

/**
 * `locked` is true only when the server says so: then history exists that
 * this session's key cannot open, which is not the same as none.
 */
export const readNotebookConversation: (raw: unknown) => NotebookConversationResponse = shapeOf({
    messages: field.list(readTurn),
    locked: field.bool(false),
});
