// The run receipts of a cowork (server/usecases/coworkReceipts.mts): one run's receipt, and the item's chain with its
// verdict. A receipt holds names and counts, never what a run read or wrote.

import { useQuery } from '@tanstack/react-query';
import { apiJson, apiUrl } from './typedRequest';
import { ApiError } from './client';

export interface ReceiptLine { seq: number; runId: string; at: string | null; status: unknown; kind: unknown; signed: boolean; payload: Record<string, unknown> }
interface ChainVerdict { ok: boolean; count: number; problem: { seq: number; kind: 'gap' | 'link' | 'content' | 'signature' } | null; unsigned: number }
export interface ReceiptsView { verdict: ChainVerdict; missingRuns: number; keyId: string | null; receipts: ReceiptLine[] }

/** One run's receipt; null while it has none yet (the server answers 404). */
export function useRunReceipt(coworkId: string, runId: string, enabled: boolean) {
    return useQuery<ReceiptLine | null, Error>({
        queryKey: ['cowork', 'receipt', coworkId, runId],
        enabled,
        queryFn: async () => {
            try {
                return await apiJson<'GET /api/cowork/{id}/runs/{runId}/receipt', ReceiptLine>('GET /api/cowork/{id}/runs/{runId}/receipt', { params: { id: coworkId, runId } });
            } catch (e) {
                if (e instanceof ApiError && e.status === 404) return null;
                throw e;
            }
        },
        retry: false,
        staleTime: 60_000,
    });
}

/** The item's chain and whether it holds. */
export function useReceipts(coworkId: string) {
    return useQuery<ReceiptsView, Error>({
        queryKey: ['cowork', 'receipts', coworkId],
        queryFn: () => apiJson<'GET /api/cowork/{id}/receipts', ReceiptsView>('GET /api/cowork/{id}/receipts', { params: { id: coworkId } }),
        retry: false,
    });
}

/** Where the whole chain downloads as JSON. */
export const receiptsUrl = (coworkId: string): string => apiUrl('GET /api/cowork/{id}/receipts', { params: { id: coworkId } });
