import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useKnowledgeBases from './useKnowledgeBases';

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
 * POST /api/kb/:id/reindex answers `{ success, reindexed, failed, sources,
 * unattached, details }` — there is no `total`. The status line used to read
 * it anyway and printed "N/undefined". `unattached` matters on its own: those
 * documents were NOT re-embedded, so a line that reports only `reindexed`
 * claims a complete pass over a KB that still holds vectors from the old
 * model.
 */
describe('useKnowledgeBases — reindex status line', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        confirmMock.mockResolvedValue(true);
        authFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ([]) });
    });

    it('never reports "undefined" — the route sends no `total`', async () => {
        authFetchMock.mockImplementation(async (url) => {
            if (String(url).includes('/reindex')) {
                return {
                    ok: true, status: 200,
                    json: async () => ({ success: true, reindexed: 5, failed: 1, sources: 3, unattached: 0, details: [] }),
                };
            }
            return { ok: true, status: 200, json: async () => ([]) };
        });
        const { result } = renderHook(() => useKnowledgeBases());
        act(() => { result.current.setSelectedKB({ id: 'kb1', name: 'Docs' }); });
        await act(async () => { await result.current.reindexKB(); });
        expect(result.current.reindexStatus).not.toMatch(/undefined/);
        expect(result.current.reindexStatus).toContain('5');
    });

    it('mentions documents left unattached — they were not re-embedded', async () => {
        authFetchMock.mockImplementation(async (url) => {
            if (String(url).includes('/reindex')) {
                return {
                    ok: true, status: 200,
                    json: async () => ({ success: true, reindexed: 4, failed: 0, sources: 2, unattached: 3, details: [] }),
                };
            }
            return { ok: true, status: 200, json: async () => ([]) };
        });
        const { result } = renderHook(() => useKnowledgeBases());
        act(() => { result.current.setSelectedKB({ id: 'kb1', name: 'Docs' }); });
        await act(async () => { await result.current.reindexKB(); });
        expect(result.current.reindexStatus).toContain('3');
    });
});
