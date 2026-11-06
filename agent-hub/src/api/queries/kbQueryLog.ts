// The knowledge-base query log (routes/knowledgeBases/queryLog.js): the
// settings a manager changes, the entries they review, the CSV export, and
// the notice that tells a reader their questions are logged.
//
// authFetch stays behind `request` (the checked variant): a refusal is an
// ApiError carrying the server's text, never an empty "success".

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { API_BASE, request } from '@/api/mutate';

export const QUERY_LOG_RETENTION_DAYS = [30, 90, 180, 365] as const;
export const QUERY_LOG_OUTCOMES = ['answered', 'no_results', 'error'] as const;
export const QUERY_LOG_REVIEW_STATUSES = ['to_review', 'reviewed', 'needs_addition'] as const;
export const QUERY_LOG_CHANNELS = [
    'agent_chat', 'agent_chat_sync', 'direct_chat', 'template_chat', 'notebook', 'webpage', 'project_assistant',
    'automation_ai_step', 'studio_kb_query', 'studio_ai_generate', 'studio_ai_extract', 'studio_ai_chat',
    'support', 'skill', 'kb_test', 'api_search',
] as const;

type QueryLogOutcome = typeof QUERY_LOG_OUTCOMES[number];
type QueryLogReviewStatus = typeof QUERY_LOG_REVIEW_STATUSES[number];

interface QueryLogChunk {
    chunkId?: string | number | null;
    documentId?: string | null;
    sourceUri?: string | null;
    title?: string | null;
    score?: number | null;
    page?: number | null;
    text?: string | null;
}

/** One entry as the route sends it (decrypted; `organizationId` already dropped). */
export interface QueryLogEntry {
    id: string;
    kbId: string;
    userId: string | null;
    userName?: string | null;
    channel: string;
    createdAt: string;
    query: string | null;
    chunks: QueryLogChunk[];
    chunkCount: number;
    topScore: number | null;
    retrievalMs: number | null;
    answer: string | null;
    citations: unknown;
    model: string | null;
    answerMs: number | null;
    outcome: QueryLogOutcome | string;
    errorCode: string | null;
    reviewStatus: QueryLogReviewStatus | string;
    reviewNote: string | null;
    reviewedBy: string | null;
    reviewedAt: string | null;
    decryptFailed?: boolean;
}

export interface QueryLogPage {
    rows: QueryLogEntry[];
    total: number;
    limit: number;
    offset: number;
}

export interface QueryLogFilters {
    from?: string;
    to?: string;
    userId?: string;
    channel?: string;
    outcome?: string;
    status?: string;
    q?: string;
}

export interface QueryLogSettings {
    enabled: boolean;
    retentionDays: number;
    changedAt: string | null;
    changedBy: string | null;
    deleted: number;
}

export interface QueryLogNotice {
    active: boolean;
    kbs: { id: string; name: string }[];
}

export const QUERY_LOG_PAGE_SIZE = 25;

const keys = {
    all: (kbId: string) => ['kbQueryLog', kbId] as const,
    list: (kbId: string, filters: QueryLogFilters, offset: number) => ['kbQueryLog', kbId, 'list', filters, offset] as const,
    notice: (ids: string[]) => ['kbQueryLog', 'notice', ids] as const,
};

const enc = encodeURIComponent;
const kbBase = (kbId: string) => `${API_BASE}/api/kb/${enc(kbId)}/query-log`;

/** `?a=1&b=2` of the filters that are set; never a bare `?`. */
function queryLogQuery(filters: QueryLogFilters, extra: Record<string, string | number> = {}): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...extra })) {
        if (v === undefined || v === null || v === '') continue;
        q.set(k, String(v));
    }
    const s = q.toString();
    return s ? `?${s}` : '';
}

export function useKbQueryLogList(kbId: string, filters: QueryLogFilters, offset: number, enabled = true) {
    return useQuery<QueryLogPage, Error>({
        queryKey: keys.list(kbId, filters, offset),
        enabled: enabled && !!kbId,
        queryFn: async ({ signal }) => {
            const res = await request(`${kbBase(kbId)}${queryLogQuery(filters, { limit: QUERY_LOG_PAGE_SIZE, offset })}`, { signal });
            return await res.json() as QueryLogPage;
        },
        placeholderData: keepPreviousData,
        staleTime: 0,
        retry: false,
    });
}

export interface QueryLogSettingsInput {
    enabled: boolean;
    retentionDays?: number;
    /** Only with `enabled: false`: delete what is there now instead of keeping it until the term ends. */
    deleteExisting?: boolean;
}

export function useSetKbQueryLogSettings(kbId: string) {
    const qc = useQueryClient();
    return useMutation<QueryLogSettings, Error, QueryLogSettingsInput>({
        mutationFn: async (input) => {
            // "Turn off and delete" has its own route: it is not licence-gated,
            // so a manager can still purge after the Enterprise licence lapsed.
            if (!input.enabled && input.deleteExisting) {
                const res = await request(kbBase(kbId), { method: 'DELETE' });
                return await res.json() as QueryLogSettings;
            }
            const res = await request(`${kbBase(kbId)}/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            return await res.json() as QueryLogSettings;
        },
        onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.all(kbId) }); },
    });
}

export interface QueryLogReviewInput {
    entryId: string;
    status: string;
    note: string | null;
}

export function useReviewKbQueryLogEntry(kbId: string) {
    const qc = useQueryClient();
    return useMutation<QueryLogEntry, Error, QueryLogReviewInput>({
        mutationFn: async ({ entryId, status, note }) => {
            const res = await request(`${kbBase(kbId)}/${enc(entryId)}/review`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, note }),
            });
            return await res.json() as QueryLogEntry;
        },
        onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.all(kbId) }); },
    });
}

/** Save the filtered log as a file through the browser's download. */
export async function downloadKbQueryLogCsv(kbId: string, filters: QueryLogFilters): Promise<void> {
    const res = await request(`${kbBase(kbId)}/export.csv${queryLogQuery(filters)}`);
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'knowledge-base-query-log.csv';
    link.click();
    // Chrome needs the object URL to outlive the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Which of these knowledge bases log, for the line under a chat input. An
 * unreadable answer is "nothing to announce": the line is a courtesy to the
 * reader, and the server logs by its own rules whatever this says.
 */
export function useKbQueryLogNotice(kbIds: readonly string[] | null | undefined) {
    const ids = [...new Set((kbIds ?? []).filter((id) => typeof id === 'string' && id))].sort();
    return useQuery<QueryLogNotice, Error>({
        queryKey: keys.notice(ids),
        enabled: ids.length > 0,
        queryFn: async ({ signal }) => {
            const res = await request(`${API_BASE}/api/kb/query-log/notice?kbIds=${enc(ids.join(','))}`, { signal });
            const body = await res.json() as Partial<QueryLogNotice> | null;
            const kbs = Array.isArray(body?.kbs) ? body.kbs.filter((k) => k && typeof k.name === 'string') : [];
            return { active: body?.active === true && kbs.length > 0, kbs };
        },
        staleTime: 60_000,
        retry: false,
    });
}
