/**
 * Contract readers for the knowledge-base routes (server/routes/knowledgeBases/*
 * and the rows of server/stores/knowledgeBases.js).
 *
 * The rows arrive raw and snake_case. Each spec is the allow-list of what the
 * screens read; a missing field becomes the stated default instead of an
 * `undefined` that crashes a `.toLowerCase()` three screens away.
 */

import { field, nullable, pick, shapeOf, type FieldReader } from '@/core/api/contract';

import type {
    KbChunk,
    KbChunksResponse,
    KbDocument,
    KbDocumentsResponse,
    KbSearchHit,
    KnowledgeBase,
} from '../model/types';

/** A chunk id is a bigint serial on one backend and a string on the other. */
const chunkId: FieldReader<number | string> = (value) =>
    typeof value === 'number' || typeof value === 'string' ? value : '';

const optChunkId: FieldReader<number | string | undefined> = (value) =>
    typeof value === 'number' || typeof value === 'string' ? value : undefined;

/** A document id as text, so global search can join a hit to its document. */
const optIdText: FieldReader<string | undefined> = (value) =>
    typeof value === 'number' || typeof value === 'string' ? String(value) : undefined;

/**
 * A list of ids that may arrive as JSON text: `shared_groups` is a TEXT
 * column, `usage_contexts` JSONB. Undefined when absent or unreadable — the
 * caller decides what "not said" means.
 */
const optJsonStrList: FieldReader<string[] | undefined> = (value) => {
    let list = value;
    if (typeof value === 'string') {
        try {
            list = JSON.parse(value);
        } catch {
            return undefined;
        }
    }
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : undefined;
};

const DOC_STATUSES = ['processed', 'redacted', 'skipped', 'error', 'duplicate'] as const;

const knowledgeBaseSpec = {
    id: field.str(''),
    tenant_id: field.str(''),
    name: field.str(''),
    description: field.strOrNull,
    organization_id: field.strOrNull,
    category_id: field.strOrNull,
    icon: field.strOrNull,
    is_published: field.bool(false),
    source_kind: field.strOrNull,
    system_slug: field.strOrNull,
    // COUNT() can arrive as a numeric string; the reader makes it a number.
    document_count: field.optNum,
    total_chunks: field.optNum,
    created_at: field.str(''),
    updated_at: field.optStr,
    shared_groups: optJsonStrList,
    usage_contexts: optJsonStrList,
    last_content_at: field.strOrNull,
};

export const readKnowledgeBase: (raw: unknown) => KnowledgeBase = shapeOf(knowledgeBaseSpec);

export const readKnowledgeBases: (raw: unknown) => KnowledgeBase[] = field.list(readKnowledgeBase);

/**
 * `status` stays undefined when the server does not send it — an older server
 * saying nothing is not the same as a server saying "processed".
 */
export const readKbDocument: (raw: unknown) => KbDocument = shapeOf({
    id: field.str(''),
    tenant_id: field.str(''),
    knowledge_base_id: field.str(''),
    title: field.strOrNull,
    source_type: field.strOrNull,
    source_uri: field.strOrNull,
    lang: field.strOrNull,
    content_hash: field.strOrNull,
    chunk_count: field.num(0),
    created_at: field.str(''),
    status: field.optOneOf(DOC_STATUSES),
    source_id: field.strOrNull,
    page_count: field.numOrNull,
    status_reason: field.strOrNull,
    pii_status: field.strOrNull,
});

/** GET /api/kb/:id embeds the unpaged document list next to the base itself. */
export const readKnowledgeBaseDetail: (
    raw: unknown,
) => (KnowledgeBase & { documents: KbDocument[] }) | null = nullable(
    shapeOf({ ...knowledgeBaseSpec, documents: field.list(readKbDocument) }),
);

const readRawDocumentsPage = shapeOf({
    documents: field.list(readKbDocument),
    total: field.optNum,
    limit: field.num(0),
    offset: field.num(0),
});

/** A page with no `total` counts what it holds, as the header always did. */
export function readKbDocumentsPage(raw: unknown): KbDocumentsResponse {
    const page = readRawDocumentsPage(raw);
    return { ...page, total: page.total ?? page.documents.length };
}

const readKbChunk: (raw: unknown) => KbChunk = shapeOf({
    chunk_id: chunkId,
    content: field.str(''),
    chunk_type: field.strOrNull,
    source_uri: field.strOrNull,
    title: field.strOrNull,
    lang: field.strOrNull,
});

/** `remote_only` reads fail-closed to false: an empty list then says "empty". */
export const readKbChunks: (raw: unknown) => KbChunksResponse | null = nullable(
    shapeOf({
        document: shapeOf({
            id: field.str(''),
            title: field.strOrNull,
            source_type: field.strOrNull,
            source_uri: field.strOrNull,
            chunk_count: field.num(0),
        }),
        chunks: field.list(readKbChunk),
        total: field.num(0),
        remote_only: field.bool(false),
    }),
);

const readKbSearchHit: (raw: unknown) => KbSearchHit = shapeOf({
    id: field.str(''),
    content: field.str(''),
    title: field.optStr,
    source_uri: field.optStr,
    score: field.num(0),
    document_id: optIdText,
    chunk_id: optChunkId,
});

/**
 * The same rows arrive under `chunks` (local pgvector) or `results` (the
 * search-service), and the route only normalises one direction. Read both.
 */
export function readKbSearchHits(raw: unknown): KbSearchHit[] {
    const chunks = pick(raw, 'chunks');
    return field.list(readKbSearchHit)(Array.isArray(chunks) ? chunks : pick(raw, 'results'));
}
