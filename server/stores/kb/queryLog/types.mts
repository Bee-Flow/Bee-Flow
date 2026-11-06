/** Types of the KB query log store (split from index.mts for its file budget). */

import type { Channel, Outcome } from '../../../core/kb/queryLog/vocab.mts';
import type * as realCrypto from '../../../core/kb/queryLog/crypto.mts';

export interface Db { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> }
export interface CryptoApi {
    sealField: typeof realCrypto.sealField;
    openField: typeof realCrypto.openField;
}

export interface LogChunk {
    chunkId?: string | null; documentId?: string | null; documentVersionId?: string | null;
    sourceUri?: string | null; title?: string | null; score?: number | null; page?: number | null; text?: string | null;
}

export interface InsertRow {
    id?: string;
    searchGroupId: string;
    organizationId: string | null;
    kbId: string;
    userId: string | null;
    channel: Channel;
    channelRef?: Record<string, unknown> | null;
    createdAt?: Date | string;
    query: string;
    chunks: LogChunk[];
    retrievalMs?: number | null;
    outcome: Outcome;
    errorCode?: string | null;
    retentionDays: number;
}

export interface FinishPatch {
    answer?: string | null;
    citations?: unknown[] | null;
    model?: string | null;
    answerMs?: number | null;
    outcome: Outcome;
    errorCode?: string | null;
}

export interface ListFilter {
    kbId?: string;
    orgId?: string | null;
    from?: Date | string | null;
    to?: Date | string | null;
    userId?: string | null;
    channel?: string | null;
    outcome?: string | null;
    status?: string | null;
    /** Case-insensitive text filter over query and answer; decrypts in memory, so it needs includeContent. */
    q?: string | null;
    limit?: number;
    offset?: number;
    includeContent?: boolean;
}

export interface EntryRow {
    id: string; searchGroupId: string; kbId: string; organizationId: string | null; userId: string | null; userName?: string | null;
    channel: string; channelRef: Record<string, unknown>; createdAt: string | null;
    query: string | null; chunks: LogChunk[]; chunkCount: number; topScore: number | null; retrievalMs: number | null;
    answer: string | null; citations: unknown[]; model: string | null; answerMs: number | null;
    outcome: string; errorCode: string | null; answeredAt: string | null;
    reviewStatus: string; reviewNote: string | null; reviewedBy: string | null; reviewedAt: string | null; expiresAt: string | null;
    decryptFailed?: boolean;
}
