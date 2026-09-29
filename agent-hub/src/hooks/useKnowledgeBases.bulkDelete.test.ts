import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useKnowledgeBases from './useKnowledgeBases';
import { toast } from '../components/shared/Toast';

const confirmMock = vi.fn(async () => true);
vi.mock('../components/shared/useConfirm', () => ({
    default: () => ({ confirm: confirmMock, confirmDialog: null }),
}));

const authFetchMock = vi.fn();
vi.mock('../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock('../components/admin/Studio/KnowledgeStudio/knowledgeApi', () => {
    const knowledgeApi = { listSources: vi.fn(async () => ({ sources: [], totals: {} })) };
    return { knowledgeApi, default: knowledgeApi };
});

vi.mock('../components/shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});

/**
 * POST /api/kb/:id/documents/bulk-delete refuses more than 200 ids with a 400
 * (was a silent 200-cap before 7e503ec2). bulkDeleteSelected sent the whole
 * selection in one request and never looked at the response — a refusal was
 * treated exactly like a success: selection cleared, list refreshed, nothing
 * shown. "Load more" keeps a selection alive across pages, so a selection
 * over 200 is not a hypothetical.
 */
describe('useKnowledgeBases — bulk delete batching', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        confirmMock.mockResolvedValue(true);
        authFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ([]) });
    });

    function idsOf(n: number) {
        return Array.from({ length: n }, (_, i) => `doc-${i}`);
    }

    it('sends a selection over 200 in batches of at most 200', async () => {
        const bulkCalls: string[][] = [];
        authFetchMock.mockImplementation(async (url: string, opts?: { body?: string }) => {
            if (String(url).includes('/documents/bulk-delete')) {
                const ids = JSON.parse(String(opts?.body)).documentIds;
                bulkCalls.push(ids);
                return { ok: true, status: 200, json: async () => ({ deleted: ids.length, errors: [] }) };
            }
            return { ok: true, status: 200, json: async () => ([]) };
        });
        const { result } = renderHook(() => useKnowledgeBases());
        act(() => { result.current.setSelectedKB({ id: 'kb1', name: 'Docs' }); });
        act(() => { result.current.setKbSelectedIds(new Set(idsOf(450))); });
        await act(async () => { await result.current.bulkDeleteSelected(); });
        expect(bulkCalls.map(b => b.length)).toEqual([200, 200, 50]);
        expect(result.current.kbSelectedIds.size).toBe(0);
    });

    it('does not clear the selection when a batch is refused, and says so', async () => {
        authFetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes('/documents/bulk-delete')) {
                return { ok: false, status: 400, json: async () => ({ error: 'At most 200 documents can be deleted at once' }) };
            }
            return { ok: true, status: 200, json: async () => ([]) };
        });
        const { result } = renderHook(() => useKnowledgeBases());
        act(() => { result.current.setSelectedKB({ id: 'kb1', name: 'Docs' }); });
        act(() => { result.current.setKbSelectedIds(new Set(idsOf(5))); });
        await act(async () => { await result.current.bulkDeleteSelected(); });
        expect(result.current.kbSelectedIds.size).toBe(5);
        expect(toast.error).toHaveBeenCalled();
    });

    it('keeps the ids of a later, never-attempted batch selected too', async () => {
        let call = 0;
        authFetchMock.mockImplementation(async (url: string, opts?: { body?: string }) => {
            if (String(url).includes('/documents/bulk-delete')) {
                call += 1;
                const ids = JSON.parse(String(opts?.body)).documentIds;
                if (call === 1) return { ok: true, status: 200, json: async () => ({ deleted: ids.length, errors: [] }) };
                return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
            }
            return { ok: true, status: 200, json: async () => ([]) };
        });
        const { result } = renderHook(() => useKnowledgeBases());
        act(() => { result.current.setSelectedKB({ id: 'kb1', name: 'Docs' }); });
        act(() => { result.current.setKbSelectedIds(new Set(idsOf(450))); });
        await act(async () => { await result.current.bulkDeleteSelected(); });
        // First batch of 200 succeeded and is gone from the selection; the
        // second (refused) and third (never attempted) batches — 250 ids —
        // stay selected.
        expect(result.current.kbSelectedIds.size).toBe(250);
    });
});
